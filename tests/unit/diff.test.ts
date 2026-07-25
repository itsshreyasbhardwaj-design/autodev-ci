import { describe, expect, it } from 'vitest';
import {
  addedLines,
  analyzableFiles,
  buildFileDiffs,
  detectLanguage,
  isDocFile,
  isGeneratedFile,
  isTestFile,
  parsePatch,
  parseUnifiedDiff,
  positionForLine,
} from '@/features/github/diff';

describe('parsePatch', () => {
  it('tracks line numbers across a hunk', () => {
    const hunks = parsePatch(
      [
        '@@ -10,3 +10,4 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' return a;',
      ].join('\n'),
    );

    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;

    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);

    const added = hunk.lines.filter((line) => line.kind === 'added');
    expect(added.map((line) => line.newLine)).toEqual([11, 12]);

    const removed = hunk.lines.filter((line) => line.kind === 'removed');
    expect(removed.map((line) => line.oldLine)).toEqual([11]);
  });

  it('continues numbering correctly across multiple hunks', () => {
    const hunks = parsePatch(
      [
        '@@ -1,2 +1,3 @@',
        ' first',
        '+second',
        '@@ -50,2 +51,3 @@',
        ' fiftieth',
        '+fifty-first',
      ].join('\n'),
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.find((line) => line.kind === 'added')?.newLine).toBe(2);
    expect(hunks[1]!.lines.find((line) => line.kind === 'added')?.newLine).toBe(52);
  });

  it('counts diff position the way the GitHub review API does', () => {
    // Position counts every line after the first @@, starting at 1 for the
    // @@ line itself. Getting this wrong puts comments on the wrong lines.
    const hunks = parsePatch(['@@ -1,2 +1,3 @@', ' context', '+added', ' more'].join('\n'));
    const lines = hunks[0]!.lines;

    expect(lines[0]!.position).toBe(2);
    expect(lines[1]!.position).toBe(3);
    expect(lines[2]!.position).toBe(4);
  });

  it('treats a "no newline at end of file" marker as a position but not content', () => {
    const hunks = parsePatch(
      ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n'),
    );

    const lines = hunks[0]!.lines;
    expect(lines).toHaveLength(2);
    // The marker consumed position 3, so the addition is at 4.
    expect(lines[1]!.position).toBe(4);
  });

  it('handles single-line hunks without an explicit count', () => {
    const hunks = parsePatch(['@@ -5 +5 @@', '-old', '+new'].join('\n'));
    expect(hunks[0]!.oldStart).toBe(5);
    expect(hunks[0]!.oldLines).toBe(1);
    expect(hunks[0]!.newLines).toBe(1);
  });

  it('returns no hunks for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('positionForLine', () => {
  it('resolves a head line number to its diff position', () => {
    const [file] = buildFileDiffs([
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: ['@@ -1,2 +1,3 @@', ' one', '+two', ' three'].join('\n'),
      },
    ]);

    expect(positionForLine(file!, 2)).toBe(3);
  });

  it('returns undefined for a line outside the diff', () => {
    const [file] = buildFileDiffs([
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: ['@@ -1,1 +1,2 @@', ' one', '+two'].join('\n'),
      },
    ]);

    // Commenting outside the diff is rejected by GitHub, so this must not
    // silently resolve to a nearby position.
    expect(positionForLine(file!, 900)).toBeUndefined();
  });
});

describe('parseUnifiedDiff', () => {
  it('parses a multi-file git diff with adds, renames and deletes', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export const gone = true;',
    ].join('\n');

    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe('src/new.ts');
    expect(files[0]!.status).toBe('added');
    expect(files[0]!.additions).toBe(2);
    expect(files[1]!.status).toBe('removed');
    expect(files[1]!.deletions).toBe(1);
  });

  it('records the new path and previous path for a rename', () => {
    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 95%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file!.status).toBe('renamed');
    expect(file!.path).toBe('src/new-name.ts');
    expect(file!.previousPath).toBe('src/old-name.ts');
  });
});

describe('file classification', () => {
  it('detects languages from extensions and bare filenames', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('Dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('.env.local')).toBe('dotenv');
    expect(detectLanguage('LICENSE')).toBe('plaintext');
  });

  it('identifies test files by path and by filename', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('tests/foo.ts')).toBe(true);
    expect(isTestFile('__tests__/foo.js')).toBe(true);
    // pytest collects `test_*.py`, so this is a test module by convention.
    expect(isTestFile('app/test_helpers.py')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
    expect(isTestFile('src/latest.ts')).toBe(false);
    expect(isTestFile('src/contest/index.ts')).toBe(false);
  });

  it('identifies documentation files', () => {
    expect(isDocFile('README.md')).toBe(true);
    expect(isDocFile('docs/guide.mdx')).toBe(true);
    expect(isDocFile('src/index.ts')).toBe(false);
  });

  it('recognises generated and vendored files', () => {
    const [lockfile, minified, marked, normal] = buildFileDiffs([
      {
        filename: 'pnpm-lock.yaml',
        status: 'modified',
        additions: 5,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n+x',
      },
      {
        filename: 'public/app.min.js',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n+x',
      },
      {
        filename: 'src/api.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n+// Code generated by protoc. DO NOT EDIT.',
      },
      {
        filename: 'src/real.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n+const a = 1;',
      },
    ]);

    expect(isGeneratedFile(lockfile!)).toBe(true);
    expect(isGeneratedFile(minified!)).toBe(true);
    expect(isGeneratedFile(marked!)).toBe(true);
    expect(isGeneratedFile(normal!)).toBe(false);
  });

  it('excludes binaries, deletions and generated output from analysis', () => {
    const files = buildFileDiffs([
      {
        filename: 'src/good.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n+const a = 1;',
      },
      // No patch with changed lines means GitHub suppressed it: binary.
      { filename: 'assets/logo.png', status: 'modified', additions: 3, deletions: 1 },
      {
        filename: 'src/gone.ts',
        status: 'removed',
        additions: 0,
        deletions: 4,
        patch: '@@ -1,4 +0,0 @@\n-a',
      },
      {
        filename: 'yarn.lock',
        status: 'modified',
        additions: 9,
        deletions: 2,
        patch: '@@ -1,1 +1,2 @@\n+x',
      },
    ]);

    const analyzable = analyzableFiles(files);
    expect(analyzable.map((file) => file.path)).toEqual(['src/good.ts']);
  });
});

describe('addedLines', () => {
  it('returns only additions with their head-revision line numbers', () => {
    const [file] = buildFileDiffs([
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: ['@@ -1,3 +1,4 @@', ' keep', '-drop', '+add1', '+add2', ' keep2'].join('\n'),
      },
    ]);

    const added = addedLines(file!);
    expect(added.map((line) => line.content)).toEqual(['add1', 'add2']);
    expect(added.map((line) => line.newLine)).toEqual([2, 3]);
  });
});
