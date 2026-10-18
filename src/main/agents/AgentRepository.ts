import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  agentDefinitionSchema, agentSaveSchema, agentStateSchema, routineDefinitionSchema, routineSaveSchema, watchDefinitionSchema, watchSaveSchema,
  type AgentDefinition, type AgentLibrary, type AgentSave, type AgentState, type RoutineDefinition, type RoutineSave, type WatchDefinition, type WatchSave,
} from '../../shared/contracts/agents';
import { fateDataRoot } from '../pi/FateProviderStorage';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';

type Kind = 'agent' | 'routine' | 'watch';
type Definition = AgentDefinition | RoutineDefinition | WatchDefinition;
type Expected = { revision: number; digest: string } | null;
interface Stored<T extends Definition> { item: T; snapshot: DefinitionSnapshot; journal: DefinitionJournal }
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const legacyRoutineSchema = z.object({
  id: z.string().uuid(), name: z.string(), agentId: z.string().uuid(), taskTemplateId: z.string().uuid(), intervalMinutes: z.number().int(),
  timeZone: z.string(), notify: z.boolean(), osNotify: z.boolean(), deleted: z.boolean(), projectPath: z.string(),
}).passthrough();

export class AgentRepository {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly root = path.join(fateDataRoot(), 'agents', 'v1')) {}

  homePath(agentId: string): string { return path.join(this.root, 'homes', z.string().uuid().parse(agentId)); }
  stateJournal(): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'states'), 2, this.root); }
  ledgerJournal(agentId: string): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'ledgers', z.string().uuid().parse(agentId)), 2, this.root); }
  watchStateJournal(): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'watch-states'), 2, this.root); }
  private journal(scope: string, kind: Kind | 'task'): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'definitions', scope, kind), undefined, this.root); }
  private routineJournal(): DefinitionJournal { return this.journal('global', 'routine'); }
  private watchJournal(): DefinitionJournal { return this.journal('global', 'watch'); }

  private async scopes(): Promise<string[]> {
    const entries = await fs.readdir(path.join(this.root, 'definitions'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && (entry.name === 'user' || /^[a-f0-9]{64}$/u.test(entry.name))).map((entry) => entry.name);
  }

  private decodeAgent(snapshot: DefinitionSnapshot, scope: string, id: string): AgentDefinition {
    const agent = agentDefinitionSchema.parse({ ...snapshot.metadata, instructions: snapshot.body });
    const owner = scope === 'user' ? agent.scope === 'user' && agent.projectPath === null : agent.scope === 'project' && agent.projectPath !== null && key(agent.projectPath) === scope;
    if (agent.id !== id || agent.revision !== snapshot.revision || !owner) throw new Error('Definition identity, revision or scope mismatch.');
    return agent;
  }
  private decodeRoutine(snapshot: DefinitionSnapshot, id: string): RoutineDefinition {
    const routine = routineDefinitionSchema.parse({ ...snapshot.metadata, message: snapshot.body });
    if (routine.id !== id || routine.revision !== snapshot.revision) throw new Error('Definition identity or revision mismatch.');
    return routine;
  }
  private decodeWatch(snapshot: DefinitionSnapshot, id: string): WatchDefinition {
    const watch = watchDefinitionSchema.parse(snapshot.metadata);
    if (watch.id !== id || watch.revision !== snapshot.revision) throw new Error('Definition identity or revision mismatch.');
    return watch;
  }

  async list(): Promise<AgentLibrary> {
    const library: AgentLibrary = { agents: [], routines: [], runs: [], states: [], diagnostics: [], revisions: {}, nextDue: {}, watches: [], watchStates: [] };
    const collect = async <T extends Definition>(kind: Kind, journal: DefinitionJournal, decode: (snapshot: DefinitionSnapshot, id: string) => T, target: T[]) => {
      const label = { agent: 'Agent', routine: 'Routine', watch: 'Watch' }[kind];
      let ids: string[];
      try { ids = await journal.ids(1000); }
      catch (error) { library.diagnostics.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return; }
      for (const id of ids) {
        try {
          const snapshot = await journal.read(id);
          if (!snapshot) throw new Error('Interrupted definition creation; recovery required.');
          const item = decode(snapshot, id);
          if (item.deleted) continue;
          target.push(item);
          library.revisions[`${kind}:${id}`] = { revision: snapshot.revision, digest: snapshot.digest };
        } catch (error) { library.diagnostics.push(`${label} ${id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    };
    try {
      for (const scope of await this.scopes()) await collect('agent', this.journal(scope, 'agent'), (snapshot, id) => this.decodeAgent(snapshot, scope, id), library.agents);
    } catch (error) { library.diagnostics.push(`Agents: ${error instanceof Error ? error.message : String(error)}`); }
    await collect('routine', this.routineJournal(), (snapshot, id) => this.decodeRoutine(snapshot, id), library.routines);
    await collect('watch', this.watchJournal(), (snapshot, id) => this.decodeWatch(snapshot, id), library.watches);
    if (new Set(library.agents.map((agent) => agent.id)).size !== library.agents.length) library.diagnostics.push('Agents have duplicated stable identities. Resolve the conflict before saving or running.');
    for (const agent of library.agents) {
      try { const state = await this.state(agent.id); if (state) library.states.push(state); }
      catch (error) { library.diagnostics.push(`Agent state ${agent.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return library;
  }

  async getAgent(id: string): Promise<Stored<AgentDefinition>> {
    z.string().uuid().parse(id);
    for (const scope of await this.scopes()) {
      const journal = this.journal(scope, 'agent');
      const snapshot = await journal.read(id);
      if (!snapshot) continue;
      const item = this.decodeAgent(snapshot, scope, id);
      if (item.deleted) throw new Error('This Agent was deleted. Its conversation and run history are retained.');
      return { item, snapshot, journal };
    }
    throw new Error('This Agent no longer exists.');
  }
  async getRoutine(id: string): Promise<Stored<RoutineDefinition>> {
    z.string().uuid().parse(id);
    const journal = this.routineJournal();
    const snapshot = await journal.read(id);
    if (!snapshot) throw new Error('This Routine no longer exists.');
    const item = this.decodeRoutine(snapshot, id);
    if (item.deleted) throw new Error('This Routine was deleted.');
    return { item, snapshot, journal };
  }
  async getWatch(id: string): Promise<Stored<WatchDefinition>> {
    z.string().uuid().parse(id);
    const journal = this.watchJournal();
    const snapshot = await journal.read(id);
    if (!snapshot) throw new Error('This Watch no longer exists.');
    const item = this.decodeWatch(snapshot, id);
    if (item.deleted) throw new Error('This Watch was deleted.');
    return { item, snapshot, journal };
  }

  private serialize<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(identity) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(identity, settled);
    void settled.then(() => { if (this.queues.get(identity) === settled) this.queues.delete(identity); });
    return result;
  }
  private catalog<T>(kind: Kind, operation: () => Promise<T>): Promise<T> {
    const catalog = new DefinitionJournal(path.join(this.root, 'catalog-locks'), undefined, this.root);
    const catalogKey = key(`global:${kind}`);
    return this.serialize(catalogKey, () => catalog.withLock(catalogKey, operation, { recoverDeadWriter: true }));
  }

  async saveAgent(input: AgentSave): Promise<AgentDefinition> {
    const { id, expected, value } = agentSaveSchema.parse(input);
    return this.catalog('agent', async () => {
      if (Boolean(id) !== Boolean(expected)) throw new Error('Updates require the exact revision and digest; creations cannot replace an existing definition.');
      const current = id ? await this.getAgent(id) : null;
      const library = await this.list();
      if (library.diagnostics.length) throw new Error('Resolve library diagnostics before saving; original records are preserved.');
      if (!id && library.agents.length >= 500) throw new Error('The library supports 500 Agents.');
      const identifier = id ?? randomUUID();
      if (library.agents.some((agent) => agent.id !== identifier && agent.name.toLocaleLowerCase() === value.name.toLocaleLowerCase())) throw new Error('An Agent with that name already exists.');
      const now = Date.now();
      const agent = agentDefinitionSchema.parse({ ...current?.item, ...value, schemaVersion: 1, id: identifier, scope: current?.item.scope ?? 'user', projectPath: current?.item.projectPath ?? null,
        revision: (current?.item.revision ?? 0) + 1, createdAt: current?.item.createdAt ?? now, updatedAt: now, deleted: false });
      const { instructions, ...metadata } = agent;
      await (current?.journal ?? this.journal('user', 'agent')).save(identifier, expected, { metadata, body: instructions });
      return agent;
    });
  }

  async saveRoutine(input: RoutineSave, automationSourceId: string | null = null): Promise<RoutineDefinition> {
    const { id, expected, value } = routineSaveSchema.parse(input);
    const agent = await this.getAgent(value.agentId);
    if (value.enabled && !agent.item.enabled) throw new Error('Enable the Agent before enabling this Routine.');
    return this.catalog('routine', async () => {
      const identifier = id ?? automationSourceId ?? randomUUID();
      if (Boolean(id) !== Boolean(expected)) throw new Error('Updates require the exact revision and digest; creations cannot replace an existing definition.');
      const current = id ? await this.getRoutine(id) : null;
      if (current && current.item.agentId !== value.agentId) throw new Error('A Routine cannot move to another Agent.');
      const library = await this.list();
      if (library.diagnostics.length) throw new Error('Resolve library diagnostics before saving; original records are preserved.');
      if (!id && library.routines.length >= 500) throw new Error('The library supports 500 Routines.');
      if (library.routines.some((routine) => routine.id !== identifier && routine.agentId === value.agentId && routine.name.toLocaleLowerCase() === value.name.toLocaleLowerCase())) throw new Error('This Agent already has a Routine with that name.');
      const now = Date.now();
      const routine = routineDefinitionSchema.parse({ ...current?.item, ...value, schemaVersion: 2, id: identifier, automationSourceId: current?.item.automationSourceId ?? automationSourceId,
        revision: (current?.item.revision ?? 0) + 1, createdAt: current?.item.createdAt ?? now, updatedAt: now, deleted: false });
      const { message, ...metadata } = routine;
      await this.routineJournal().save(identifier, expected, { metadata, body: message });
      return routine;
    });
  }

  async saveWatch(input: WatchSave): Promise<WatchDefinition> {
    const { id, expected, value } = watchSaveSchema.parse(input);
    const agent = await this.getAgent(value.agentId);
    if (value.enabled && !agent.item.enabled) throw new Error('Enable the Agent before turning on this Watch.');
    return this.catalog('watch', async () => {
      if (Boolean(id) !== Boolean(expected)) throw new Error('Updates require the exact revision and digest; creations cannot replace an existing definition.');
      const identifier = id ?? randomUUID();
      const current = id ? await this.getWatch(id) : null;
      if (current && current.item.agentId !== value.agentId) throw new Error('A Watch cannot move to another Agent.');
      const library = await this.list();
      if (library.diagnostics.length) throw new Error('Resolve library diagnostics before saving; original records are preserved.');
      if (!id && library.watches.length >= 500) throw new Error('The library supports 500 Watches.');
      if (library.watches.some((watch) => watch.id !== identifier && watch.agentId === value.agentId && watch.name.toLocaleLowerCase() === value.name.toLocaleLowerCase())) throw new Error('This Agent already has a Watch with that name.');
      const now = Date.now();
      const watch = watchDefinitionSchema.parse({ ...current?.item, ...value, schemaVersion: 1, id: identifier,
        revision: (current?.item.revision ?? 0) + 1, createdAt: current?.item.createdAt ?? now, updatedAt: now, deleted: false });
      await this.watchJournal().save(identifier, expected, { metadata: watch, body: '' });
      return watch;
    });
  }

  async remove(kind: Kind, id: string, expected: NonNullable<Expected>): Promise<void> {
    const { item, snapshot, journal } = kind === 'agent' ? await this.getAgent(id) : kind === 'routine' ? await this.getRoutine(id) : await this.getWatch(id);
    await journal.save(id, expected, { metadata: { ...snapshot.metadata, deleted: true, enabled: false, revision: item.revision + 1, updatedAt: Date.now() }, body: snapshot.body });
  }

  async migrateLegacyRoutines(): Promise<void> {
    for (const scope of (await this.scopes()).filter((name) => name !== 'user')) {
      const legacy = this.journal(scope, 'routine');
      for (const id of await legacy.ids(1000)) {
        const snapshot = await legacy.read(id);
        if (!snapshot || snapshot.metadata.schemaVersion !== 1) continue;
        const routine = legacyRoutineSchema.parse(snapshot.metadata);
        if (routine.deleted) continue;
        if (!await this.routineJournal().read(id)) {
          const task = await this.journal(scope, 'task').read(routine.taskTemplateId) ?? await this.journal('user', 'task').read(routine.taskTemplateId);
          const agent = await this.getAgent(routine.agentId).catch(() => null);
          if (task && agent) {
            await this.saveRoutine({ expected: null, value: { name: routine.name, agentId: routine.agentId, message: task.body, intervalMinutes: routine.intervalMinutes,
              timeZone: routine.timeZone, enabled: false, notify: routine.notify, osNotify: routine.osNotify } }, id);
          }
        }
        await legacy.save(id, snapshot, { metadata: { ...snapshot.metadata, deleted: true, enabled: false, revision: snapshot.revision + 1, updatedAt: Date.now() }, body: snapshot.body });
      }
    }
  }

  async withHomeLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    z.string().uuid().parse(agentId);
    // A crashed app may leave this cross-process ownership lock behind. Only
    // recover a same-host lock after exact byte re-read and proven-dead PID;
    // unknown/malformed records remain manual-recovery failures.
    return new DefinitionJournal(path.join(this.root, 'home-locks'), undefined, this.root).withLock(agentId, operation, { recoverDeadWriter: true });
  }

  async state(agentId: string): Promise<AgentState | null> {
    z.string().uuid().parse(agentId);
    const saved = await this.stateJournal().read(agentId);
    if (!saved) return null;
    const state = agentStateSchema.parse(saved.metadata);
    if (state.agentId !== agentId || state.revision !== saved.revision) throw new Error('Agent state ownership conflict.');
    return state;
  }

  async updateState(agentId: string, change: (state: AgentState) => AgentState): Promise<AgentState> {
    return this.serialize(`state:${agentId}`, async () => {
      const journal = this.stateJournal();
      const snapshot = await journal.read(agentId);
      const state = snapshot ? agentStateSchema.parse(snapshot.metadata) : { schemaVersion: 1 as const, agentId, revision: 0, homeSessionId: null, homeProjectPath: null, appliedRevision: 0, lastOpenedAt: null, lastRunAt: null };
      const next = agentStateSchema.parse({ ...change(state), revision: state.revision + 1 });
      if (next.agentId !== agentId || state.homeSessionId && next.homeProjectPath === state.homeProjectPath && next.homeSessionId !== state.homeSessionId) throw new Error('Agent state owner cannot change.');
      await journal.save(agentId, snapshot, { metadata: next, body: '' });
      return next;
    });
  }
}
