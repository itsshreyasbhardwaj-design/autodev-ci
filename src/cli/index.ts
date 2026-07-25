import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorMessage } from '@/core/errors';
import { SEVERITY_RANK, type Severity, countBySeverity } from '@/core/types';
import { closeStore } from '@/db';
import { prependToChangelog } from '@/features/changelog';
import { renderReviewComment } from '@/features/github/publish';
import { runHealthCheck } from '@/server/services/health-service';
import { runChangelog, runRelease } from '@/server/services/release-service';
import { runReview } from '@/server/services/review-service';
import {
  emitGitHubAnnotations,
  heading,
  renderJson,
  renderReview,
  setOutput,
  style,
  writeStepSummary,
} from './output';

/**
 * The `autodev` CLI.
 *
 * Backs the GitHub Action and local use. Argument parsing is hand-rolled
 * rather than pulled from a library: the surface is six commands with simple
 * flags, and a zero-dependency CLI bundles to a single file the Action can run
 * without an install step in the consumer's repository.
 */

const VERSION = '0.1.0';

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // A leading flag (`autodev --version`) means no command was given; the token
  // is a flag, not a command name, so it must stay in the list to be parsed.
  const leadsWithFlag = (argv[0] ?? '').startsWith('-');
  const command = leadsWithFlag ? 'help' : (argv[0] ?? 'help');
  const rest = leadsWithFlag ? argv : argv.slice(1);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';

    if (token.startsWith('--')) {
      const [name, inlineValue] = token.slice(2).split('=', 2);
      if (!name) continue;

      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }

      const next = rest[index + 1];
      // A flag followed by a non-flag token takes it as its value; otherwise
      // it is boolean. This is what lets `--json` and `--repo x` coexist.
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
    } else if (token.startsWith('-') && token.length === 2) {
      flags[token.slice(1)] = true;
    } else {
      positional.push(token);
    }
  }

  return { command, positional, flags };
}

function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

/**
 * Resolves owner/repo from flags, then `--repo owner/name`, then the
 * `GITHUB_REPOSITORY` variable the Actions runner always sets.
 */
function resolveRepo(flags: ParsedArgs['flags']): { owner: string; repo: string } {
  const explicit = flagString(flags, 'repo') ?? process.env.GITHUB_REPOSITORY;

  const owner = flagString(flags, 'owner');
  const repo = flagString(flags, 'name');
  if (owner && repo) return { owner, repo };

  if (!explicit || !explicit.includes('/')) {
    throw new Error('Specify the repository with --repo owner/name');
  }

  const [parsedOwner, parsedName] = explicit.split('/', 2);
  if (!parsedOwner || !parsedName) {
    throw new Error(`Could not parse "${explicit}" as owner/name`);
  }

  return { owner: parsedOwner, repo: parsedName };
}

/**
 * Resolves the pull request number from a flag, or from the Actions event
 * payload, which is the only place it exists during a `pull_request` run.
 */
function resolvePullNumber(flags: ParsedArgs['flags']): number {
  const explicit = flagString(flags, 'pr') ?? flagString(flags, 'pull-request');
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`"${explicit}" is not a valid pull request number`);
    }
    return parsed;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const number = event.pull_request?.number ?? event.number;
      if (typeof number === 'number') return number;
    } catch {
      // Fall through to the error below.
    }
  }

  throw new Error(
    'Specify the pull request with --pr <number>, or run inside a pull_request workflow',
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandReview(args: ParsedArgs): Promise<number> {
  const { owner, repo } = resolveRepo(args.flags);
  const pullNumber = resolvePullNumber(args.flags);

  const dryRun = flagBool(args.flags, 'dry-run');
  const json = flagBool(args.flags, 'json');
  const failOn = (flagString(args.flags, 'fail-on') ?? 'critical') as Severity | 'never';

  const outcome = await runReview({
    owner,
    repo,
    pullNumber,
    publish: !dryRun && !flagBool(args.flags, 'no-comment'),
    notify: !dryRun,
    persist: !dryRun,
  });

  const { review } = outcome;

  if (json) {
    renderJson(review);
  } else {
    renderReview(review);
    if (outcome.commentUrl) {
      console.log(`\n${style.grey(`Posted: ${outcome.commentUrl}`)}`);
    }
  }

  emitGitHubAnnotations(review);
  writeStepSummary(renderReviewComment(review));

  const counts = countBySeverity(review.findings);
  setOutput('score', review.summary.score);
  setOutput('verdict', review.summary.verdict);
  setOutput('findings', review.findings.length);
  setOutput('critical', counts.critical);
  setOutput('high', counts.high);

  const outputPath = flagString(args.flags, 'output');
  if (outputPath) {
    writeFileSync(resolve(outputPath), JSON.stringify(review, null, 2), 'utf8');
    console.log(style.grey(`\nWrote ${outputPath}`));
  }

  // Exit code drives the CI decision. `--fail-on never` reports without
  // blocking, which is how teams roll this out before trusting it.
  if (failOn === 'never') return 0;

  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.critical;
  const blocking = review.findings.filter(
    (finding) => finding.source === 'static' && SEVERITY_RANK[finding.severity] >= threshold,
  );

  const gateFailed = review.gates.some((gate) => gate.status === 'failed' && gate.blocking);

  if (blocking.length > 0 || gateFailed) {
    console.log(
      `\n${style.red('✖')} ${style.bold('Failed')}: ${blocking.length} finding(s) at or above "${failOn}"${
        gateFailed ? ', and a blocking quality gate failed' : ''
      }.`,
    );
    return 1;
  }

  console.log(`\n${style.green('✓')} ${style.bold('Passed')}: no blocking issues.`);
  return 0;
}

async function commandChangelog(args: ParsedArgs): Promise<number> {
  const { owner, repo } = resolveRepo(args.flags);

  const result = await runChangelog({
    owner,
    repo,
    ...(flagString(args.flags, 'from') ? { from: flagString(args.flags, 'from')! } : {}),
    ...(flagString(args.flags, 'to') ? { to: flagString(args.flags, 'to')! } : {}),
    ...(flagString(args.flags, 'version') ? { version: flagString(args.flags, 'version')! } : {}),
    persist: !flagBool(args.flags, 'dry-run'),
  });

  if (flagBool(args.flags, 'json')) {
    renderJson(result);
    return 0;
  }

  console.log(result.markdown);

  const writePath = flagString(args.flags, 'write');
  if (writePath) {
    const target = resolve(writePath);
    let existing: string | null = null;
    try {
      existing = readFileSync(target, 'utf8');
    } catch {
      existing = null;
    }
    writeFileSync(target, prependToChangelog(existing, result.markdown, result.version), 'utf8');
    console.log(style.grey(`Updated ${writePath}`));
  }

  setOutput('version', result.version);
  setOutput('release-kind', result.releaseKind);
  return 0;
}

async function commandRelease(args: ParsedArgs): Promise<number> {
  const { owner, repo } = resolveRepo(args.flags);

  const plan = await runRelease({
    owner,
    repo,
    ...(flagString(args.flags, 'from') ? { from: flagString(args.flags, 'from')! } : {}),
    ...(flagString(args.flags, 'to') ? { to: flagString(args.flags, 'to')! } : {}),
    ...(flagString(args.flags, 'version') ? { version: flagString(args.flags, 'version')! } : {}),
    persist: !flagBool(args.flags, 'dry-run'),
  });

  if (flagBool(args.flags, 'json')) {
    renderJson(plan);
    return 0;
  }

  console.log(plan.releaseNotes);
  console.log('\n---\n');
  console.log(plan.upgradeGuide);

  if (plan.hasBreakingChanges) {
    console.log('\n---\n');
    console.log(plan.migrationGuide);
  }

  console.log('\n---\n');
  console.log(plan.deploymentChecklist);

  setOutput('version', plan.version);
  setOutput('breaking', plan.hasBreakingChanges);
  return 0;
}

async function commandHealth(args: ParsedArgs): Promise<number> {
  const { owner, repo } = resolveRepo(args.flags);

  const outcome = await runHealthCheck({
    owner,
    repo,
    persist: !flagBool(args.flags, 'dry-run'),
  });

  if (flagBool(args.flags, 'json')) {
    renderJson(outcome.report);
    return 0;
  }

  const { report } = outcome;

  heading(`Health · ${report.repository.fullName}`);
  console.log(
    `  ${style.bold(`${report.score}/100`)}  grade ${style.bold(report.grade)}${
      outcome.trend.direction !== 'flat'
        ? `  ${outcome.trend.direction === 'up' ? style.green('▲') : style.red('▼')} ${Math.abs(outcome.trend.delta)}`
        : ''
    }`,
  );

  heading('Dimensions');
  for (const dimension of report.dimensions) {
    const filled = Math.round(dimension.score / 5);
    const bar = '█'.repeat(filled) + style.grey('░'.repeat(20 - filled));
    const paint =
      dimension.score >= 80 ? style.green : dimension.score >= 55 ? style.yellow : style.red;

    console.log(
      `  ${dimension.label.padEnd(22)} ${bar} ${paint(String(dimension.score).padStart(3))}  ${style.grey(`×${dimension.weight.toFixed(2)}`)}`,
    );
    console.log(`  ${' '.repeat(22)} ${style.grey(dimension.detail)}`);
  }

  heading('Recommendations');
  report.recommendations.forEach((recommendation, index) => {
    console.log(`  ${style.grey(String(index + 1).padStart(2))}. ${recommendation}`);
  });

  setOutput('score', report.score);
  setOutput('grade', report.grade);

  const minScore = Number(flagString(args.flags, 'min-score') ?? 0);
  if (minScore > 0 && report.score < minScore) {
    console.log(
      `\n${style.red('✖')} Health score ${report.score} is below the required ${minScore}.`,
    );
    return 1;
  }

  return 0;
}

async function commandDocs(args: ParsedArgs): Promise<number> {
  const { owner, repo } = resolveRepo(args.flags);
  const pullNumber = resolvePullNumber(args.flags);

  // Documentation drift is part of the review pipeline, so this runs a review
  // and reports only its documentation findings.
  const outcome = await runReview({
    owner,
    repo,
    pullNumber,
    publish: false,
    notify: false,
    persist: false,
  });

  const docFindings = outcome.review.findings.filter(
    (finding) => finding.category === 'documentation',
  );

  if (flagBool(args.flags, 'json')) {
    renderJson({ findings: docFindings, driftDetected: docFindings.length > 0 });
    return 0;
  }

  heading(`Documentation · ${owner}/${repo}#${pullNumber}`);

  if (docFindings.length === 0) {
    console.log(`  ${style.green('✓')} No documentation drift detected.`);
    return 0;
  }

  for (const finding of docFindings) {
    console.log(`  ${style.yellow('▲')} ${style.bold(finding.title)}`);
    for (const line of finding.description.split('\n').filter(Boolean).slice(0, 8)) {
      console.log(`    ${style.grey(line)}`);
    }
    console.log();
  }

  setOutput('drift', docFindings.length);
  return flagBool(args.flags, 'fail-on-drift') ? 1 : 0;
}

function commandHelp(): number {
  console.log(`
${style.bold('autodev')} ${style.grey(`v${VERSION}`)} — AI-powered GitHub automation

${style.bold('USAGE')}
  autodev <command> [options]

${style.bold('COMMANDS')}
  review        Analyse a pull request and post the review
  changelog     Generate a changelog from Conventional Commits
  release       Build the full release package (notes, guides, checklist)
  health        Score repository health across seven dimensions
  docs          Report documentation drift for a pull request
  help          Show this message

${style.bold('COMMON OPTIONS')}
  --repo <owner/name>    Repository. Defaults to $GITHUB_REPOSITORY.
  --json                 Emit JSON instead of formatted output.
  --dry-run              Analyse without posting, persisting or notifying.

${style.bold('review')}
  --pr <number>          Pull request number. Read from the event payload in CI.
  --fail-on <severity>   Exit 1 at or above this severity. Use "never" to
                         always exit 0. Default: critical.
  --no-comment           Analyse without posting to GitHub.
  --output <path>        Write the full result as JSON.

${style.bold('changelog')}
  --from <ref>           Starting ref. Defaults to the newest semver tag.
  --to <ref>             Ending ref. Defaults to the default branch.
  --version <version>    Explicit version. Otherwise inferred from commits.
  --write <path>         Prepend the entry to a CHANGELOG file.

${style.bold('health')}
  --min-score <number>   Exit 1 if the score falls below this.

${style.bold('docs')}
  --pr <number>          Pull request number.
  --fail-on-drift        Exit 1 when drift is detected.

${style.bold('ENVIRONMENT')}
  GITHUB_TOKEN           Required for any command that reads from GitHub.
  AUTODEV_AI_PROVIDER    "deterministic" (default) or "openrouter".
  OPENROUTER_API_KEY     Required when the provider is "openrouter".

${style.grey('Docs: https://github.com/itsshreyasbhardwaj-design/autodev-ci')}
`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (flagBool(args.flags, 'version') || args.command === 'version') {
    console.log(VERSION);
    return 0;
  }

  if (flagBool(args.flags, 'help') || flagBool(args.flags, 'h')) {
    return commandHelp();
  }

  try {
    switch (args.command) {
      case 'review':
        return await commandReview(args);
      case 'changelog':
        return await commandChangelog(args);
      case 'release':
        return await commandRelease(args);
      case 'health':
        return await commandHealth(args);
      case 'docs':
        return await commandDocs(args);
      case 'help':
        return commandHelp();
      default:
        console.error(`${style.red('Unknown command')}: ${args.command}\n`);
        commandHelp();
        return 2;
    }
  } catch (error) {
    console.error(`\n${style.red('✖')} ${style.bold(errorMessage(error))}`);

    if (process.env.AUTODEV_DEBUG && error instanceof Error && error.stack) {
      console.error(style.grey(error.stack));
    } else {
      console.error(style.grey('Re-run with AUTODEV_DEBUG=1 for a stack trace.'));
    }

    return 1;
  } finally {
    await closeStore().catch(() => {});
  }
}

// Only auto-run when executed directly, so the module stays importable in tests.
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /autodev|cli[/\\]index/.test(process.argv[1]);

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
