import { z } from 'zod';
import { REVIEW_CATEGORIES, SEVERITIES } from '@/core/types';

/**
 * Repository configuration (`.autodev.yml`).
 *
 * Maintainers need to tune this per repository — a prototype and a payments
 * service should not share a security posture. Everything has a defensible
 * default so an empty file behaves sensibly, and unknown keys are rejected so
 * typos surface immediately instead of being silently ignored.
 */

const severityEnum = z.enum(SEVERITIES);
const categoryEnum = z.enum(REVIEW_CATEGORIES);

export const reviewConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Categories to analyse. Narrow this to reduce noise. */
    categories: z.array(categoryEnum).default([...REVIEW_CATEGORIES]),
    /** Findings below this severity are dropped before reporting. */
    minSeverity: severityEnum.default('low'),
    /** Post line-level comments in addition to the summary. */
    inlineComments: z.boolean().default(true),
    /** Cap on inline comments per review; the rest fold into the summary. */
    maxInlineComments: z.number().int().min(0).max(100).default(20),
    /** Include a "what went well" section. */
    commendations: z.boolean().default(true),
    /** Skip files matching these globs. */
    ignore: z
      .array(z.string())
      .default(['**/dist/**', '**/build/**', '**/vendor/**', '**/*.min.js', '**/node_modules/**']),
    /** Rule ids to disable entirely, e.g. `style/line-length`. */
    disabledRules: z.array(z.string()).default([]),
    /** Findings below this confidence are reported but never block. */
    blockingConfidence: z.number().min(0).max(1).default(0.7),
    /** Request changes automatically when a blocking gate fails. */
    requestChangesOnFailure: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export const qualityGatesConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Fail when any finding is at or above this severity. */
    failOnSeverity: severityEnum.default('critical'),
    /** Warn when any finding is at or above this severity. */
    warnOnSeverity: severityEnum.default('high'),
    /** Fail when a PR changes more than this many lines without tests. */
    maxUntestedLines: z.number().int().min(0).default(400),
    /** Fail when the PR touches more than this many files. */
    maxChangedFiles: z.number().int().min(0).default(75),
    /** Require a test file change when source files change. */
    requireTests: z.boolean().default(false),
    /** Require a docs change when public API surface changes. */
    requireDocs: z.boolean().default(false),
    /** Fail when duplicated blocks increase beyond this many occurrences. */
    maxDuplicateBlocks: z.number().int().min(0).default(5),
    /** Fail when any single function exceeds this cyclomatic complexity. */
    maxFunctionComplexity: z.number().int().min(1).default(15),
  })
  .strict()
  .prefault({});

export const securityConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    secretScanning: z.boolean().default(true),
    dependencyAudit: z.boolean().default(true),
    /** Flag prompt-injection risks in AI/LLM code paths. */
    promptInjection: z.boolean().default(true),
    /** Regex patterns whose matches are treated as false positives. */
    allowlist: z.array(z.string()).default([]),
  })
  .strict()
  .prefault({});

export const changelogConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Path written by `autodev changelog --write`. */
    path: z.string().default('CHANGELOG.md'),
    /** Commit types shown in the changelog, in display order. */
    includeTypes: z
      .array(z.string())
      .default(['feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'revert']),
    groupByScope: z.boolean().default(false),
    includeContributors: z.boolean().default(true),
    /** Link commit hashes and PR numbers back to GitHub. */
    linkReferences: z.boolean().default(true),
  })
  .strict()
  .prefault({});

export const docsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Files checked for drift when code changes. */
    watch: z.array(z.string()).default(['README.md', 'docs/**/*.md', 'CHANGELOG.md']),
    /** Open a PR with suggested updates rather than committing directly. */
    openPullRequest: z.boolean().default(true),
    branchPrefix: z.string().default('autodev/docs'),
  })
  .strict()
  .prefault({});

export const notificationsConfigSchema = z
  .object({
    githubComment: z.boolean().default(true),
    slack: z.boolean().default(false),
    teams: z.boolean().default(false),
    email: z.boolean().default(false),
    /** Only notify for findings at or above this severity. */
    minSeverity: severityEnum.default('high'),
  })
  .strict()
  .prefault({});

export const autodevConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    review: reviewConfigSchema,
    qualityGates: qualityGatesConfigSchema,
    security: securityConfigSchema,
    changelog: changelogConfigSchema,
    docs: docsConfigSchema,
    notifications: notificationsConfigSchema,
  })
  .strict();

export type AutodevConfig = z.infer<typeof autodevConfigSchema>;
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
export type QualityGatesConfig = z.infer<typeof qualityGatesConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type ChangelogConfig = z.infer<typeof changelogConfigSchema>;
export type DocsConfig = z.infer<typeof docsConfigSchema>;
export type NotificationsConfig = z.infer<typeof notificationsConfigSchema>;

/** The configuration used when a repository has no `.autodev.yml`. */
export function defaultConfig(): AutodevConfig {
  return autodevConfigSchema.parse({});
}
