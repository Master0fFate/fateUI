import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { type PullRequestReviewStatus } from '../../shared/contracts/pullRequestReview';
import { executeGitInWorktree, githubRepositoryUrl, readGitReviewHead, validateSelectedRoot } from './GitService';

const checkLimit = 30;
const activeReviews = new Set<string>();
const query = `query FatePullRequestReview($owner: String!, $repo: String!, $head: GitObjectID!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequests(first: 20, headRefName: $branch, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes { number title state isDraft headRefOid headRefName headRepository { nameWithOwner } baseRepository { nameWithOwner } }
    }
    object(oid: $head) {
      ... on Commit {
        oid
        statusCheckRollup {
          contexts(first: ${checkLimit}) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
}`;
const repositorySchema = z.object({ nameWithOwner: z.string().max(140) });
const pullRequest = z.object({
  number: z.number().int().positive().safe(), title: z.string().max(1_000), state: z.enum(['OPEN', 'CLOSED', 'MERGED']), isDraft: z.boolean(),
  headRefOid: z.string(), headRefName: z.string(), headRepository: repositorySchema.nullable(), baseRepository: repositorySchema.nullable(),
});
const checkContext = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), name: z.string().max(1_000), status: z.string(), conclusion: z.string().nullable() }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string().max(1_000), state: z.string() }),
]);
const reply = z.object({ errors: z.array(z.unknown()).max(0).optional(), data: z.object({ repository: repositorySchema.extend({
  pullRequests: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(pullRequest.nullable()).max(20) }),
  object: z.object({ oid: z.string(),
  statusCheckRollup: z.object({ contexts: z.object({
    nodes: z.array(checkContext.nullable()).max(checkLimit), totalCount: z.number().int().nonnegative(),
  }) }).nullable(),
}).nullable() }).nullable() }) });

function unavailable(head: string, reason: Extract<PullRequestReviewStatus, { kind: 'unavailable' }>['reason']): PullRequestReviewStatus {
  return { kind: 'unavailable', head, reason };
}

function checkState(context: z.infer<typeof checkContext>): 'passed' | 'failed' | 'pending' | 'other' {
  const value = context.__typename === 'StatusContext' ? context.state : context.conclusion ?? context.status;
  switch (value) {
    case 'SUCCESS': return 'passed';
    case 'FAILURE': case 'ERROR': case 'TIMED_OUT': case 'CANCELLED': case 'ACTION_REQUIRED': case 'STARTUP_FAILURE': case 'STALE': return 'failed';
    case 'PENDING': case 'EXPECTED': case 'QUEUED': case 'IN_PROGRESS': case 'REQUESTED': case 'WAITING': case 'PENDING_DEPLOYMENT': return 'pending';
    default: return 'other';
  }
}

function label(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, max);
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    const ref = (await executeGitInWorktree(root, ['symbolic-ref', '--quiet', 'HEAD'], 8_192)).toString('utf8').trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) || null : null;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

async function publishedHead(root: string, branch: string): Promise<string | null> {
  try {
    const ref = `refs/remotes/origin/${branch}^{commit}`;
    return (await executeGitInWorktree(root, ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', ref], 1_024)).toString('utf8').trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

async function originRepository(root: string): Promise<string | null> {
  try {
    const origin = (await executeGitInWorktree(root, ['config', '--local', '--get-all', 'remote.origin.url'], 8_192)).toString('utf8').trim();
    const url = githubRepositoryUrl(origin);
    const slug = url?.slice('https://github.com/'.length);
    return slug && /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/iu.test(slug) && !/\/(?:\.|\.\.)$/u.test(slug) ? slug : null;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

async function resolveGitHubCli(root: string): Promise<string | null> {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      const executable = await realpath(candidate);
      const insideRoot = (item: string) => {
        const relative = path.relative(root, item);
        return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
      };
      if (insideRoot(candidate) || insideRoot(executable) || !(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      continue;
    }
  }
  return null;
}

function lookup(executable: string, owner: string, repo: string, head: string, branch: string): Promise<string> {
  const env = getDefaultEnvironment();
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  Object.assign(env, { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1' });
  return new Promise((resolve, reject) => {
    execFile(executable, ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-f', `head=${head}`, '-f', `branch=${branch}`], {
      cwd: path.dirname(executable), env, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true, shell: false,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function readPullRequestReview(root: string, head: string, expectedBranch: string, current: () => boolean): Promise<PullRequestReviewStatus> {
  if (!current()) return unavailable(head, 'head-changed');
  if (activeReviews.has(root) || activeReviews.size >= 3) return unavailable(head, 'busy');
  activeReviews.add(root);
  try {
    await validateSelectedRoot(root);
    const [start, branch, slug] = await Promise.all([readGitReviewHead(root), currentBranch(root), originRepository(root)]);
    if (start !== head || branch !== expectedBranch || !current()) return unavailable(head, 'head-changed');
    if (!slug || head.length !== 40) return unavailable(head, 'not-github');
    if (await publishedHead(root, branch) !== head) return unavailable(head, 'not-published');
    const executable = await resolveGitHubCli(root);
    if (!current()) return unavailable(head, 'head-changed');
    if (!executable) return unavailable(head, 'gh-missing');
    const [owner, repo] = slug.split('/') as [string, string];
    const response = await lookup(executable, owner, repo, head, branch).catch(() => null);
    const [end, newBranch, newSlug] = await Promise.all([readGitReviewHead(root), currentBranch(root), originRepository(root)]);
    if (end !== head || branch !== newBranch || slug !== newSlug || !current()) return unavailable(head, 'head-changed');
    if (response === null) return unavailable(head, 'auth-or-network');
    const parsed = reply.safeParse(JSON.parse(response));
    if (!parsed.success || parsed.data.data.repository?.nameWithOwner.toLowerCase() !== slug.toLowerCase()) return unavailable(head, 'auth-or-network');
    const { object: commit, pullRequests } = parsed.data.data.repository;
    const matches = pullRequests.nodes.filter((pr) => pr?.headRefOid === head && pr.headRefName === branch
      && pr.headRepository?.nameWithOwner.toLowerCase() === slug.toLowerCase() && pr.baseRepository?.nameWithOwner.toLowerCase() === slug.toLowerCase());
    if (pullRequests.pageInfo.hasNextPage || matches.length > 1) return unavailable(head, 'ambiguous');
    const pr = matches[0];
    if (!pr) return unavailable(head, 'no-pr');
    if (!commit || commit.oid !== head) return unavailable(head, 'auth-or-network');
    const contexts = commit.statusCheckRollup?.contexts;
    const checks = (contexts?.nodes ?? []).flatMap((entry) => entry ? [{
      name: label(entry.__typename === 'CheckRun' ? entry.name : entry.context, 240) || 'Check', state: checkState(entry),
    }] : []);
    return { kind: 'available', head, number: pr.number, title: label(pr.title, 400), state: pr.state, draft: pr.isDraft,
      checkedAt: Date.now(), checks, checksTruncated: (contexts?.totalCount ?? 0) > checks.length };
  } catch {
    return unavailable(head, current() ? 'auth-or-network' : 'head-changed');
  } finally {
    activeReviews.delete(root);
  }
}
