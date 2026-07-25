import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '@/core/types';
import { defaultConfig } from '@/features/config';
import {
  EmailChannel,
  GenericWebhookChannel,
  type NotificationChannel,
  type NotificationPayload,
  SlackChannel,
  TeamsChannel,
  dispatch,
  reviewNotification,
} from '@/features/notifications';
import { pullRequest, repository } from '../fixtures';

const notificationsConfig = defaultConfig().notifications;

function payloadOf(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    event: 'review.completed',
    title: 'Review complete',
    summary: 'A summary of the change.',
    severity: 'high',
    repository: 'acme/widgets',
    url: 'https://github.com/acme/widgets/pull/42',
    facts: [{ label: 'Score', value: '61/100' }],
    ...overrides,
  };
}

/** A channel that records what it was asked to send. */
function recordingChannel(name: string, configured = true) {
  const sent: NotificationPayload[] = [];
  const channel: NotificationChannel = {
    name,
    isConfigured: () => configured,
    send: async (payload) => {
      sent.push(payload);
    },
  };
  return { channel, sent };
}

describe('channel rendering', () => {
  it('renders Slack Block Kit with a link action', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await new SlackChannel('https://hooks.slack.test/abc').send(payloadOf());

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.test/abc');

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.blocks[0].type).toBe('header');
    expect(body.text).toContain('Review complete');
    expect(JSON.stringify(body)).toContain('https://github.com/acme/widgets/pull/42');
  });

  it('renders a Teams MessageCard with severity colour and facts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await new TeamsChannel('https://outlook.test/webhook').send(
      payloadOf({ severity: 'critical' }),
    );

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['@type']).toBe('MessageCard');
    expect(body.themeColor).toBe('dc2626');
    expect(body.sections[0].facts).toEqual([{ name: 'Score', value: '61/100' }]);
  });

  it('posts the payload verbatim to a generic webhook', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await new GenericWebhookChannel('https://example.test/hook').send(payloadOf());

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.source).toBe('autodev-ci');
    expect(body.event).toBe('review.completed');
    expect(body.facts).toHaveLength(1);
  });

  it('surfaces a non-2xx webhook response as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(
      new SlackChannel('https://hooks.slack.test/abc').send(payloadOf()),
    ).rejects.toThrow(/Webhook responded 500/);
  });

  it('reports itself unconfigured when no URL is set', () => {
    expect(new SlackChannel(undefined).isConfigured()).toBe(false);
    expect(new TeamsChannel(undefined).isConfigured()).toBe(false);
    expect(new GenericWebhookChannel(undefined).isConfigured()).toBe(false);
  });

  it('renders email to both HTML and plain text', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const channel = new EmailChannel(transport, ['dev@example.test'], 'bot@example.test');

    expect(channel.isConfigured()).toBe(true);
    await channel.send(payloadOf());

    const message = transport.mock.calls[0]![0];
    expect(message.to).toBe('dev@example.test');
    expect(message.from).toBe('bot@example.test');
    expect(message.html).toContain('Review complete');
    expect(message.text).toContain('Score: 61/100');
  });

  it('is unconfigured without a transport or recipients', () => {
    expect(new EmailChannel(undefined, ['a@b.test']).isConfigured()).toBe(false);
    expect(new EmailChannel(vi.fn(), []).isConfigured()).toBe(false);
  });
});

describe('dispatch', () => {
  it('sends only to enabled, configured channels', async () => {
    const slack = recordingChannel('slack');
    const teams = recordingChannel('teams');
    const unconfigured = recordingChannel('webhook', false);

    await dispatch(payloadOf(), {
      config: { ...notificationsConfig, slack: true, teams: false },
      channels: [slack.channel, teams.channel, unconfigured.channel],
    });

    expect(slack.sent).toHaveLength(1);
    expect(teams.sent).toHaveLength(0);
    expect(unconfigured.sent).toHaveLength(0);
  });

  it('drops notifications below the configured severity floor', async () => {
    const slack = recordingChannel('slack');

    const results = await dispatch(payloadOf({ severity: 'low' }), {
      config: { ...notificationsConfig, slack: true, minSeverity: 'high' },
      channels: [slack.channel],
    });

    expect(results).toEqual([]);
    expect(slack.sent).toHaveLength(0);
  });

  it('never throws when a channel fails, and reports the failure', async () => {
    const failing: NotificationChannel = {
      name: 'slack',
      isConfigured: () => true,
      send: vi.fn().mockRejectedValue(new Error('slack is down')),
    };
    const working = recordingChannel('teams');

    // A Slack outage must not fail the review that triggered the notification.
    const results = await dispatch(payloadOf(), {
      config: { ...notificationsConfig, slack: true, teams: true },
      channels: [failing, working.channel],
    });

    const slackResult = results.find((result) => result.channel === 'slack');
    expect(slackResult?.delivered).toBe(false);
    expect(slackResult?.error).toContain('slack is down');

    expect(results.find((result) => result.channel === 'teams')?.delivered).toBe(true);
    expect(working.sent).toHaveLength(1);
  });

  it('reports every attempt through onResult', async () => {
    const seen: string[] = [];
    const slack = recordingChannel('slack');

    await dispatch(payloadOf(), {
      config: { ...notificationsConfig, slack: true },
      channels: [slack.channel],
      onResult: (result) => {
        seen.push(`${result.channel}:${result.delivered}`);
      },
    });

    expect(seen).toEqual(['slack:true']);
  });
});

describe('reviewNotification', () => {
  function reviewOf(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      id: 'r1',
      repository,
      pullRequest,
      summary: {
        verdict: 'comment',
        score: 82,
        headline: 'A moderate change with no blocking issues.',
        highlights: [],
        concerns: [],
      },
      findings: [],
      commendations: [],
      metrics: {
        filesAnalyzed: 4,
        linesAdded: 40,
        linesRemoved: 5,
        testFilesChanged: 1,
        docFilesChanged: 0,
        durationMs: 120,
      },
      gates: [],
      engine: 'static',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('reports a clean review at info severity', () => {
    const payload = reviewNotification(reviewOf());
    expect(payload.event).toBe('review.completed');
    expect(payload.severity).toBe('info');
    expect(payload.facts.some((fact) => fact.label === 'Score')).toBe(true);
  });

  it('escalates when a blocking gate failed', () => {
    const payload = reviewNotification(
      reviewOf({
        gates: [
          {
            id: 'security',
            name: 'Security scan',
            status: 'failed',
            message: '1 critical finding',
            blocking: true,
          },
        ],
      }),
    );

    expect(payload.event).toBe('gate.failed');
    expect(payload.severity).toBe('high');
    expect(payload.title).toContain('Quality gate failed');
  });

  it('reports critical severity when a critical finding is present', () => {
    const payload = reviewNotification(
      reviewOf({
        findings: [
          {
            id: 'f1',
            rule: 'security/x',
            category: 'security',
            severity: 'critical',
            title: 'Secret',
            description: '',
            source: 'static',
            confidence: 1,
          },
        ],
      }),
    );

    expect(payload.severity).toBe('critical');
    expect(payload.facts.find((fact) => fact.label === 'Findings')?.value).toContain('1 critical');
  });
});
