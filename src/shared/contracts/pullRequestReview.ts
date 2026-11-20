import { z } from 'zod';

export const gitReviewHeadSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const reviewCheckSchema = z.object({ name: z.string().min(1).max(240), state: z.enum(['passed', 'failed', 'pending', 'other']) }).strict();

export const pullRequestReviewChannels = { status: 'git:pull-request-review' } as const;
export const pullRequestReviewInputSchema = z.object({ projectPath: z.string().min(1).max(32_768), head: gitReviewHeadSchema, branch: z.string().min(1).max(1_000) }).strict();
export const pullRequestReviewStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'), head: gitReviewHeadSchema, checkedAt: z.number().int().nonnegative(),
    number: z.number().int().positive().safe(), title: z.string().max(400),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']), draft: z.boolean(),
    checks: z.array(reviewCheckSchema).max(30), checksTruncated: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'), head: gitReviewHeadSchema,
    reason: z.enum(['no-pr', 'not-github', 'not-published', 'ambiguous', 'busy', 'gh-missing', 'head-changed', 'auth-or-network']),
  }).strict(),
]);

export type PullRequestReviewStatus = z.infer<typeof pullRequestReviewStatusSchema>;
