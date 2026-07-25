import { appendFileSync } from 'node:fs';
import {
  type Finding,
  type GateResult,
  type ReviewResult,
  type Severity,
  countBySeverity,
} from '@/core/types';

/**
 * Terminal and CI output.
 *
 * Colour is disabled when stdout is not a TTY, when `NO_COLOR` is set, or when
 * `CI` is set without `FORCE_COLOR` — otherwise escape codes end up as literal
 * garbage in GitHub Actions logs.
 */

const useColor =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== undefined || (process.stdout.isTTY ?? false));

function color(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  bold: (text: string) => color('1', text),
  dim: (text: string) => color('2', text),
  red: (text: string) => color('31', text),
  green: (text: string) => color('32', text),
  yellow: (text: string) => color('33', text),
  blue: (text: string) => color('34', text),
  cyan: (text: string) => color('36', text),
  grey: (text: string) => color('90', text),
};

const SEVERITY_STYLE: Record<Severity, (text: string) => string> = {
  critical: style.red,
  high: style.red,
  medium: style.yellow,
  low: style.cyan,
  info: style.blue,
};

const SEVERITY_MARK: Record<Severity, string> = {
  critical: '✖',
  high: '✖',
  medium: '▲',
  low: '•',
  info: '·',
};

export function heading(text: string): void {
  console.log(`\n${style.bold(text)}`);
  console.log(style.grey('─'.repeat(Math.min(text.length + 8, 72))));
}

export function renderFinding(finding: Finding, index: number): void {
  const paint = SEVERITY_STYLE[finding.severity];
  const location = finding.location
    ? style.grey(
        ` ${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ''}`,
      )
    : '';

  console.log(
    `${style.grey(String(index).padStart(3))} ${paint(SEVERITY_MARK[finding.severity])} ${paint(
      finding.severity.padEnd(8),
    )} ${finding.title}${location}`,
  );

  // First non-empty paragraph only — the full description belongs in the PR
  // comment, not scrolling past in a terminal.
  const summary = finding.description
    .split('\n')
    .find((line) => line.trim().length > 0 && !line.startsWith('```'));

  if (summary) {
    console.log(`      ${style.grey(summary.slice(0, 150))}`);
  }

  if (finding.suggestion) {
    console.log(`      ${style.green('→')} ${style.dim(finding.suggestion.description)}`);
  }

  console.log(`      ${style.grey(`${finding.rule} · ${Math.round(finding.confidence * 100)}%`)}`);
}

export function renderGates(gates: readonly GateResult[]): void {
  heading('Quality gates');

  for (const gate of gates) {
    const mark =
      gate.status === 'passed'
        ? style.green('✓')
        : gate.status === 'warning'
          ? style.yellow('▲')
          : gate.status === 'failed'
            ? style.red('✖')
            : style.grey('–');

    const observed =
      gate.observed !== undefined && gate.threshold !== undefined
        ? style.grey(` (${gate.observed}/${gate.threshold})`)
        : '';

    console.log(`  ${mark} ${gate.name.padEnd(20)} ${style.grey(gate.message)}${observed}`);
  }
}

export function renderReview(result: ReviewResult): void {
  const counts = countBySeverity(result.findings);

  heading(`Review · ${result.repository.fullName}#${result.pullRequest.number}`);

  console.log(`  ${style.bold(result.summary.headline)}`);
  console.log();
  console.log(
    `  Score ${style.bold(`${result.summary.score}/100`)}   Verdict ${style.bold(result.summary.verdict)}   Engine ${style.grey(result.engine)}`,
  );

  const badge = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => SEVERITY_STYLE[severity](`${counts[severity]} ${severity}`))
    .join('  ');

  console.log(`  ${badge || style.green('No issues found')}`);
  console.log(
    style.grey(
      `  ${result.metrics.filesAnalyzed} files · +${result.metrics.linesAdded}/−${result.metrics.linesRemoved} · ${(result.metrics.durationMs / 1000).toFixed(1)}s`,
    ),
  );

  renderGates(result.gates);

  if (result.findings.length > 0) {
    heading(`Findings (${result.findings.length})`);
    result.findings.forEach((finding, index) => renderFinding(finding, index + 1));
  }

  if (result.commendations.length > 0) {
    heading('What went well');
    for (const commendation of result.commendations) {
      console.log(`  ${style.green('✓')} ${style.bold(commendation.title)}`);
      console.log(`    ${style.grey(commendation.description)}`);
    }
  }
}

/**
 * Writes GitHub Actions workflow commands and the step summary.
 *
 * Annotations put findings on the diff in the Files Changed tab, which is
 * where reviewers already are — far more useful than a log line they have to
 * go looking for.
 */
export function emitGitHubAnnotations(result: ReviewResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  for (const finding of result.findings) {
    const level =
      finding.severity === 'critical' || finding.severity === 'high'
        ? 'error'
        : finding.severity === 'medium'
          ? 'warning'
          : 'notice';

    const params = [
      finding.location?.path ? `file=${finding.location.path}` : null,
      finding.location?.line ? `line=${finding.location.line}` : null,
      `title=${finding.title.replace(/[\n\r]/g, ' ')}`,
    ]
      .filter(Boolean)
      .join(',');

    // Workflow commands are newline-delimited, so the message must be escaped.
    const message = finding.description
      .split('\n')
      .filter((line) => !line.startsWith('```'))
      .join(' ')
      .slice(0, 400)
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');

    console.log(`::${level} ${params}::${message}`);
  }
}

export function writeStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${markdown}\n`, 'utf8');
  } catch {
    // A missing summary file is not worth failing a build over.
  }
}

/** Sets a GitHub Actions output variable. */
export function setOutput(name: string, value: string | number | boolean): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  try {
    // The heredoc form is required for values that may contain newlines.
    const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
    appendFileSync(path, `${name}<<${delimiter}\n${String(value)}\n${delimiter}\n`, 'utf8');
  } catch {
    // Non-fatal.
  }
}

export function renderJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
