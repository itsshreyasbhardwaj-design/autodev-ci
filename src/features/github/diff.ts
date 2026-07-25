/**
 * Unified diff parser.
 *
 * This is the foundation the whole review engine sits on. Two properties
 * matter more than anything else here:
 *
 * 1. **Correct line numbers.** A comment on the wrong line is worse than no
 *    comment, so every added line carries its true line number in the head
 *    revision, tracked through hunk headers.
 * 2. **Correct diff positions.** GitHub's inline-comment API does not accept
 *    file line numbers — it wants an offset counted from the first `@@` of
 *    that file's patch, counting *every* line including hunk headers and
 *    context. Getting this wrong is the classic reason bot comments land in
 *    absurd places, so it is computed here once and reused everywhere.
 */

export type ChangeStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'unchanged';

export type LineKind = 'added' | 'removed' | 'context';

export interface DiffLine {
  readonly kind: LineKind;
  readonly content: string;
  /** Line number in the base revision (removed and context lines). */
  readonly oldLine?: number;
  /** Line number in the head revision (added and context lines). */
  readonly newLine?: number;
  /** Offset within the file's patch, as GitHub's review API counts it. */
  readonly position: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Text after the `@@ ... @@`, usually the enclosing function signature. */
  readonly heading: string;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** True when GitHub omitted the patch (binary, or too large). */
  readonly binary: boolean;
  readonly language: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Maps file extensions to language identifiers. Used to pick the right
 * analyzers and to fence code blocks in generated comments.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
  tf: 'terraform',
  dockerfile: 'dockerfile',
};

export function detectLanguage(path: string): string {
  const base = path.split('/').pop() ?? path;
  const lower = base.toLowerCase();

  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower.startsWith('.env')) return 'dotenv';

  const extension = lower.includes('.') ? (lower.split('.').pop() ?? '') : '';
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext';
}

/**
 * Parses a single file's unified patch (the `patch` field of a GitHub file
 * entry, which has no `diff --git` or `+++`/`---` preamble).
 */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = patch.split('\n');

  let current: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    heading: string;
    lines: DiffLine[];
  } | null = null;

  let oldCursor = 0;
  let newCursor = 0;
  // GitHub counts position from the line *after* the first @@, starting at 1.
  let position = 0;

  const flush = (): void => {
    if (current) hunks.push({ ...current, lines: current.lines });
    current = null;
  };

  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw);

    if (header) {
      flush();
      oldCursor = Number(header[1]);
      newCursor = Number(header[3]);
      position += 1;
      current = {
        oldStart: oldCursor,
        oldLines: header[2] ? Number(header[2]) : 1,
        newStart: newCursor,
        newLines: header[4] ? Number(header[4]) : 1,
        heading: (header[5] ?? '').trim(),
        lines: [],
      };
      continue;
    }

    if (!current) continue;

    // "\ No newline at end of file" is metadata, not content, but GitHub does
    // count it as a position.
    if (raw.startsWith('\\')) {
      position += 1;
      continue;
    }

    const marker = raw[0];
    const content = raw.slice(1);
    position += 1;

    if (marker === '+') {
      current.lines.push({ kind: 'added', content, newLine: newCursor, position });
      newCursor += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'removed', content, oldLine: oldCursor, position });
      oldCursor += 1;
    } else {
      current.lines.push({
        kind: 'context',
        content,
        oldLine: oldCursor,
        newLine: newCursor,
        position,
      });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  flush();
  return hunks;
}

export interface RawFileChange {
  readonly filename: string;
  readonly previous_filename?: string | undefined;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string | undefined;
}

function normaliseStatus(status: string): ChangeStatus {
  switch (status) {
    case 'added':
    case 'modified':
    case 'removed':
    case 'renamed':
    case 'copied':
      return status;
    case 'changed':
      return 'modified';
    default:
      return 'modified';
  }
}

/** Converts GitHub's file listing into {@link FileDiff}s. */
export function buildFileDiffs(files: readonly RawFileChange[]): FileDiff[] {
  return files.map((file) => ({
    path: file.filename,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    status: normaliseStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.patch ? parsePatch(file.patch) : [],
    // No patch on a file with changed lines means GitHub suppressed it.
    binary: !file.patch && (file.additions > 0 || file.deletions > 0),
    language: detectLanguage(file.filename),
  }));
}

/** Parses a full `git diff` output containing multiple files. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Split on `diff --git` boundaries while keeping each file's own header.
  const sections = diff.split(/^diff --git /m).filter((section) => section.trim().length > 0);

  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';

    // `a/path/to/file b/path/to/file` — take the b-side as the current path.
    const pathMatch = /^a\/(.+?) b\/(.+)$/.exec(header.trim());
    let path = pathMatch?.[2] ?? header.trim();
    let previousPath: string | undefined;

    let status: ChangeStatus = 'modified';
    let binary = false;

    for (const line of lines.slice(1)) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'removed';
      else if (line.startsWith('rename from ')) {
        status = 'renamed';
        previousPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        path = line.slice('rename to '.length).trim();
      } else if (line.startsWith('Binary files ')) binary = true;
      else if (line.startsWith('@@')) break;
    }

    const patchStart = section.indexOf('\n@@');
    const hunks = patchStart === -1 ? [] : parsePatch(section.slice(patchStart + 1));

    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'added') additions += 1;
        else if (line.kind === 'removed') deletions += 1;
      }
    }

    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status,
      additions,
      deletions,
      hunks,
      binary,
      language: detectLanguage(path),
    });
  }

  return files;
}

// --- Convenience accessors ------------------------------------------------

export function addedLines(file: FileDiff): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'added'));
}

export function removedLines(file: FileDiff): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'removed'));
}

/** The head-revision content of every added line, joined. Analyzer input. */
export function addedContent(file: FileDiff): string {
  return addedLines(file)
    .map((line) => line.content)
    .join('\n');
}

export function totalAdditions(files: readonly FileDiff[]): number {
  return files.reduce((sum, file) => sum + file.additions, 0);
}

export function totalDeletions(files: readonly FileDiff[]): number {
  return files.reduce((sum, file) => sum + file.deletions, 0);
}

/**
 * Finds the diff position for a line number in the head revision, or
 * `undefined` when that line is not part of the diff (GitHub rejects inline
 * comments outside the diff, so callers must fall back to a summary comment).
 */
export function positionForLine(file: FileDiff, newLine: number): number | undefined {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine === newLine && line.kind !== 'removed') return line.position;
    }
  }
  return undefined;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\//i;
const TEST_FILE =
  /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|Test\.(java|kt|cs)$|test_.*\.py$/i;

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_FILE.test(path);
}

const DOC_PATH = /(^|\/)(docs?|documentation)\//i;
const DOC_FILE = /\.(md|mdx|rst|adoc|txt)$/i;

export function isDocFile(path: string): boolean {
  return DOC_PATH.test(path) || DOC_FILE.test(path);
}

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.split('/').pop() ?? '');
}

const GENERATED_MARKERS = [
  '@generated',
  'Code generated by',
  'DO NOT EDIT',
  'auto-generated',
  'autogenerated',
];

/**
 * Detects vendored, generated or minified files. Reviewing these produces pure
 * noise, so analyzers skip them.
 */
export function isGeneratedFile(file: FileDiff): boolean {
  const path = file.path;

  if (isLockfile(path)) return true;
  if (/(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage|__generated__)\//.test(path)) {
    return true;
  }
  if (/\.(min\.js|min\.css|map|snap|pb\.go|generated\.ts|g\.dart)$/.test(path)) return true;

  const head = addedContent(file).slice(0, 2000);
  return GENERATED_MARKERS.some((marker) => head.includes(marker));
}

/** Files worth analysing: excludes binaries, generated output and empty diffs. */
export function analyzableFiles(files: readonly FileDiff[]): FileDiff[] {
  return files.filter(
    (file) =>
      !file.binary && file.status !== 'removed' && file.hunks.length > 0 && !isGeneratedFile(file),
  );
}
