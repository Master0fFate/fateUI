import { randomUUID } from 'node:crypto';
import type { McpServerDefinition } from '../../shared/contracts/ipc';
import { monitorWatchRequestSchema, type MonitorWatchRequest, type MonitorWatchResult, type MonitorWatchesSnapshot, type MonitorWatchStatus } from '../../shared/contracts/monitorWatches';
import { MonitorConnectorExitError, pollGitHub, waitForMcp } from './monitorSources';

const TTL_MS = 60 * 60_000;
const CHECK_MS = 5_000;
const POLL_MS = 20_000;
const MAX_WATCHES = 8;
const MAX_HISTORY = 24;
const MAX_COMPLETIONS = 256;
const FIRST_SAVE_GRACE_MS = 30_000;

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
  withConnectors?<T>(use: (servers: readonly McpServerDefinition[]) => T): Promise<T>;
  selectedTarget(scope: Pick<MonitorWatchRequest, 'workspaceRoot' | 'sessionId'>): MonitorWatchTarget | null;
}
type WatchOrigin = 'monitor' | 'watch_ci';
interface Watch {
  request: MonitorWatchRequest;
  origin: WatchOrigin;
  key: string;
  status: MonitorWatchStatus;
  controller: AbortController;
  target: MonitorWatchTarget;
  answer?: string;
  connector?: Connector;
  nextCheck: number;
  saveDeadline?: number;
  failures: number;
}

function statusNotice(source: MonitorWatchRequest['source'], result: MonitorWatchResult): string {
  if (source.kind === 'mcp') return `MCP connector ${source.connector} reported ${result} for event ${source.eventId} at revision ${source.revision}.`;
  const [label, path] = source.kind === 'github-pr' ? [`PR #${source.prNumber}`, `commit/${source.sha}/checks`]
    : [`run ${source.runId}`, `actions/runs/${source.runId}`];
  const outcome = result === 'failure' ? 'at least one check failed' : `CI result: ${result}`;
  return `${source.repo} ${label} at ${source.sha.slice(0, 7)}: ${outcome}.\nhttps://github.com/${source.repo}/${path}`;
}

function sameConnector(left: Connector, right: Connector): boolean {
  return left.name === right.name && left.command === right.command
    && left.args.length === right.args.length && left.args.every((arg, i) => arg === right.args[i]);
}

export class DesktopMonitorWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly history: { workspaceRoot: string; sessionId: string; status: MonitorWatchStatus }[] = [];
  private readonly starting = new Set<{ workspaceRoot: string; sessionId: string; cancelled: boolean }>();
  private readonly consumed = new Set<string>();
  private readonly working = new Set<Watch>();
  private readonly answering = new Set<string>();
  private readonly settling = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;

  private disposed = false;
  private cleanupUnconfirmed = false;

  constructor(private readonly deps: MonitorDependencies) {}

  private async connectors(): Promise<Connector[]> {
    const servers: readonly McpServerDefinition[] = await this.deps.connectors().catch((): readonly McpServerDefinition[] => []);
    return servers.filter((connector): connector is Connector => connector.enabled && connector.transport === 'stdio');
  }

  async snapshot(workspaceRoot: string, sessionId: string): Promise<MonitorWatchesSnapshot> {
    const connectors = await this.connectors();
    if (!this.deps.isLocal() || this.disposed) throw new Error('Monitor watches require the local desktop.');
    const matches = (scope: { workspaceRoot: string; sessionId: string }) => scope.workspaceRoot === workspaceRoot && scope.sessionId === sessionId;
    const target = this.deps.selectedTarget({ workspaceRoot, sessionId });
    const current = [...this.watches.values()].filter(({ request }) => matches(request));
    return { connectors: connectors.map(({ name }) => name), wakeAvailable: Boolean(target?.answer && target.report),
      watches: [...current, ...this.history.filter(matches)].map(({ status }) => ({ ...status })) };
  }

  hasActiveWork(workspaceRoot: string): boolean {
    return [...this.watches.values()].some(({ request }) => request.workspaceRoot === workspaceRoot);
  }

  async start(input: unknown, scopeIsCurrent?: () => boolean, origin: WatchOrigin = 'monitor'): Promise<void> {
    const request = monitorWatchRequestSchema.parse(input);
    if (!this.deps.isLocal() || this.disposed) throw new Error('Monitor watches require the local desktop.');
    if (this.watches.size + this.starting.size >= MAX_WATCHES || this.working.size + this.starting.size >= MAX_WATCHES) throw new Error('Stop a watch before adding another.');
    if (this.consumed.size + this.watches.size + this.starting.size >= MAX_COMPLETIONS) throw new Error('The desktop watch limit for this process has been reached.');
    const target = this.deps.selectedTarget(request);
    if (!target) throw new Error('Open the original trusted saved chat before starting a watch.');
    if (request.wake && !target.report) throw new Error('The original chat is unavailable for Monitor updates.');
    if (request.wake && origin === 'monitor' && !target.answer) throw new Error('A configured chat model is required for an automatic Monitor reply.');
    const admission = { workspaceRoot: request.workspaceRoot, sessionId: request.sessionId, cancelled: false };
    this.starting.add(admission);
    try {
      const { source } = request;
      if (source.kind !== 'mcp') { source.repo = source.repo.toLowerCase(); source.sha = source.sha.toLowerCase(); }
      const connector = source.kind === 'mcp' ? (await this.connectors()).find(({ name }) => name === source.connector) : undefined;
      if (source.kind === 'mcp' && !connector) throw new Error('Enable the local stdio connector in Settings > MCP before starting a watch.');
      const roots = await this.deps.trustedRoots();
      if (!roots.includes(request.workspaceRoot)) throw new Error('The original trusted chat is unavailable.');
      const saved = await target.isSaved();
      if (!saved && origin !== 'watch_ci') throw new Error('The original trusted saved chat is unavailable.');
      if (admission.cancelled || this.disposed || !this.deps.isLocal() || scopeIsCurrent?.() === false) {
        throw new Error('Monitor scope changed before the watch could start.');
      }
      const key = JSON.stringify([request.workspaceRoot, request.sessionId, source.kind === 'mcp'
        ? [source.kind, source.connector, source.eventId, source.revision]
        : [source.kind, source.repo, source.kind === 'github-pr' ? source.prNumber : source.runId, source.sha]]);
      if (this.consumed.has(key) || [...this.watches.values()].some((watch) => watch.key === key)) throw new Error('This completion is already watched or was already recorded for this chat.');
      const id = randomUUID();
      const watch: Watch = { request, origin, key, target, controller: new AbortController(), ...(connector ? { connector } : {}),
        status: { id, source, state: 'waiting', wake: request.wake, expiresAt: Date.now() + TTL_MS },
        nextCheck: 0, ...(!saved ? { saveDeadline: Date.now() + FIRST_SAVE_GRACE_MS } : {}), failures: 0 };
      this.watches.set(id, watch);
      this.schedule(0);
    } finally { this.starting.delete(admission); }
  }

  stop(workspaceRoot: string, sessionId: string, id: string): void {
    const watch = this.watches.get(id);
    if (watch?.request.workspaceRoot === workspaceRoot && watch.request.sessionId === sessionId) this.finish(watch, 'stopped');
  }

  clear(workspaceRoot?: string, sessionId?: string): void {
    const matches = (scope: { workspaceRoot: string; sessionId: string }) => (workspaceRoot === undefined || scope.workspaceRoot === workspaceRoot)
      && (sessionId === undefined || scope.sessionId === sessionId);
    for (const admission of this.starting) if (matches(admission)) admission.cancelled = true;
    for (const watch of this.watches.values()) if (matches(watch.request)) this.finish(watch, 'stopped');
    for (let i = this.history.length - 1; i >= 0; i--) if (matches(this.history[i]!)) this.history.splice(i, 1);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clear();
    await Promise.allSettled(this.settling);
    if (this.cleanupUnconfirmed) throw new MonitorConnectorExitError();
  }

  recheckConnectors(servers: readonly McpServerDefinition[]): void {
    for (const watch of this.watches.values()) {
      const pinned = watch.connector;
      if (pinned && !servers.some((item) => item.transport === 'stdio' && item.enabled && sameConnector(pinned, item))) {
        this.finish(watch, 'stopped');
      }
    }
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
    const { workspaceRoot, sessionId } = watch.request;
    this.history.unshift({ workspaceRoot, sessionId, status: { ...watch.status } });
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
    const pending = [...this.watches.values()];
    const [roots, configs] = await Promise.all([this.deps.trustedRoots().catch((): string[] => []), this.connectors()]);
    for (const watch of pending) {
      if (!this.live(watch)) continue;
      if (!roots.includes(watch.request.workspaceRoot)) { this.clear(watch.request.workspaceRoot); continue; }
      const pinned = watch.connector;
      if (pinned && !configs.some((item) => sameConnector(pinned, item))) { this.finish(watch, 'stopped'); continue; }
      const saved = await watch.target.isSaved();
      if (!this.live(watch)) continue;
      if (!saved) {
        if (watch.saveDeadline !== undefined) {
          if (Date.now() >= watch.saveDeadline) this.finish(watch, 'failed');
        } else this.clear(watch.request.workspaceRoot, watch.request.sessionId);
        continue;
      }
      delete watch.saveDeadline;
      if (this.working.size >= MAX_WATCHES || this.working.has(watch) || Date.now() < watch.nextCheck) continue;
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
    await this.revalidate(watch);
    try {
      if (source.kind !== 'mcp') result = await pollGitHub(source, signal, watch.request.workspaceRoot);
      else {
        const launch = (servers: readonly McpServerDefinition[]) => {
          const approved = servers.find((server): server is Connector => server.transport === 'stdio' && server.enabled && sameConnector(server, watch.connector!));
          if (!approved || !this.live(watch)) throw new Error('The MCP watch connector is no longer enabled.');
          return { outcome: waitForMcp(source, approved, signal) };
        };
        const pending = this.deps.withConnectors ? await this.deps.withConnectors(launch) : launch(await this.connectors());
        result = await pending.outcome;
      }
    } catch (error) {
      if (error instanceof MonitorConnectorExitError) {
        this.cleanupUnconfirmed = true;
        const retained = this.history.find((entry) => entry.status.id === watch.status.id);
        if (retained) retained.status.state = 'failed';
      }
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
    if (watch.origin === 'monitor' || !watch.request.wake) this.consumed.add(watch.key);
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
    if (!request.wake || result === undefined || !watch.target.report) throw new Error('Monitor reply unavailable.');
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
      if (watch.origin === 'watch_ci') {
        watch.answer ??= statusNotice(source, result);
      } else if (watch.answer === undefined) {
        if (!watch.target.answer) throw new Error('Monitor reply unavailable.');
        const text = await watch.target.answer({ id, source, result, followUp }, fence, () => { watch.status.wakeStatus = 'answering'; });
        if (text === null || !fence.current()) return;
        watch.answer = text;
        watch.status.wakeStatus = 'queued';
      }
      await watch.target.report(id, watch.answer, fence, () => {
        this.consumed.add(watch.key);
        watch.status.wakeStatus = 'reported';
        this.finish(watch, 'completed');
      });
    } finally {
      this.answering.delete(key);
    }
  }
}
