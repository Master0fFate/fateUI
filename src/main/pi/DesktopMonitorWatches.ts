import { randomUUID } from 'node:crypto';
import type { McpServerDefinition } from '../../shared/contracts/ipc';
import { monitorWatchRequestSchema, type MonitorWatchRequest, type MonitorWatchResult, type MonitorWatchesSnapshot, type MonitorWatchStatus } from '../../shared/contracts/monitorWatches';
import { pollGitHub, waitForMcp } from './monitorSources';

const TTL_MS = 60 * 60_000;
const CHECK_MS = 5_000;
const POLL_MS = 20_000;
const MAX_WATCHES = 8;
const MAX_HISTORY = 24;
const MAX_COMPLETIONS = 256;

type Connector = Extract<McpServerDefinition, { transport: 'stdio' }>;
export interface MonitorWakeInput {
  id: string;
  source: MonitorWatchRequest['source'];
  result: MonitorWatchResult;
  followUp: string;
}

export interface MonitorWakeFence {
  signal: AbortSignal;
  current(): boolean;
  revalidate(): Promise<void>;
}

export interface MonitorWatchTarget {
  isSaved(): Promise<boolean>;
  answer?(input: MonitorWakeInput, fence: MonitorWakeFence, onStart: () => void): Promise<string | null>;
  report?(id: string, text: string, fence: MonitorWakeFence, onCommit: () => void): Promise<void>;
}
interface MonitorDependencies {
  isLocal(): boolean;
  trustedRoots(): Promise<readonly string[]>;
  connectors(): Promise<readonly McpServerDefinition[]>;
  selectedTarget(request: MonitorWatchRequest): MonitorWatchTarget | null;
}
interface Watch {
  request: MonitorWatchRequest;
  key: string;
  status: MonitorWatchStatus;
  controller: AbortController;
  target: MonitorWatchTarget;
  answer?: string;
  connector?: Connector;
  nextCheck: number;
  failures: number;
}

function sameConnector(left: Connector, right: Connector): boolean {
  return left.name === right.name && left.command === right.command
    && left.args.length === right.args.length && left.args.every((arg, i) => arg === right.args[i]);
}

export class DesktopMonitorWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly history: Watch[] = [];
  private readonly consumed = new Set<string>();
  private readonly working = new Set<Watch>();
  private readonly answering = new Set<string>();
  private readonly settling = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private pending = 0;
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: MonitorDependencies) {}

  private async connectors(): Promise<Connector[]> {
    const servers: readonly McpServerDefinition[] = await this.deps.connectors().catch((): readonly McpServerDefinition[] => []);
    return servers.filter((connector): connector is Connector => connector.enabled && connector.transport === 'stdio');
  }

  async snapshot(workspaceRoot: string, sessionId: string): Promise<MonitorWatchesSnapshot> {
    const connectors = await this.connectors();
    if (!this.deps.isLocal() || this.disposed) throw new Error('Monitor watches require the local desktop.');
    const matches = (watch: Watch) => watch.request.workspaceRoot === workspaceRoot && watch.request.sessionId === sessionId;
    return { connectors: connectors.map(({ name }) => name), wakeAvailable: true,
      watches: [...this.watches.values(), ...this.history].filter(matches).map(({ status }) => ({ ...status })) };
  }

  async start(input: unknown, scopeIsCurrent?: () => boolean): Promise<void> {
    const request = monitorWatchRequestSchema.parse(input);
    if (!this.deps.isLocal() || this.disposed) throw new Error('Monitor watches require the local desktop.');
    if (this.watches.size + this.pending >= MAX_WATCHES || this.working.size + this.pending >= MAX_WATCHES) throw new Error('Stop a watch before adding another.');
    if (this.consumed.size + this.watches.size + this.pending >= MAX_COMPLETIONS) throw new Error('The desktop watch limit for this process has been reached.');
    const target = this.deps.selectedTarget(request);
    if (!target) throw new Error('Open the original trusted saved chat before starting a watch.');
    if (request.wake && (!target.answer || !target.report)) throw new Error('A configured chat model is required for an automatic Monitor reply.');
    const generation = this.generation;
    this.pending++;
    try {
      const { source } = request;
      if (source.kind === 'github-actions') { source.repo = source.repo.toLowerCase(); source.sha = source.sha.toLowerCase(); }
      const connector = source.kind === 'mcp' ? (await this.connectors()).find(({ name }) => name === source.connector) : undefined;
      if (source.kind === 'mcp' && !connector) throw new Error('Enable the local stdio connector in Settings > MCP before starting a watch.');
      const roots = await this.deps.trustedRoots();
      if (!roots.includes(request.workspaceRoot) || !await target.isSaved()) throw new Error('The original trusted saved chat is unavailable.');
      if (generation !== this.generation || this.disposed || !this.deps.isLocal() || scopeIsCurrent?.() === false) {
        throw new Error('Monitor scope changed before the watch could start.');
      }
      const key = JSON.stringify([request.workspaceRoot, request.sessionId, source.kind === 'mcp'
        ? [source.kind, source.connector, source.eventId, source.revision] : [source.kind, source.repo, source.runId, source.sha]]);
      if (this.consumed.has(key) || [...this.watches.values()].some((watch) => watch.key === key)) throw new Error('This completion is already watched or was already recorded for this chat.');
      const id = randomUUID();
      const watch: Watch = { request, key, target, controller: new AbortController(), ...(connector ? { connector } : {}),
        status: { id, source, state: 'waiting', wake: request.wake, expiresAt: Date.now() + TTL_MS }, nextCheck: 0, failures: 0 };
      this.watches.set(id, watch);
      this.schedule(0);
    } finally { this.pending--; }
  }

  stop(workspaceRoot: string, sessionId: string, id: string): void {
    const watch = this.watches.get(id);
    if (watch?.request.workspaceRoot === workspaceRoot && watch.request.sessionId === sessionId) this.finish(watch, 'stopped');
  }

  clear(workspaceRoot?: string, sessionId?: string): void {
    this.generation++;
    const matches = ({ request }: Watch) => (workspaceRoot === undefined || request.workspaceRoot === workspaceRoot)
      && (sessionId === undefined || request.sessionId === sessionId);
    for (const watch of this.watches.values()) if (matches(watch)) this.finish(watch, 'stopped');
    for (let i = this.history.length - 1; i >= 0; i--) if (matches(this.history[i]!)) this.history.splice(i, 1);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clear();
    await Promise.allSettled(this.settling);
  }

  private live(watch: Watch): boolean {
    if (this.disposed || watch.controller.signal.aborted || this.watches.get(watch.status.id) !== watch) return false;
    if (Date.now() >= watch.status.expiresAt) { this.finish(watch, 'expired'); return false; }
    if (!this.deps.isLocal()) { this.finish(watch, 'stopped'); return false; }
    return true;
  }

  private finish(watch: Watch, state: MonitorWatchStatus['state']): void {
    if (!this.watches.delete(watch.status.id)) return;
    watch.status.state = state;
    if (watch.status.wakeStatus === 'queued' || watch.status.wakeStatus === 'answering') watch.status.wakeStatus = 'failed';
    delete watch.answer;
    watch.controller.abort();
    this.history.unshift(watch);
    this.history.length = Math.min(this.history.length, MAX_HISTORY);
    if (!this.watches.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private schedule(ms = CHECK_MS): void {
    if (this.timer || this.ticking || !this.watches.size || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ticking = true;
      void this.tick().catch(() => this.clear()).finally(() => { this.ticking = false; this.schedule(); });
    }, ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const [roots, configs] = await Promise.all([this.deps.trustedRoots().catch((): string[] => []), this.connectors()]);
    for (const watch of this.watches.values()) {
      if (!this.live(watch)) continue;
      if (!roots.includes(watch.request.workspaceRoot)) { this.clear(watch.request.workspaceRoot); continue; }
      const pinned = watch.connector;
      if (pinned && !configs.some((item) => sameConnector(pinned, item))) { this.finish(watch, 'stopped'); continue; }
      if (!await watch.target.isSaved()) { this.clear(watch.request.workspaceRoot, watch.request.sessionId); continue; }
      if (!this.live(watch) || this.working.size >= MAX_WATCHES || this.working.has(watch) || Date.now() < watch.nextCheck) continue;
      this.working.add(watch);
      const operation = (watch.status.result === undefined ? this.step(watch) : this.wake(watch)).catch(() => {
        if (this.live(watch)) this.finish(watch, watch.status.result === undefined ? 'failed' : 'completed');
      })
        .finally(() => { this.working.delete(watch); this.settling.delete(operation); });
      this.settling.add(operation);
    }
  }

  private async step(watch: Watch): Promise<void> {
    const { source } = watch.request;
    const signal = AbortSignal.any([watch.controller.signal, AbortSignal.timeout(Math.max(1, watch.status.expiresAt - Date.now()))]);
    let result: MonitorWatchResult | undefined;
    try {
      result = source.kind === 'github-actions' ? await pollGitHub(source, signal)
        : await waitForMcp(source, watch.connector!, signal);
    } catch {
      if (!this.live(watch)) return;
      if (source.kind === 'mcp' || ++watch.failures >= 5) { this.finish(watch, 'failed'); return; }
      watch.status.state = 'backoff';
      watch.nextCheck = Date.now() + Math.min(120_000, POLL_MS * 2 ** watch.failures);
      return;
    }
    if (!this.live(watch)) return;
    watch.failures = 0;
    if (result === undefined) {
      watch.status.state = 'waiting';
      watch.nextCheck = Date.now() + POLL_MS;
      return;
    }
    await this.revalidate(watch);
    this.consumed.add(watch.key);
    watch.status.result = result;
    watch.status.state = 'completed';
    if (!watch.request.wake) { this.finish(watch, 'completed'); return; }
    watch.status.wakeStatus = 'queued';
    watch.nextCheck = 0;
    await this.wake(watch);
  }

  private async revalidate(watch: Watch): Promise<void> {
    const { workspaceRoot, sessionId } = watch.request;
    const [roots, configs, saved] = await Promise.all([
      this.deps.trustedRoots(), watch.connector ? this.connectors() : Promise.resolve([]), watch.target.isSaved(),
    ]);
    if (this.live(watch)) {
      if (!roots.includes(workspaceRoot)) this.clear(workspaceRoot);
      else if (!saved) this.clear(workspaceRoot, sessionId);
      else if (watch.connector && !configs.some((item) => sameConnector(watch.connector!, item))) this.finish(watch, 'stopped');
    }
    if (!this.live(watch)) throw new Error('The Monitor watch is no longer eligible.');
  }

  private async wake(watch: Watch): Promise<void> {
    const { request } = watch;
    const { id, result, expiresAt } = watch.status;
    if (!request.wake || result === undefined || !watch.target.answer || !watch.target.report) throw new Error('Monitor reply unavailable.');
    const { workspaceRoot, sessionId, source, followUp } = request;
    const key = JSON.stringify([workspaceRoot, sessionId]);
    if (this.answering.has(key)) return;
    this.answering.add(key);
    const signal = AbortSignal.any([watch.controller.signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))]);
    const fence: MonitorWakeFence = {
      signal, current: () => this.live(watch) && !signal.aborted,
      revalidate: () => this.revalidate(watch),
    };
    try {
      if (watch.answer === undefined) {
        const text = await watch.target.answer({ id, source, result, followUp }, fence, () => { watch.status.wakeStatus = 'answering'; });
        if (text === null || !fence.current()) return;
        watch.answer = text;
      }
      await watch.target.report(id, watch.answer, fence, () => {
        watch.status.wakeStatus = 'reported';
        this.finish(watch, 'completed');
      });
    } finally {
      this.answering.delete(key);
    }
  }
}
