import { execFile } from 'node:child_process';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { executeGitInWorktree } from '../../git/GitService';

const GH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_FAILED_LOG_CHARS = 6_000;
const MAX_FAILED_RUNS = 3;
const DEFAULT_BRANCHES = new Set(['main', 'master']);

function gh(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }, maxBuffer: 4 * 1024 * 1024, timeout: GH_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32', ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout.toString()); return; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { reject(new Error('The GitHub CLI (gh) is not installed or not on PATH. Install it and run gh auth login.')); return; }
      reject(new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${(stderr.toString() || error.message).trim().slice(0, 2_000)}`));
    });
  });
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content.length > MAX_OUTPUT_CHARS ? `${content.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : content }], details: {} };
}

async function currentBranch(cwd: string): Promise<string> {
  const branch = (await executeGitInWorktree(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 16_384).catch(() => Buffer.alloc(0))).toString('utf8').trim();
  if (!branch) throw new Error('HEAD is detached. Check out a branch before pushing.');
  return branch;
}

interface CheckRollup { name?: string; context?: string; conclusion?: string; state?: string; status?: string; detailsUrl?: string; workflowName?: string; __typename?: string }

function checkState(check: CheckRollup): string {
  return (check.conclusion || check.state || check.status || 'unknown').toLowerCase();
}

export function createPullRequestTools(cwd: string, fullAccess: () => boolean): ToolDefinition[] {
  const guard = () => { if (!fullAccess()) throw new Error('Pushing and pull requests require Full access.'); };
  const guidelines = ['Push only after the user asked for a branch or pull request.', 'Never push to main or master; use git_push on a feature branch.'];
  return [
    defineTool({
      name: 'git_push',
      label: 'Push branch',
      description: 'Push the current branch to origin and set its upstream. Refuses the default branches main and master.',
      promptSnippet: 'Push the current feature branch to origin (Full access)',
      promptGuidelines: guidelines,
      parameters: Type.Object({ force: Type.Optional(Type.Boolean({ description: 'Force push with lease. Default false.' })) }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_id, params) {
        guard();
        const branch = await currentBranch(cwd);
        if (DEFAULT_BRANCHES.has(branch)) throw new Error(`Refusing to push ${branch}. Create a feature branch first.`);
        const output = await executeGitInWorktree(cwd, ['push', '--set-upstream', ...(params.force ? ['--force-with-lease'] : []), 'origin', `HEAD:refs/heads/${branch}`], 1024 * 1024);
        return text(`Pushed ${branch} to origin.\n${output.toString('utf8').trim()}`.trim());
      },
    }),
    defineTool({
      name: 'pr_create',
      label: 'Create pull request',
      description: 'Open a GitHub pull request for the current branch with the GitHub CLI. Pushes the branch first when it has no upstream.',
      promptSnippet: 'Create a GitHub pull request for the current branch (Full access)',
      promptGuidelines: guidelines,
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 256 }),
        body: Type.String({ maxLength: 60_000 }),
        base: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: 'Base branch. Defaults to the repository default branch.' })),
        draft: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_id, params, signal) {
        guard();
        const branch = await currentBranch(cwd);
        if (DEFAULT_BRANCHES.has(branch)) throw new Error(`Refusing to open a pull request from ${branch}. Create a feature branch first.`);
        const upstream = (await executeGitInWorktree(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 16_384).catch(() => Buffer.alloc(0))).toString('utf8').trim();
        if (!upstream) await executeGitInWorktree(cwd, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], 1024 * 1024);
        const url = await gh(cwd, ['pr', 'create', '--head', branch, '--title', params.title, '--body', params.body, ...(params.base ? ['--base', params.base] : []), ...(params.draft ? ['--draft'] : [])], signal);
        return text(`Pull request created: ${url.trim()}`);
      },
    }),
    defineTool({
      name: 'pr_status',
      label: 'Pull request status',
      description: 'Show the pull request for the current branch: state, review decision, mergeability, every check, and the failed log tail of failing workflow runs.',
      promptSnippet: 'Read pull request state, checks, and failed CI logs for the current branch',
      promptGuidelines: guidelines,
      parameters: Type.Object({ number: Type.Optional(Type.Integer({ minimum: 1, description: 'Pull request number. Defaults to the current branch.' })) }, { additionalProperties: false }),
      executionMode: 'parallel',
      async execute(_id, params, signal) {
        guard();
        const selector = params.number ? [String(params.number)] : [];
        const raw = await gh(cwd, ['pr', 'view', ...selector, '--json', 'number,title,url,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName,statusCheckRollup'], signal);
        const pr = JSON.parse(raw) as { number: number; title: string; url: string; state: string; isDraft: boolean; mergeable: string; reviewDecision: string; headRefName: string; baseRefName: string; statusCheckRollup?: CheckRollup[] };
        const checks = pr.statusCheckRollup ?? [];
        const lines = [
          `#${pr.number} ${pr.title}`,
          pr.url,
          `state ${pr.state}${pr.isDraft ? ' (draft)' : ''} · ${pr.headRefName} → ${pr.baseRefName} · mergeable ${pr.mergeable || 'unknown'} · review ${pr.reviewDecision || 'none'}`,
          `checks: ${checks.length}`,
          ...checks.map((check) => `  ${checkState(check)} ${check.name || check.context || check.workflowName || 'check'}${check.detailsUrl ? ` ${check.detailsUrl}` : ''}`),
        ];
        const failed = checks.filter((check) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(checkState(check)));
        let shown = 0;
        for (const check of failed) {
          const match = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? '');
          if (!match || shown >= MAX_FAILED_RUNS) continue;
          shown += 1;
          const log = await gh(cwd, ['run', 'view', match[1]!, '--log-failed'], signal).catch((error: Error) => error.message);
          lines.push('', `--- failed log: ${check.name || check.workflowName || match[1]} ---`, log.length > MAX_FAILED_LOG_CHARS ? `…${log.slice(-MAX_FAILED_LOG_CHARS)}` : log);
        }
        return text(lines.join('\n'));
      },
    }),
  ];
}
