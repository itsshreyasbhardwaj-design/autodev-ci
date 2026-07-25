import { retry, withTimeout } from '@/core/async';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { type ReviewResult, SEVERITY_RANK, type Severity, countBySeverity } from '@/core/types';
import type { NotificationsConfig } from '@/features/config';

/**
 * Notification dispatch.
 *
 * Every channel implements the same small {@link NotificationChannel}
 * interface, so adding PagerDuty or a custom endpoint is one file and no
 * changes anywhere else. Delivery is best-effort and isolated: a channel
 * failing is logged and recorded but never propagates, because a Slack outage
 * must not fail a code review.
 */

export type NotificationEvent =
  | 'review.completed'
  | 'review.failed'
  | 'gate.failed'
  | 'security.critical'
  | 'health.degraded'
  | 'release.published';

export interface NotificationPayload {
  readonly event: NotificationEvent;
  readonly title: string;
  readonly summary: string;
  readonly severity: Severity;
  readonly url?: string;
  readonly repository: string;
  readonly facts: ReadonlyArray<{ label: string; value: string }>;
}

export interface DeliveryResult {
  readonly channel: string;
  readonly delivered: boolean;
  readonly error?: string;
  readonly target?: string;
}

export interface NotificationChannel {
  readonly name: string;
  /** False when the channel is not configured; dispatch skips it. */
  isConfigured(): boolean;
  send(payload: NotificationPayload): Promise<void>;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#0891b2',
  info: '#6366f1',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '🔵',
};

async function postJson(url: string, body: unknown, timeoutMs = 10_000): Promise<void> {
  const response = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    'Webhook delivery',
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Webhook responded ${response.status}: ${text.slice(0, 200)}`);
  }
}

/** Slack incoming webhook, rendered with Block Kit. */
export class SlackChannel implements NotificationChannel {
  readonly name = 'slack';

  constructor(private readonly webhookUrl = env().SLACK_WEBHOOK_URL) {}

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) throw new Error('Slack webhook URL is not configured');

    await postJson(this.webhookUrl, {
      text: `${SEVERITY_EMOJI[payload.severity]} ${payload.title}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${SEVERITY_EMOJI[payload.severity]} ${payload.title}`.slice(0, 150),
          },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: payload.summary.slice(0, 3000) },
        },
        ...(payload.facts.length > 0
          ? [
              {
                type: 'section',
                fields: payload.facts.slice(0, 10).map((fact) => ({
                  type: 'mrkdwn',
                  text: `*${fact.label}*\n${fact.value}`,
                })),
              },
            ]
          : []),
        ...(payload.url
          ? [
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View on GitHub' },
                    url: payload.url,
                  },
                ],
              },
            ]
          : []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `AutoDev CI · ${payload.repository}` }],
        },
      ],
    });
  }
}

/** Microsoft Teams incoming webhook, rendered as a MessageCard. */
export class TeamsChannel implements NotificationChannel {
  readonly name = 'teams';

  constructor(private readonly webhookUrl = env().TEAMS_WEBHOOK_URL) {}

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) throw new Error('Teams webhook URL is not configured');

    await postJson(this.webhookUrl, {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: SEVERITY_COLOR[payload.severity].replace('#', ''),
      summary: payload.title,
      title: payload.title,
      text: payload.summary,
      sections: [
        {
          activityTitle: payload.repository,
          facts: payload.facts.map((fact) => ({ name: fact.label, value: fact.value })),
          markdown: true,
        },
      ],
      ...(payload.url
        ? {
            potentialAction: [
              {
                '@type': 'OpenUri',
                name: 'View on GitHub',
                targets: [{ os: 'default', uri: payload.url }],
              },
            ],
          }
        : {}),
    });
  }
}

/**
 * Generic webhook.
 *
 * Posts the payload verbatim so teams can wire AutoDev CI into whatever they
 * already run — PagerDuty, Discord via a shim, an internal bus — without
 * waiting for a first-class integration.
 */
export class GenericWebhookChannel implements NotificationChannel {
  readonly name = 'webhook';

  constructor(private readonly webhookUrl = env().GENERIC_WEBHOOK_URL) {}

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) throw new Error('Generic webhook URL is not configured');
    await postJson(this.webhookUrl, {
      source: 'autodev-ci',
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }
}

/**
 * Email channel.
 *
 * Renders the message and hands it to an injected transport. No SMTP client is
 * bundled: mail libraries are heavy, do not run on edge runtimes, and every
 * team already has a provider. Supplying a transport is a few lines.
 */
export type EmailTransport = (message: {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<void>;

export class EmailChannel implements NotificationChannel {
  readonly name = 'email';

  constructor(
    private readonly transport: EmailTransport | undefined,
    private readonly recipients: readonly string[] = [],
    private readonly from = env().EMAIL_FROM ?? 'autodev@localhost',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.transport) && this.recipients.length > 0;
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (!this.transport) throw new Error('No email transport configured');

    const factRows = payload.facts
      .map(
        (fact) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${fact.label}</td><td style="padding:4px 0"><strong>${fact.value}</strong></td></tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px">
        <div style="border-left:4px solid ${SEVERITY_COLOR[payload.severity]};padding-left:16px">
          <h2 style="margin:0 0 8px">${payload.title}</h2>
          <p style="color:#475569;margin:0 0 16px">${payload.summary}</p>
        </div>
        <table style="border-collapse:collapse;font-size:14px">${factRows}</table>
        ${payload.url ? `<p style="margin-top:20px"><a href="${payload.url}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">View on GitHub</a></p>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">AutoDev CI · ${payload.repository}</p>
      </div>`.trim();

    const text = [
      payload.title,
      '',
      payload.summary,
      '',
      ...payload.facts.map((fact) => `${fact.label}: ${fact.value}`),
      ...(payload.url ? ['', payload.url] : []),
    ].join('\n');

    await Promise.all(
      this.recipients.map((to) =>
        this.transport!({ to, from: this.from, subject: payload.title, html, text }),
      ),
    );
  }
}

export interface DispatchOptions {
  readonly config: NotificationsConfig;
  readonly channels?: readonly NotificationChannel[];
  /** Records each attempt; wired to the data store by the caller. */
  readonly onResult?: (result: DeliveryResult) => void | Promise<void>;
}

/** The channels available from the current environment. */
export function defaultChannels(): NotificationChannel[] {
  return [new SlackChannel(), new TeamsChannel(), new GenericWebhookChannel()];
}

/**
 * Sends a notification to every enabled, configured channel.
 *
 * Never throws. Each channel gets two attempts with backoff, and the outcome
 * is reported through `onResult` so failures are visible in the dashboard
 * rather than only in logs.
 */
export async function dispatch(
  payload: NotificationPayload,
  options: DispatchOptions,
): Promise<DeliveryResult[]> {
  const { config } = options;

  if (SEVERITY_RANK[payload.severity] < SEVERITY_RANK[config.minSeverity]) {
    return [];
  }

  const enabled = new Set<string>();
  if (config.slack) enabled.add('slack');
  if (config.teams) enabled.add('teams');
  if (config.email) enabled.add('email');
  // The generic webhook is opt-in purely by being configured.
  enabled.add('webhook');

  const channels = (options.channels ?? defaultChannels()).filter(
    (channel) => enabled.has(channel.name) && channel.isConfigured(),
  );

  if (channels.length === 0) return [];

  const log = logger().child({ component: 'notifications', event: payload.event });

  const results = await Promise.all(
    channels.map(async (channel): Promise<DeliveryResult> => {
      try {
        await retry(() => channel.send(payload), {
          attempts: 2,
          baseDelayMs: 400,
          onRetry: (_error, attempt) =>
            log.warn('Retrying notification', { channel: channel.name, attempt }),
        });
        log.info('Notification delivered', { channel: channel.name });
        return { channel: channel.name, delivered: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Notification failed', { channel: channel.name, error: message });
        return { channel: channel.name, delivered: false, error: message };
      }
    }),
  );

  if (options.onResult) {
    // `onResult` may return void, so this is a sequential await rather than a
    // Promise.all over possibly-non-thenable values.
    for (const result of results) {
      await options.onResult(result);
    }
  }

  return results;
}

/** Builds the notification payload for a completed review. */
export function reviewNotification(result: ReviewResult): NotificationPayload {
  const counts = countBySeverity(result.findings);
  const blocked = result.gates.some((gate) => gate.status === 'failed' && gate.blocking);

  const severity: Severity =
    counts.critical > 0 ? 'critical' : counts.high > 0 ? 'high' : blocked ? 'high' : 'info';

  return {
    event: blocked ? 'gate.failed' : 'review.completed',
    title: `${blocked ? 'Quality gate failed' : 'Review complete'}: ${result.repository.fullName}#${result.pullRequest.number}`,
    summary: result.summary.headline,
    severity,
    ...(result.pullRequest.url ? { url: result.pullRequest.url } : {}),
    repository: result.repository.fullName,
    facts: [
      {
        label: 'Pull request',
        value: `#${result.pullRequest.number} — ${result.pullRequest.title}`,
      },
      { label: 'Author', value: result.pullRequest.author },
      { label: 'Score', value: `${result.summary.score}/100` },
      { label: 'Verdict', value: result.summary.verdict },
      {
        label: 'Findings',
        value:
          result.findings.length === 0
            ? 'none'
            : `${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`,
      },
      { label: 'Files analyzed', value: String(result.metrics.filesAnalyzed) },
    ],
  };
}
