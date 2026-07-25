import { z } from 'zod';
import { detectDocumentationDrift, detectDriftSignals } from '@/features/analysis/docs-drift';
import { getFileContent, loadPullRequestContext } from '@/features/github/client';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  pullNumber: z.number().int().positive(),
  /** Documentation files to check against. Defaults to the common set. */
  documents: z.array(z.string().max(255)).max(20).optional(),
});

const DEFAULT_DOCUMENTS = ['README.md', 'docs/README.md', 'CONTRIBUTING.md', '.env.example'];

/**
 * `POST /api/docs` — detect documentation drift for a pull request.
 *
 * Returns both the raw drift signals (what changed in the code) and the
 * findings (what is missing from the docs), so a caller can render either the
 * diagnosis or the specific gaps.
 */
export const POST = handler(
  async ({ body, log }) => {
    const target = { owner: body.owner, repo: body.repo };

    const context = await loadPullRequestContext(target, body.pullNumber);
    const paths = body.documents ?? DEFAULT_DOCUMENTS;

    const documents = (
      await Promise.all(
        paths.map(async (path) => {
          const content = await getFileContent(target, path, context.pullRequest.headSha);
          return content ? { path, content } : null;
        }),
      )
    ).filter((doc): doc is { path: string; content: string } => doc !== null);

    const signals = detectDriftSignals(context.files);
    const findings = detectDocumentationDrift({ files: context.files, documents });

    log.info('Documentation drift analysed', {
      repository: `${body.owner}/${body.repo}`,
      pullNumber: body.pullNumber,
      signals: signals.length,
      findings: findings.length,
    });

    return ok({
      pullRequest: {
        number: context.pullRequest.number,
        title: context.pullRequest.title,
        headSha: context.pullRequest.headSha,
      },
      documentsChecked: documents.map((doc) => doc.path),
      signals,
      findings,
      driftDetected: findings.length > 0,
    });
  },
  { bodySchema, rateLimit: 30 },
);
