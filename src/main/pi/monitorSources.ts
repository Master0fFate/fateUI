import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EmptyResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpServerDefinition } from '../../shared/contracts/ipc';
import { monitorGitHubIdSchema, monitorGitHubRepoSchema, monitorGitHubShaSchema, monitorWatchResultSchema, monitorWatchSourceSchema, type MonitorWatchResult, type MonitorWatchSource } from '../../shared/contracts/monitorWatches';
import { executeGitInWorktree, githubRepositoryUrl, validateSelectedRoot } from '../git/GitService';

export type { MonitorWatchResult, MonitorWatchSource } from '../../shared/contracts/monitorWatches';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 64 * 1024;
const MCP_WAIT_TIMEOUT_MS = 60 * 60_000;
const STDIO_EXIT_GRACE_MS = 250;
const STDIO_KILL_WAIT_MS = 1_000;
const GITHUB_CLI_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
type GitHubWatchSource = Extract<MonitorWatchSource, { kind: 'github-actions' | 'github-pr' }>;
const positiveId = z.number().int().positive().safe();
const githubRepository = z.object({ full_name: monitorGitHubRepoSchema });
const githubRun = z.object({
  id: positiveId,
  repository: githubRepository,
  head_sha: monitorGitHubShaSchema,
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
});
const githubPull = z.object({
  number: positiveId,
  state: z.enum(['open', 'closed']),
  base: z.object({ repo: githubRepository }),
  head: z.object({ sha: monitorGitHubShaSchema, ref: z.string().min(1), repo: githubRepository.nullable() }),
});
const branchPulls = z.array(githubPull).max(2);
const pullProjection = '{number, state, base: {repo: {full_name: .base.repo.full_name}}, head: {sha: .head.sha, ref: .head.ref, repo: (if .head.repo == null then null else {full_name: .head.repo.full_name} end)}}';
const watchUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|actions\/runs)\/([1-9][0-9]{0,15})\/?$/u;
const MAX_CHECK_PAGES = 10;
const CHECKS_PER_PAGE = 100;
const pullChecksQuery = `query FateMonitorPullChecks($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequest(number: $number) {
      number
      headRefOid
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: ${CHECKS_PER_PAGE}, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { id status conclusion }
            ... on StatusContext { id state }
          }
        } } } }
      }
    }
  }
}`;
const checkId = z.string().min(1).max(512);
const checkContext = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), id: checkId, status: z.string().min(1), conclusion: z.string().min(1).nullable() }),
  z.object({ __typename: z.literal('StatusContext'), id: checkId, state: z.string().min(1) }),
]);
const checkRollup = z.object({ contexts: z.object({
  totalCount: z.number().int().nonnegative().safe(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(2048).nullable() }),
  nodes: z.array(checkContext).max(CHECKS_PER_PAGE),
}) });
const pullChecksResponse = z.object({ errors: z.array(z.unknown()).max(0).optional(), data: z.object({
  repository: z.object({ nameWithOwner: monitorGitHubRepoSchema, pullRequest: z.object({
    number: positiveId,
    headRefOid: monitorGitHubShaSchema,
    commits: z.object({ nodes: z.tuple([z.object({ commit: z.object({ oid: monitorGitHubShaSchema, statusCheckRollup: checkRollup.nullable() }) })]) }),
  }).nullable() }).nullable(),
}) });

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function githubCli(signal: AbortSignal, workspaceRoot?: string): Promise<string> {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const root = workspaceRoot ? await realpath(workspaceRoot).catch(() => workspaceRoot) : undefined;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    signal.throwIfAborted();
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      const executable = await realpath(candidate);
      if ((root && (insideRoot(root, candidate) || insideRoot(root, executable))) || !(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      signal.throwIfAborted();
      return executable;
    } catch {
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  throw new Error('Install GitHub CLI (gh) outside the workspace and add it to PATH to watch GitHub CI.');
}

async function githubApi(executable: string, args: string[], signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const env = getDefaultEnvironment();
  for (const key of GITHUB_CLI_ENV) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  Object.assign(env, { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1' });
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, ['api', '--hostname', 'github.com', ...args], {
      signal, timeout: REQUEST_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_SOURCE_BYTES, shell: false, windowsHide: true,
      cwd: dirname(process.execPath), env,
    }, (error, output) => {
      if (error) reject(signal.aborted ? signal.reason : new Error('GitHub lookup failed. Check your connection and GitHub CLI sign-in and repository access.'));
      else resolve(output);
    });
  });
  signal.throwIfAborted();
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('GitHub returned an invalid watch response.');
  }
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

async function readRun(executable: string, repo: string, runId: string, signal: AbortSignal) {
  const payload = await githubApi(executable, ['--method', 'GET', `repos/${repo}/actions/runs/${runId}`], signal);
  const run = githubRun.safeParse(payload);
  if (!run.success || String(run.data.id) !== runId || !same(run.data.repository.full_name, repo)) {
    throw new Error('GitHub Actions response did not match the requested run.');
  }
  return run.data;
}

async function readWorkspaceBranch(workspaceRoot: string, signal: AbortSignal) {
  try {
    await validateSelectedRoot(workspaceRoot);
    signal.throwIfAborted();
    const read = async (args: string[]) => (await executeGitInWorktree(workspaceRoot, args, 8_192)).toString('utf8').replace(/\r?\n$/u, '');
    const [ref, sha, remote] = await Promise.all([
      read(['symbolic-ref', '--quiet', 'HEAD']),
      read(['--no-replace-objects', 'rev-parse', '--verify', 'HEAD^{commit}']),
      read(['config', '--local', '--get-all', 'remote.origin.url']),
    ]);
    signal.throwIfAborted();
    const repo = !/[\u0000-\u001f\u007f]/u.test(remote) ? githubRepositoryUrl(remote)?.slice('https://github.com/'.length) : undefined;
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
    if (!branch || branch.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(branch) || !repo
      || !monitorGitHubRepoSchema.safeParse(repo).success || !monitorGitHubShaSchema.safeParse(sha).success) throw new Error();
    return { repo: repo.toLowerCase(), branch, sha: sha.toLowerCase() };
  } catch {
    signal.throwIfAborted();
    throw new Error('Could not identify a checked-out branch with a github.com origin. Supply a GitHub pull request or Actions run URL.');
  }
}

export async function resolveGitHubWatch(
  workspaceRoot: string,
  selector: { url?: string; workflow?: string },
  signal: AbortSignal,
): Promise<GitHubWatchSource> {
  signal.throwIfAborted();
  if (selector.url !== undefined) {
    const [, slug = '', target, id = ''] = watchUrl.exec(selector.url) ?? [];
    if (!monitorGitHubRepoSchema.safeParse(slug).success || !monitorGitHubIdSchema.safeParse(id).success) {
      throw new Error('Supply a canonical https://github.com pull request or Actions run URL.');
    }
    if (selector.workflow !== undefined && target !== 'actions/runs') throw new Error('Supply the exact GitHub Actions run URL to watch one workflow.');
    const repo = slug.toLowerCase();
    const executable = await githubCli(signal, workspaceRoot);
    if (target === 'actions/runs') {
      const run = await readRun(executable, repo, id, signal);
      return { kind: 'github-actions', repo, runId: id, sha: run.head_sha.toLowerCase() };
    }
    const pull = githubPull.safeParse(await githubApi(executable, ['--method', 'GET', `repos/${repo}/pulls/${id}`, '--jq', pullProjection], signal));
    if (!pull.success || String(pull.data.number) !== id || !same(pull.data.base.repo.full_name, repo)) {
      throw new Error('GitHub response did not match the requested pull request.');
    }
    return { kind: 'github-pr', repo, prNumber: id, sha: pull.data.head.sha.toLowerCase() };
  }
  if (selector.workflow !== undefined) throw new Error('A workflow name alone does not identify CI for this commit. Supply the exact GitHub Actions run URL, or watch all pull request checks.');

  const { repo, branch, sha } = await readWorkspaceBranch(workspaceRoot, signal);
  const executable = await githubCli(signal, workspaceRoot);
  const owner = repo.slice(0, repo.indexOf('/'));
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${branch}`, per_page: '2' });
  const pulls = branchPulls.safeParse(await githubApi(executable, ['--method', 'GET', `repos/${repo}/pulls?${query}`, '--jq', `map(${pullProjection})`], signal));
  if (!pulls.success || pulls.data.some((pull) => pull.state !== 'open' || pull.head.ref !== branch
    || !pull.head.repo || !same(pull.head.repo.full_name, repo) || !same(pull.base.repo.full_name, repo))) {
    throw new Error('GitHub response did not match the workspace branch. Supply the pull request URL.');
  }
  if (pulls.data.length > 1) throw new Error('More than one open pull request matches this branch. Supply the pull request URL.');
  const pull = pulls.data[0];
  if (!pull) throw new Error('No open pull request was found for this branch on origin. Supply the pull request or Actions run URL.');
  if (!same(pull.head.sha, sha)) throw new Error('The pull request head differs from your local commit. Push or sync your branch, or supply the pull request URL to watch its current head.');
  const current = await readWorkspaceBranch(workspaceRoot, signal);
  if (current.repo !== repo || current.branch !== branch || current.sha !== sha) throw new Error('The workspace branch changed during GitHub discovery. Try again.');
  return { kind: 'github-pr', repo, prNumber: String(pull.number), sha };
}

function checkResult(check: z.infer<typeof checkContext>): MonitorWatchResult | 'ignored' | undefined {
  if (check.__typename === 'CheckRun' && (check.status !== 'COMPLETED' || check.conclusion === null)) return undefined;
  const state = check.__typename === 'CheckRun' ? check.conclusion : check.state;
  switch (state) {
    case 'EXPECTED': case 'PENDING': return undefined;
    case 'SUCCESS': return 'success';
    case 'ERROR': case 'FAILURE': case 'TIMED_OUT': case 'ACTION_REQUIRED': case 'STARTUP_FAILURE': case 'STALE': return 'failure';
    case 'CANCELLED': return 'cancelled';
    case 'NEUTRAL': case 'SKIPPED': return 'ignored';
    default: return 'other';
  }
}

async function pollPull(executable: string, source: Extract<GitHubWatchSource, { kind: 'github-pr' }>, signal: AbortSignal): Promise<MonitorWatchResult | undefined> {
  const { repo, prNumber, sha } = source;
  const [owner, name] = repo.split('/') as [string, string];
  const checks = new Map<string, ReturnType<typeof checkResult>>();
  let cursor: string | undefined;
  let expected: number | undefined;
  for (let page = 0; page < MAX_CHECK_PAGES; page++) {
    const args = ['--method', 'POST', 'graphql', '--raw-field', `query=${pullChecksQuery}`, '--raw-field', `owner=${owner}`,
      '--raw-field', `repo=${name}`, '--field', `number=${prNumber}`];
    if (cursor !== undefined) args.push('--raw-field', `after=${cursor}`);
    const parsed = pullChecksResponse.safeParse(await githubApi(executable, args, signal));
    if (!parsed.success) throw new Error('GitHub returned an invalid pull request checks response.');
    const repository = parsed.data.data.repository;
    const pull = repository?.pullRequest;
    if (!repository || !same(repository.nameWithOwner, repo) || !pull || String(pull.number) !== prNumber) {
      throw new Error('GitHub checks did not match the watched pull request.');
    }
    const { commit } = pull.commits.nodes[0];
    if (!same(pull.headRefOid, sha) || !same(commit.oid, sha)) throw new Error('The watched pull request head was superseded.');
    const contexts = commit.statusCheckRollup?.contexts;
    if (!contexts || contexts.totalCount === 0) return undefined;
    if (contexts.totalCount > MAX_CHECK_PAGES * CHECKS_PER_PAGE) throw new Error('GitHub returned too many pull request checks to verify the complete result.');
    if (expected !== undefined && expected !== contexts.totalCount) return undefined;
    expected = contexts.totalCount;
    for (const check of contexts.nodes) {
      if (checks.has(check.id)) return undefined;
      checks.set(check.id, checkResult(check));
    }
    if (!contexts.pageInfo.hasNextPage) {
      if (checks.size !== expected) return undefined;
      const results = [...checks.values()];
      if (results.includes('failure')) return 'failure';
      if (results.includes(undefined)) return undefined;
      if (results.includes('cancelled')) return 'cancelled';
      if (results.includes('other')) return 'other';
      return results.includes('success') ? 'success' : 'other';
    }
    const next = contexts.pageInfo.endCursor;
    if (next === null || next === cursor || !contexts.nodes.length || checks.size >= expected) return undefined;
    cursor = next;
  }
  throw new Error('Could not verify the complete GitHub pull request checks result.');
}

export async function pollGitHub(
  source: GitHubWatchSource,
  signal: AbortSignal,
  workspaceRoot?: string,
): Promise<MonitorWatchResult | undefined> {
  signal.throwIfAborted();
  const parsed = monitorWatchSourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind === 'mcp') throw new Error('Invalid GitHub watch identity.');
  const executable = await githubCli(signal, workspaceRoot);
  if (parsed.data.kind === 'github-pr') return pollPull(executable, parsed.data, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  const { repo, runId, sha } = parsed.data;
  const run = await readRun(executable, repo, runId, signal);
  if (!same(run.head_sha, sha)) throw new Error('GitHub Actions response did not match the watch identity.');
  if (run.status !== 'completed') return undefined;
  const { conclusion } = run;
  if (conclusion === null) throw new Error('Completed GitHub Actions run has no conclusion.');
  return conclusion === 'success' || conclusion === 'failure' || conclusion === 'cancelled' ? conclusion : 'other';
}

export class MonitorConnectorExitError extends Error {
  constructor() { super('Could not confirm MCP watch connector exit after forced termination.'); }
}

class WatchStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessByStdio<Writable, Readable, null>;
  private closing?: Promise<void>;
  private readonly reader = new ReadBuffer();
  private remaining = MAX_SOURCE_BYTES;

  constructor(private readonly server: Extract<McpServerDefinition, { transport: 'stdio' }>) {}

  async start(): Promise<void> {
    const child = spawn(this.server.command, this.server.args, {
      cwd: dirname(process.execPath), env: getDefaultEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true,
    });
    this.child = child;
    const fail = (error: Error) => {
      if (!this.closing) this.onerror?.(error);
    };
    child.once('close', () => setImmediate(() => this.onclose?.()));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closing) return;
      this.remaining -= chunk.length;
      if (this.remaining < 0) {
        child.stdout.pause();
        fail(new Error('MCP watch output exceeded its byte limit.'));
        return;
      }
      try {
        this.reader.append(chunk);
        for (let message = this.reader.readMessage(); message; message = this.reader.readMessage()) {
          this.onmessage?.(message);
        }
      } catch {
        child.stdout.pause();
        fail(new Error('Invalid MCP watch message.'));
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || this.closing) throw new Error('MCP watch connection is closed.');
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    return this.closing ??= this.stop();
  }

  private async stop(): Promise<void> {
    this.reader.clear();
    const child = this.child;
    if (!child) return;
    const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
    let onExit!: () => void;
    const exited = new Promise<true>((resolve) => { onExit = () => resolve(true); });
    child.once('exit', onExit);
    try {
      child.stdout.destroy();
      child.stdin.end();
      if (running() && !await Promise.race([exited, delay(STDIO_EXIT_GRACE_MS, false, { ref: false })])) {
        if (running()) child.kill('SIGKILL');
        if (running() && !await Promise.race([exited, delay(STDIO_KILL_WAIT_MS, false, { ref: false })]) && running()) {
          throw new MonitorConnectorExitError();
        }
      }
    } finally {
      child.removeListener('exit', onExit);
      child.stdin.destroy();
      child.unref();
    }
  }
}

const watchCapability = z.object({ version: z.literal(1) }).strict();
const watchNotification = z.object({ method: z.literal('notifications/fate/watch'), params: z.unknown().optional() });
const watchEvent = z.object({ eventId: z.string(), revision: z.string(), result: monitorWatchResultSchema }).strict();

export async function waitForMcp(
  source: Extract<MonitorWatchSource, { kind: 'mcp' }>,
  server: McpServerDefinition,
  signal: AbortSignal,
): Promise<MonitorWatchResult> {
  signal.throwIfAborted();
  const parsed = monitorWatchSourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'mcp') throw new Error('Invalid MCP watch identity.');
  const { connector, eventId, revision } = parsed.data;
  if (server.enabled !== true || server.transport !== 'stdio' || server.name !== connector) {
    throw new Error('MCP watch requires the named, enabled local stdio connector.');
  }

  const client = new Client({ name: 'fate-monitor-watch', version: '1.0.0' });
  const transport = new WatchStdioTransport(server);
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(MCP_WAIT_TIMEOUT_MS)]);
  const setup = AbortSignal.any([lifetime, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let fail!: (reason: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  const onAbort = () => fail(lifetime.reason);
  client.onclose = () => fail(new Error('MCP watch connector closed before a result.'));
  client.onerror = () => fail(new Error('MCP watch connector encountered a protocol or transport error.'));
  lifetime.addEventListener('abort', onAbort, { once: true });

  let subscribing = false;
  const result = new Promise<MonitorWatchResult>((resolve) => {
    client.setNotificationHandler(watchNotification, ({ params }) => {
      if (!subscribing) return;
      const event = watchEvent.safeParse(params);
      if (event.success && event.data.eventId === eventId && event.data.revision === revision) resolve(event.data.result);
    });
  });
  const subscribe = async () => {
    try {
      await client.connect(transport, { signal: setup, timeout: REQUEST_TIMEOUT_MS });
    } catch {
      setup.throwIfAborted();
      throw new Error('MCP watch connector initialization failed.');
    }
    if (!watchCapability.safeParse(client.getServerCapabilities()?.experimental?.['fate.monitorWatch']).success) {
      throw new Error('MCP watch connector does not advertise fate.monitorWatch version 1.');
    }
    setup.throwIfAborted();
    subscribing = true;
    try {
      await client.request({ method: 'fate/watch/subscribe', params: { eventId, revision } }, EmptyResultSchema, {
        signal: setup, timeout: REQUEST_TIMEOUT_MS,
      });
    } catch {
      setup.throwIfAborted();
      throw new Error('MCP watch connector did not acknowledge the subscription.');
    }
  };

  let failSetup!: (reason: unknown) => void;
  const setupFailed = new Promise<never>((_resolve, reject) => { failSetup = reject; });
  const onSetupAbort = () => failSetup(setup.reason);
  setup.addEventListener('abort', onSetupAbort, { once: true });
  try {
    const subscribed = subscribe().then(() => setup.removeEventListener('abort', onSetupAbort));
    const completion = Promise.all([subscribed, result]).then(([, outcome]) => outcome);
    const outcome = await Promise.race([failed, setupFailed, completion]);
    lifetime.throwIfAborted();
    return outcome;
  } finally {
    setup.removeEventListener('abort', onSetupAbort);
    lifetime.removeEventListener('abort', onAbort);
    client.removeNotificationHandler('notifications/fate/watch');
    await transport.close();
  }
}
