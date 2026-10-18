import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  agentRunSchema,
  type AgentChange, type AgentDefinition, type AgentLibrary, type AgentRun, type AgentSave, type LegacyImportItem, type RoutineDefinition, type RoutineSave, type SavedAgentSession,
} from '../../shared/contracts/agents';
import type { LegacyAutomations } from '../automations/LegacyAutomations';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { MonitorRunsSource } from '../pi/monitor/MonitorDashboard';
import { projectSessionDirectory } from '../pi/PiSessionRepository';
import { AgentRepository } from './AgentRepository';
import type { AgentHomeContext, AgentMessage, AgentRunHandle, ProjectRunRequest } from './AgentRunTool';
import { previewAutomationCopy } from './AutomationCopy';
import { HomeOwnership } from './HomeOwnership';
import { RoutineLedger } from './RoutineLedger';
import { effectivePermission } from './RoutinePolicy';

export type AgentWorkspace = Pick<PiRuntimeService, 'startAgentRun' | 'deliverAgentMessage' | 'refreshAgentSession'>;
export interface AgentHome { path: string; name: string; agentId: string; sessionId: string; file: string }
export interface AgentsHost {
  workspace(project: { path: string; name: string; agentId?: string }): Promise<AgentWorkspace>;
  liveWorkspace(projectPath: string): AgentWorkspace | null;
  trustedProjects(): Promise<readonly string[]>;
  currentModel(): { provider: string; id: string } | null;
  currentProjectPath(): string | null;
  notify?: (change: AgentChange, os: boolean) => void;
  sessionsRoot?: string;
  /** Host storage gate for new saved-agent work; abort and inspection remain available. */
  assertAdmission?: (projectPath: string, sessionId?: string | null) => void;
}
interface ActiveRun {
  agent: AgentDefinition; run: AgentRun; handle: AgentRunHandle | null; cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null; heartbeat: ReturnType<typeof setInterval> | null; completion: Promise<void> | null;
}
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 8000);
const RUNS = 'runs';
const RUN_LIMIT_MS = 30 * 60_000;
const ROUTINE_RETRY_MS = 60_000;
const ROUTINE_MAX_SLEEP_MS = 24 * 60 * 60_000;
const same = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export class AgentsService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly opening = new Map<string, Promise<AgentHome>>();
  private initialized: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking: Promise<void> | null = null;
  private nextWakeAt = Infinity;
  private stopping = false;
  private monitorCache: { loadedAt: number; library: Promise<AgentLibrary> } | null = null;
  private changed: (change: AgentChange) => void = () => { this.monitorCache = null; };
  private readonly processId = randomUUID();

  constructor(
    private readonly host: AgentsHost,
    readonly repository = new AgentRepository(),
    private readonly legacy?: Pick<LegacyAutomations, 'list'>,
  ) {}
  setChangeSink(sink: (change: AgentChange) => void): void {
    this.changed = (change) => { this.monitorCache = null; sink(change); };
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm(0);
  }
  wake(): void {
    if (this.started) this.arm(0);
  }
  beginShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private arm(delay: number): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => { this.nextWakeAt = Date.now() + ROUTINE_RETRY_MS; }).then(() => {
        if (this.nextWakeAt !== Infinity) this.arm(this.nextWakeAt - Date.now());
      });
    }, Math.min(Math.max(0, delay), ROUTINE_MAX_SLEEP_MS));
    this.timer.unref?.();
  }
  async dispose(): Promise<void> {
    this.beginShutdown();
    const active = [...this.active.values()];
    const stops = await Promise.allSettled(active.map(async (run) => { run.cancelled = true; this.stopTimers(run); await run.handle?.abort(); }));
    const settlements = await Promise.allSettled([...this.queues.values(), ...this.opening.values(), ...active.flatMap((run) => run.completion ? [run.completion] : [])]);
    const failures = [...stops, ...settlements].flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (active.some((run) => this.active.has(run.run.id))) failures.push(new Error('Saved Agent execution has not settled.'));
    if (failures.length) throw new AggregateError(failures, 'Saved Agent shutdown was incomplete.');
  }
  private admitWork(): void {
    if (this.stopping) throw new Error('Agents are shutting down.');
  }
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }
  private ledger(agentId: string): RoutineLedger { return new RoutineLedger(this.repository.ledgerJournal(agentId)); }
  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await this.repository.migrateLegacyRoutines();
      for (const agent of (await this.repository.list()).agents) {
        const journal = this.repository.ledgerJournal(agent.id);
        for (const id of await journal.ids(501)) await this.serialize(agent.id, () => this.ledger(agent.id).recover(id, Date.now(), true, this.processId));
      }
    })().catch((error: unknown) => { this.initialized = null; throw error; });
    return this.initialized;
  }

  async list(): Promise<AgentLibrary> {
    const library = await this.repository.list();
    try { await this.initialize(); }
    catch (error) { library.diagnostics.push(`Run recovery: ${failure(error)}`); }
    for (const agent of library.agents) {
      try {
        for (const id of await this.repository.ledgerJournal(agent.id).ids(501)) {
          const { state } = await this.ledger(agent.id).read(id);
          if (id !== RUNS) library.nextDue[id] = state.nextDue;
          library.runs.push(...state.runs.flatMap((run) => run.payload ? [run.payload] : []));
        }
      } catch (error) { library.diagnostics.push(`Run history ${agent.name}: ${failure(error)}`); }
    }
    library.runs.sort((a, b) => b.scheduledFor - a.scheduledFor);
    library.runs = library.runs.slice(0, 1000);
    return library;
  }

  /** Trusted runtime callers may inspect their own project without changing desktop focus. */
  async monitorRuns(projectPath: string): Promise<MonitorRunsSource> {
    if (!this.monitorCache || Date.now() - this.monitorCache.loadedAt >= 30_000) {
      const reading = this.list();
      this.monitorCache = { loadedAt: Date.now(), library: reading };
      reading.catch(() => { if (this.monitorCache?.library === reading) this.monitorCache = null; });
    }
    const library = await this.monitorCache.library;
    if (library.diagnostics.length) throw new Error('Run records could not be read completely.');
    const homeAgent = this.homeAgent(projectPath);
    const agents = new Map(library.agents.map((agent) => [agent.id, agent.name]));
    const routines = new Map(library.routines.map((routine) => [routine.id, routine.name]));
    const runs = library.runs.filter((run) => homeAgent ? run.agentId === homeAgent : run.routineId === null && same(run.projectPath, projectPath));
    return { runs, checkedAt: Date.now(), partial: false,
      names: Object.fromEntries(runs.map((run) => [run.id, `${agents.get(run.agentId) ?? 'Deleted agent'} · ${run.routineId ? routines.get(run.routineId) ?? 'Routine' : path.basename(run.projectPath)}`])) };
  }

  async saveAgent(input: AgentSave): Promise<AgentDefinition> {
    this.admitWork();
    if (input.value.google && input.value.defaults.permission === 'full-access') throw new Error('Google stays off for Full access Agents. Choose Edit files or Read only to turn it on.');
    const agent = await this.repository.saveAgent(input);
    if (!agent.enabled) await this.cancelMatching((active) => active.agent.id === agent.id);
    const state = await this.repository.state(agent.id);
    if (state?.homeProjectPath && state.homeSessionId) await this.host.liveWorkspace(state.homeProjectPath)?.refreshAgentSession(state.homeSessionId);
    this.changed({ agentId: agent.id });
    this.wake();
    return agent;
  }
  async saveRoutine(input: RoutineSave): Promise<RoutineDefinition> {
    this.admitWork();
    const routine = await this.repository.saveRoutine(input);
    const digest = (await this.repository.getRoutine(routine.id)).snapshot.digest;
    await this.serialize(routine.agentId, () => this.ledger(routine.agentId).configure(routine.id, this.schedule(routine, Date.now()), routine.revision, digest));
    this.changed({ agentId: routine.agentId });
    this.wake();
    return routine;
  }
  async remove(input: { kind: 'agent' | 'routine'; id: string; expected: { revision: number; digest: string } }): Promise<void> {
    this.admitWork();
    if (input.kind === 'agent') {
      const library = await this.repository.list();
      for (const routine of library.routines.filter((item) => item.agentId === input.id && item.enabled)) {
        const { name, agentId, message, intervalMinutes, timeZone, notify, osNotify } = routine;
        await this.repository.saveRoutine({ id: routine.id, expected: library.revisions[`routine:${routine.id}`]!, value: { name, agentId, message, intervalMinutes, timeZone, notify, osNotify, enabled: false } });
      }
      await this.cancelMatching((active) => active.agent.id === input.id);
    }
    await this.repository.remove(input.kind, input.id, input.expected);
    this.changed({});
    this.wake();
  }
  private async cancelMatching(predicate: (active: ActiveRun) => boolean): Promise<void> {
    await Promise.all([...this.active.values()].filter(predicate).map(async (active) => { active.cancelled = true; await active.handle?.abort(); }));
  }
  private schedule(routine: RoutineDefinition, anchor: number) {
    return { anchor: anchor + routine.intervalMinutes * 60_000, intervalMs: routine.intervalMinutes * 60_000, timeZone: routine.timeZone };
  }

  async currentPreset(preset: SavedAgentSession): Promise<SavedAgentSession> {
    const current = await this.repository.getAgent(preset.agentId).catch(() => null);
    if (!current) return preset;
    const { item } = current;
    return { ...preset, revision: item.revision, name: item.name, instructions: item.instructions, skillRefs: item.skillRefs, google: item.google,
      defaults: { ...item.defaults, model: item.defaults.model ?? preset.defaults.model } };
  }

  open(agentId: string): Promise<AgentHome> {
    this.admitWork();
    const existing = this.opening.get(agentId);
    if (existing) return existing;
    const operation = (async () => {
      const { item: agent } = await this.repository.getAgent(agentId);
      if (!agent.enabled) throw new Error('Enable this Agent before opening its chat.');
      const home = await this.homeFor(agent);
      await this.repository.updateState(agentId, (current) => ({ ...current, homeSessionId: home.sessionId, homeProjectPath: home.path, appliedRevision: agent.revision, lastOpenedAt: Date.now() }));
      return home;
    })();
    this.opening.set(agentId, operation);
    void operation.then(() => undefined, () => undefined).then(() => { if (this.opening.get(agentId) === operation) this.opening.delete(agentId); });
    return operation;
  }
  private homeAgent(projectPath: string): string | null {
    const relative = path.relative(path.join(this.repository.root, 'homes'), projectPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep)[0]! : null;
  }
  private homeFor(agent: AgentDefinition): Promise<AgentHome> {
    return this.repository.withHomeLock(agent.id, () => this.home(agent));
  }
  private async home(agent: AgentDefinition): Promise<AgentHome> {
    await fs.mkdir(this.repository.homePath(agent.id), { recursive: true, mode: 0o700 });
    const homePath = path.normalize(await fs.realpath(this.repository.homePath(agent.id)));
    const model = agent.defaults.model ?? this.host.currentModel();
    if (!model) throw new Error('Choose a model for this Agent before opening its chat.');
    const preset: SavedAgentSession = { schemaVersion: 1, agentId: agent.id, revision: agent.revision, name: agent.name, instructions: agent.instructions,
      skillRefs: agent.skillRefs, defaults: { ...agent.defaults, model }, background: false, runId: null, projectPath: homePath };
    const home = await new HomeOwnership(projectSessionDirectory(homePath, this.host.sessionsRoot)).open({ agentId: agent.id, revision: agent.revision, instructions: agent.instructions, projectPath: homePath, preset },
      { enabled: true, deleted: false, requirePreset: true }, agent.id);
    return { path: homePath, name: agent.name, agentId: agent.id, sessionId: home.sessionId, file: home.file };
  }
  private async deliver(agent: AgentDefinition, message: AgentMessage): Promise<string> {
    const home = await this.homeFor(agent);
    this.host.assertAdmission?.(home.path, home.sessionId);
    const workspace = await this.host.workspace({ path: home.path, name: home.name, agentId: home.agentId });
    await workspace.deliverAgentMessage(home.file, home.sessionId, message);
    return home.sessionId;
  }

  private async resolveProject(reference: string): Promise<string> {
    const trusted = (await this.host.trustedProjects()).filter((candidate) => !this.homeAgent(candidate));
    const exact = trusted.filter((candidate) => same(path.normalize(candidate), path.normalize(path.resolve(reference))));
    const named = exact.length ? exact : trusted.filter((candidate) => same(path.basename(candidate), reference.trim()));
    if (named.length === 1) return named[0]!;
    const known = trusted.map((candidate) => path.basename(candidate)).sort().join(', ') || 'none';
    throw new Error(named.length ? `More than one trusted project is called ${reference}. Use its full path.` : `No trusted project matches ${reference}. Trusted projects: ${known}.`);
  }

  async startProjectRun(home: AgentHomeContext, input: ProjectRunRequest): Promise<string> {
    this.admitWork();
    await this.initialize();
    const { item: agent } = await this.repository.getAgent(home.agentId);
    if (!agent.enabled) throw new Error('Enable this Agent before it starts runs.');
    const projectPath = await this.resolveProject(input.project);
    this.host.assertAdmission?.(projectPath);
    if (this.active.size >= 4) throw new Error('Four Agent runs are already active. Wait for one to finish.');
    const model = agent.defaults.model ?? home.model;
    if (!model) throw new Error('Choose a model for this Agent before it starts runs.');
    const run = agentRunSchema.parse({ schemaVersion: 2, id: `${RUNS}:${randomUUID()}`, agentId: agent.id, agentRevision: agent.revision, routineId: null, projectPath,
      request: input.request, mode: input.mode, scheduledFor: Date.now(), startedAt: null, finishedAt: null, status: 'queued', sessionId: null, resultSummary: '', error: null,
      permission: effectivePermission(home.permission, agent.defaults.permission) });
    await this.serialize(agent.id, async () => {
      const ledger = this.ledger(agent.id);
      if (!await this.repository.ledgerJournal(agent.id).read(RUNS)) await ledger.create(RUNS, { anchor: Date.now(), intervalMs: 60_000, timeZone: 'UTC' });
      await ledger.admit(RUNS, run);
    });
    await this.launch(agent, run, model);
    this.changed({ agentId: agent.id, runId: run.id, status: 'running' });
    return `Started a ${input.mode === 'goal' ? 'goal' : 'run'} in ${path.basename(projectPath)} (${run.id}). Its result will be posted in this chat when it finishes.`;
  }

  private async launch(agent: AgentDefinition, run: AgentRun, model: { provider: string; id: string }): Promise<void> {
    const active: ActiveRun = { agent, run, handle: null, cancelled: false, timer: null, heartbeat: null, completion: null };
    this.active.set(run.id, active);
    try {
      await this.serialize(agent.id, () => this.ledger(agent.id).claim(RUNS, run.id, this.processId, Date.now()));
      active.heartbeat = setInterval(() => {
        if (this.active.get(run.id) !== active || active.cancelled) return;
        void this.serialize(agent.id, () => this.ledger(agent.id).heartbeat(RUNS, run.id, this.processId, Date.now())).catch(() => {
          if (this.active.get(run.id) !== active || active.cancelled) return;
          active.cancelled = true;
          void active.handle?.abort();
        });
      }, 20_000);
      active.heartbeat.unref?.();
      const preset: SavedAgentSession = { schemaVersion: 1, agentId: agent.id, revision: agent.revision, name: agent.name, instructions: agent.instructions, skillRefs: agent.skillRefs,
        defaults: { ...agent.defaults, model, permission: run.permission }, background: true, runId: run.id, projectPath: run.projectPath };
      const session = await new HomeOwnership(projectSessionDirectory(run.projectPath, this.host.sessionsRoot)).open({ agentId: agent.id, revision: agent.revision, instructions: agent.instructions, projectPath: run.projectPath, preset },
        { enabled: true, deleted: false, requirePreset: true }, randomUUID());
      const workspace = await this.host.workspace({ path: run.projectPath, name: path.basename(run.projectPath) });
      if (active.cancelled) throw new Error('The run was stopped before it started.');
      const handle = await workspace.startAgentRun({ sessionPath: session.file, sessionId: session.sessionId, request: run.request, mode: run.mode, permission: run.permission, timeLimitMs: RUN_LIMIT_MS },
        () => this.host.assertAdmission?.(run.projectPath, session.sessionId));
      active.handle = handle;
      await this.changeRun(agent.id, RUNS, run.id, (current) => ({ ...current, status: 'running', sessionId: handle.sessionId }));
      await this.repository.updateState(agent.id, (current) => ({ ...current, lastRunAt: Date.now() }));
      active.timer = setTimeout(() => { active.cancelled = true; void handle.abort(); }, RUN_LIMIT_MS);
      active.timer.unref?.();
      active.completion = handle.settled.then((outcome) => this.finish(active, outcome.failed, outcome.summary, outcome.error)).catch((error: unknown) => {
        this.changed({ agentId: agent.id, runId: run.id, status: 'needs-attention', message: `Run finalization requires recovery: ${failure(error)}` });
      });
    } catch (error) {
      this.stopTimers(active);
      this.active.delete(run.id);
      await this.changeRun(agent.id, RUNS, run.id, (current) => ({ ...current, status: 'failed', finishedAt: Date.now(), error: failure(error) })).catch(() => undefined);
      throw error;
    }
  }
  private stopTimers(active: ActiveRun): void {
    if (active.timer) clearTimeout(active.timer);
    if (active.heartbeat) clearInterval(active.heartbeat);
    active.timer = null;
    active.heartbeat = null;
  }

  private async finish(active: ActiveRun, failed: boolean, summary: string, error: string | null): Promise<void> {
    this.stopTimers(active);
    const { agent, run } = active;
    const stopped = active.cancelled;
    const reason = stopped ? 'The run was stopped.' : error ?? 'The run did not finish. Open its conversation to see why.';
    try {
      await this.changeRun(agent.id, RUNS, run.id, (current) => ({ ...current, status: stopped || failed ? 'failed' : 'succeeded', resultSummary: summary, error: stopped || failed ? reason : null, finishedAt: Date.now() }));
      const project = path.basename(run.projectPath);
      const text = stopped || failed
        ? `The run in ${project} failed: ${reason}\nRequest: ${run.request.slice(0, 1000)}${summary ? `\n\nLast reply:\n${summary}` : ''}`
        : `The run in ${project} finished.\nRequest: ${run.request.slice(0, 1000)}\n\nResult:\n${summary || 'No final reply.'}`;
      if (!this.stopping) await this.deliver(agent, { customType: 'fate-agent-run-result', text, details: { runId: run.id, projectPath: run.projectPath, sessionId: active.handle?.sessionId ?? null, failed: stopped || failed } }).catch(() => undefined);
      this.announce(agent.id, run.id, stopped || failed ? 'failed' : 'succeeded', stopped || failed ? `${agent.name}: run in ${project} failed.` : `${agent.name}: run in ${project} finished.`);
    } finally { this.active.delete(run.id); }
  }
  private announce(agentId: string, runId: string, status: AgentRun['status'], message: string, routine?: RoutineDefinition): void {
    const change = { agentId, runId, status, message };
    this.changed(routine?.notify === false ? { agentId, runId, status } : change);
    this.host.notify?.(change, routine?.osNotify ?? false);
  }
  private changeRun(agentId: string, ledgerId: string, runId: string, change: (run: AgentRun) => AgentRun): Promise<AgentRun> {
    return this.serialize(agentId, () => this.ledger(agentId).update(ledgerId, runId, change));
  }

  tick(now = Date.now()): Promise<void> {
    this.ticking ??= this.scan(now).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async scan(now: number): Promise<void> {
    this.nextWakeAt = Infinity;
    if (this.stopping) return;
    await this.initialize();
    const library = await this.repository.list();
    if (library.diagnostics.length) {
      this.nextWakeAt = Date.now() + ROUTINE_RETRY_MS;
      return;
    }
    let wake = Infinity;
    for (const routine of library.routines.filter((item) => item.enabled)) {
      const agent = library.agents.find((item) => item.id === routine.agentId);
      if (!agent?.enabled) continue;
      const ledger = this.ledger(agent.id);
      await this.serialize(agent.id, () => ledger.configure(routine.id, this.schedule(routine, routine.createdAt), routine.revision, library.revisions[`routine:${routine.id}`]!.digest));
      const homePath = this.repository.homePath(agent.id);
      const admitted = await this.serialize(agent.id, () => ledger.tick(routine.id, now, (id, scheduledFor, status) => agentRunSchema.parse({ schemaVersion: 2, id, agentId: agent.id, agentRevision: agent.revision,
        routineId: routine.id, projectPath: homePath, request: routine.message, mode: 'turn', scheduledFor, startedAt: null, finishedAt: status === 'skipped' ? Date.now() : null, status,
        sessionId: null, resultSummary: '', error: status === 'skipped' ? 'Missed while Fate UI was closed or asleep, or the last message is unresolved; not replayed.' : null, permission: agent.defaults.permission })));
      if (admitted?.payload && admitted.status === 'queued') await this.deliverRoutine(agent, routine, admitted.payload);
      else if (admitted?.payload) this.changed({ agentId: agent.id, runId: admitted.id, status: 'skipped' });
      wake = Math.min(wake, (await ledger.read(routine.id)).state.nextDue);
    }
    this.nextWakeAt = wake === Infinity ? Infinity : Math.max(wake, Date.now() + 1_000);
  }
  private async deliverRoutine(agent: AgentDefinition, routine: RoutineDefinition, run: AgentRun): Promise<void> {
    try {
      const sessionId = await this.deliver(agent, { customType: 'fate-agent-routine', text: `Routine "${routine.name}":\n${routine.message}`, details: { routineId: routine.id, runId: run.id } });
      const now = Date.now();
      await this.changeRun(agent.id, routine.id, run.id, (current) => ({ ...current, status: 'succeeded', startedAt: now, finishedAt: now, sessionId }));
      this.announce(agent.id, run.id, 'succeeded', `${agent.name}: ${routine.name} started.`, routine);
    } catch (error) {
      await this.changeRun(agent.id, routine.id, run.id, (current) => ({ ...current, status: 'failed', finishedAt: Date.now(), error: failure(error) })).catch(() => undefined);
      this.announce(agent.id, run.id, 'failed', `${agent.name}: ${routine.name} could not start. ${failure(error)}`, routine);
    }
  }

  private async findRun(runId: string): Promise<{ run: AgentRun; ledgerId: string }> {
    const ledgerId = runId.split(':')[0]!;
    for (const agent of (await this.repository.list()).agents) {
      if (!(await this.repository.ledgerJournal(agent.id).ids(501)).includes(ledgerId)) continue;
      const run = (await this.ledger(agent.id).read(ledgerId)).state.runs.find((entry) => entry.id === runId)?.payload;
      if (run) return { run, ledgerId };
    }
    throw new Error('This run is no longer retained.');
  }
  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active) { active.cancelled = true; await active.handle?.abort(); }
    else {
      const { run, ledgerId } = await this.findRun(runId);
      if (['queued', 'running', 'needs-attention'].includes(run.status)) await this.changeRun(run.agentId, ledgerId, run.id, (current) => ({ ...current, status: 'failed', finishedAt: Date.now(), error: 'Uncertain run dismissed without replaying any action.' }));
    }
    this.changed({ runId });
  }
  async runSession(runId: string): Promise<{ projectPath: string; sessionId: string; agentId: string; routine: boolean }> {
    const { run } = await this.findRun(runId);
    if (!run.sessionId) throw new Error('This run did not create a conversation.');
    return { projectPath: run.projectPath, sessionId: run.sessionId, agentId: run.agentId, routine: run.routineId !== null };
  }

  /** Read-only listing of retired Automation documents for the Legacy Import view. */
  async listLegacy(): Promise<LegacyImportItem[]> {
    const projectPath = this.host.currentProjectPath();
    if (!projectPath || !this.legacy) return [];
    const routines = (await this.repository.list()).routines;
    return (await this.legacy.list(projectPath)).map((source) => {
      try {
        const copy = previewAutomationCopy(JSON.stringify(source));
        return { sourceId: source.id, sourceDigest: copy.sourceDigest, name: source.name, prompt: source.prompt, existingRoutineId: routines.find((routine) => routine.automationSourceId === source.id)?.id ?? null };
      } catch (error) { return { sourceId: source.id, sourceDigest: '', name: source.name, prompt: source.prompt, existingRoutineId: null, error: failure(error) }; }
    });
  }
  async copyAutomation(automationId: string, sourceDigest: string, agentId: string): Promise<RoutineDefinition> {
    this.admitWork();
    return this.serialize(`copy:${automationId}`, async () => {
      const item = (await this.listLegacy()).find((candidate) => candidate.sourceId === automationId);
      if (!item) throw new Error('This old Automation is not in the current project.');
      if (item.sourceDigest !== sourceDigest) throw new Error('The old Automation changed. Review it again before copying.');
      if (item.existingRoutineId) return (await this.repository.getRoutine(item.existingRoutineId)).item;
      const routine = await this.repository.saveRoutine({ expected: null, value: { name: item.name.slice(0, 80), agentId, message: item.prompt, intervalMinutes: 1440,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: false, notify: true, osNotify: false } }, automationId);
      this.changed({ agentId });
      return routine;
    });
  }
}
