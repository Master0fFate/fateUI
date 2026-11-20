import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EmptyResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpServerDefinition } from '../../shared/contracts/ipc';
import { monitorWatchResultSchema, monitorWatchSourceSchema, type MonitorWatchResult, type MonitorWatchSource } from '../../shared/contracts/monitorWatches';

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
const githubRun = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repository: z.object({ full_name: z.string() }),
  head_sha: z.string(),
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
});

export async function pollGitHub(
  source: Extract<MonitorWatchSource, { kind: 'github-actions' }>,
  signal: AbortSignal,
): Promise<MonitorWatchResult | undefined> {
  signal.throwIfAborted();
  const parsed = monitorWatchSourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'github-actions' || !Number.isSafeInteger(Number(parsed.data.runId))) {
    throw new Error('Invalid GitHub Actions watch identity.');
  }
  const { repo, runId, sha } = parsed.data;
  const stdout = await new Promise<string>((resolve, reject) => {
    const env = getDefaultEnvironment();
    for (const key of GITHUB_CLI_ENV) {
      const value = process.env[key];
      if (value !== undefined && !value.startsWith('()')) env[key] = value;
    }
    execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${repo}/actions/runs/${runId}`], {
      signal, timeout: REQUEST_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_SOURCE_BYTES, shell: false, windowsHide: true,
      cwd: dirname(process.execPath),
      env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' },
    }, (error, output) => {
      if (error) reject(signal.aborted ? signal.reason : new Error('GitHub Actions lookup failed.'));
      else resolve(output);
    });
  });
  signal.throwIfAborted();
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('Invalid GitHub Actions response.');
  }
  const run = githubRun.safeParse(payload);
  if (!run.success || String(run.data.id) !== runId || run.data.repository.full_name.toLowerCase() !== repo.toLowerCase()
    || run.data.head_sha.toLowerCase() !== sha.toLowerCase()) {
    throw new Error('GitHub Actions response did not match the watch identity.');
  }
  if (run.data.status !== 'completed') return undefined;
  const { conclusion } = run.data;
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
