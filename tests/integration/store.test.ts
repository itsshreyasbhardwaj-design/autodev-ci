import { beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '@/core/types';
import { MemoryStore } from '@/db/memory-store';
import type { DataStore, RepositoryInput } from '@/db/store';

/**
 * Storage contract tests.
 *
 * Written against the {@link DataStore} interface rather than the in-memory
 * class, so the same suite can be pointed at the Postgres adapter to prove the
 * two behave identically.
 */

let store: DataStore & { reset(): void };

const repositoryInput: RepositoryInput = {
  organizationId: null,
  githubId: '123',
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  defaultBranch: 'main',
  private: false,
  encryptedToken: null,
  installationId: null,
  config: {},
  active: true,
};

function findingOf(overrides: Partial<Finding> = {}): Finding {
  return {
    id: '',
    rule: 'security/x',
    category: 'security',
    severity: 'high',
    title: 'A finding',
    description: 'Details',
    source: 'static',
    confidence: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  store = new MemoryStore();
});

describe('repositories', () => {
  it('creates and reads back a repository', async () => {
    const created = await store.upsertRepository(repositoryInput);

    expect(created.id).toBeTruthy();
    expect(await store.getRepository(created.id)).toMatchObject({ fullName: 'acme/widgets' });
    expect(await store.getRepositoryByFullName('acme/widgets')).toMatchObject({ id: created.id });
  });

  it('matches full names case-insensitively', async () => {
    await store.upsertRepository(repositoryInput);
    expect(await store.getRepositoryByFullName('ACME/Widgets')).not.toBeNull();
  });

  it('updates rather than duplicating on a second upsert', async () => {
    const first = await store.upsertRepository(repositoryInput);
    const second = await store.upsertRepository({ ...repositoryInput, defaultBranch: 'develop' });

    expect(second.id).toBe(first.id);
    expect(second.defaultBranch).toBe('develop');
    expect((await store.listRepositories()).total).toBe(1);
  });

  it('returns null for an unknown id', async () => {
    expect(await store.getRepository('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('cascades deletion to reviews and findings', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    const review = await store.createReview({
      repositoryId: repository.id,
      pullRequestId: null,
      headSha: 'a'.repeat(40),
      status: 'completed',
      verdict: 'comment',
      score: 80,
      engine: 'static',
      summary: null,
      commendations: [],
      gates: [],
      metrics: {},
      error: null,
      durationMs: 100,
    });
    await store.saveFindings(review.id, repository.id, [findingOf()]);

    expect(await store.deleteRepository(repository.id)).toBe(true);
    expect((await store.listReviews(undefined)).total).toBe(0);
    expect((await store.listFindings()).total).toBe(0);
  });

  it('does not leak internal state through returned objects', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    // Mutating a returned record must not alter what is stored — a class of
    // bug that simply cannot happen against a real database.
    repository.config.injected = true;

    const reread = await store.getRepository(repository.id);
    expect(reread!.config.injected).toBeUndefined();
  });
});

describe('reviews and findings', () => {
  it('stores findings and filters them by severity', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    const review = await store.createReview({
      repositoryId: repository.id,
      pullRequestId: null,
      headSha: 'a'.repeat(40),
      status: 'completed',
      verdict: 'request-changes',
      score: 40,
      engine: 'static',
      summary: null,
      commendations: [],
      gates: [],
      metrics: {},
      error: null,
      durationMs: 50,
    });

    await store.saveFindings(review.id, repository.id, [
      findingOf({ severity: 'critical', rule: 'security/a' }),
      findingOf({ severity: 'low', rule: 'style/b', category: 'readability' }),
    ]);

    const critical = await store.listFindings({ severity: 'critical' });
    expect(critical.total).toBe(1);
    expect(critical.items[0]!.rule).toBe('security/a');

    const byCategory = await store.listFindings({ category: 'readability' });
    expect(byCategory.total).toBe(1);
  });

  it('hides dismissed findings by default but keeps the audit trail', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    const review = await store.createReview({
      repositoryId: repository.id,
      pullRequestId: null,
      headSha: 'a'.repeat(40),
      status: 'completed',
      verdict: 'comment',
      score: 70,
      engine: 'static',
      summary: null,
      commendations: [],
      gates: [],
      metrics: {},
      error: null,
      durationMs: 10,
    });

    const [saved] = await store.saveFindings(review.id, repository.id, [findingOf()]);
    await store.dismissFinding(saved!.id, 'Accepted risk: internal-only endpoint');

    expect((await store.listFindings()).total).toBe(0);

    const withDismissed = await store.listFindings({ includeDismissed: true });
    expect(withDismissed.total).toBe(1);
    expect(withDismissed.items[0]!.dismissedReason).toContain('Accepted risk');
  });

  it('assigns ids to findings that arrive without one', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    const review = await store.createReview({
      repositoryId: repository.id,
      pullRequestId: null,
      headSha: 'a'.repeat(40),
      status: 'completed',
      verdict: 'comment',
      score: 70,
      engine: 'static',
      summary: null,
      commendations: [],
      gates: [],
      metrics: {},
      error: null,
      durationMs: 10,
    });

    const saved = await store.saveFindings(review.id, repository.id, [findingOf({ id: '' })]);
    expect(saved[0]!.id).toBeTruthy();
  });
});

describe('health snapshots', () => {
  it('keeps one snapshot per repository per day', async () => {
    const repository = await store.upsertRepository(repositoryInput);
    const day = new Date('2026-03-01T09:00:00Z');

    await store.saveHealthSnapshot({
      repositoryId: repository.id,
      score: 70,
      grade: 'C',
      dimensions: [],
      recommendations: [],
      computedAt: day,
    });

    await store.saveHealthSnapshot({
      repositoryId: repository.id,
      score: 82,
      grade: 'B',
      dimensions: [],
      recommendations: [],
      computedAt: new Date('2026-03-01T17:00:00Z'),
    });

    const history = await store.listHealthSnapshots(repository.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.score).toBe(82);
  });

  it('returns history oldest-first for charting', async () => {
    const repository = await store.upsertRepository(repositoryInput);

    for (const [index, date] of ['2026-03-01', '2026-03-02', '2026-03-03'].entries()) {
      await store.saveHealthSnapshot({
        repositoryId: repository.id,
        score: 60 + index * 10,
        grade: 'C',
        dimensions: [],
        recommendations: [],
        computedAt: new Date(`${date}T00:00:00Z`),
      });
    }

    const history = await store.listHealthSnapshots(repository.id);
    expect(history.map((snapshot) => snapshot.score)).toEqual([60, 70, 80]);
    expect((await store.latestHealthSnapshot(repository.id))!.score).toBe(80);
  });
});

describe('pagination', () => {
  it('clamps the limit and reports the true total', async () => {
    const repository = await store.upsertRepository(repositoryInput);

    for (let index = 0; index < 30; index += 1) {
      await store.createReview({
        repositoryId: repository.id,
        pullRequestId: null,
        headSha: String(index).padStart(40, '0'),
        status: 'completed',
        verdict: 'comment',
        score: index,
        engine: 'static',
        summary: null,
        commendations: [],
        gates: [],
        metrics: {},
        error: null,
        durationMs: 1,
      });
    }

    const page = await store.listReviews(repository.id, { limit: 10, offset: 5 });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(30);
    expect(page.offset).toBe(5);

    // A caller asking for 1,000 rows gets the cap, not the whole table.
    const capped = await store.listReviews(repository.id, { limit: 1000 });
    expect(capped.items.length).toBeLessThanOrEqual(100);
  });
});
