import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { FatePaths } from '../../src/core/FatePaths';
import { createGoalHandlers, createScopedGoalHandlers } from '../../src/core/handlers/goalHandlers';
import { createTaskHandlers, createScopedTaskHandlers } from '../../src/core/handlers/taskHandlers';
import { createAgentHandlers, createScopedAgentHandlers } from '../../src/core/handlers/agentHandlers';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'goal-agents-')); roots.push(root);
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await mkdir(a); await mkdir(b);
  const adapter = new FakePiSdkAdapter();
  const client = createLocalIpcContext({ principalId: '099981d4-a8f7-414d-8feb-f9d4b4a91aa5', clientId: 'bacdd2b3-3c8e-4c1f-9832-f1ae91e67eda', expiresAt: Date.now() + 60_000 });
  const members = new Set<string>();
  const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }),
    workspaceRegistration: { isRegistered: (canonical) => canonical === a || canonical === b },
    workspaceMembership: (identity, id) => identity === client && members.has(id) });
  await core.runtime.openProject({ path: a, name: 'A', trusted: true });
  const service = core.runtime.getFocused();
  const handle = await core.workspaces!.registerHostPath(a);
  members.add(handle.id);
  const rootSessionId = service.getState(false).sessionId!;
  let permission = true, controlGeneration = 1;
  const authorize = () => {
    core.workspaces!.resolve(client, handle.id, handle.generation);
    return { currentGeneration: handle.generation, controlGeneration, permission };
  };
  const selection = handle.admission.snapshot();
  const command = { workspaceGeneration: handle.generation, expectedSessionId: selection.selectedSessionId,
    selectionRevision: selection.selectionRevision, controlGeneration: 1 };
  return { a, b, adapter, core, service, handle, rootSessionId, members, authorize, command,
    revoke: () => { permission = false; }, revokeControl: () => { controlGeneration = 2; },
    dispose: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('T17 canonical goal, task, Team and monitor handlers', () => {
  it('keeps ordinary task completion distinct from verified GoalMax evidence and delegates to the canonical service', async () => {
    const f = await fixture();
    try {
      const task = createScopedTaskHandlers(f.handle, f.authorize);
      const create = vi.spyOn(f.service, 'createTask');
      const list = await task.create(f.command, { title: 'First task', detail: 'Test the boundary', status: 'done', required: true });
      expect(create).toHaveBeenCalledOnce();
      expect(list.tasks[0]).toMatchObject({ status: 'done', verified: false, source: 'user', required: true });
      expect((await task.get())?.tasks[0]?.verified).toBe(false);
      const goal = createGoalHandlers(f.service);
      expect(await goal.get({})).toBeNull();
      await expect(goal.create({ objective: '' })).rejects.toThrow();
    } finally { await f.dispose(); }
  });

  it('keeps A captured after desktop focuses B, and denies a foreign-root dashboard read', async () => {
    const f = await fixture();
    try {
      const scoped = createScopedAgentHandlers(f.handle, f.authorize, f.rootSessionId);
      await f.core.runtime.openProject({ path: f.b, name: 'B', trusted: true });
      const bSessionId = f.core.runtime.getFocused().getState(false).sessionId!;
      const own = await scoped.monitor({ section: 'overview', limit: 2 });
      expect(own).toMatchObject({ projectPath: f.a, sessionId: f.rootSessionId, limit: 2 });
      expect(own.items.length).toBeLessThanOrEqual(2);
      await expect(createScopedAgentHandlers(f.handle, f.authorize, bSessionId).monitor({})).rejects.toThrow(/root session/);
      f.members.clear();
      await expect(scoped.monitor({})).rejects.toThrow();
    } finally { await f.dispose(); }
  });

  it('rejects a queued Team/worktree mutation on revoked permission or control and a stale selection before calling the executor', async () => {
    const f = await fixture();
    try {
      const team = vi.spyOn(f.service, 'controlAgentTeam');
      const handlers = createScopedAgentHandlers(f.handle, f.authorize, f.rootSessionId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = f.handle.admission.run(f.command, f.authorize, async () => { await gate; });
      await Promise.resolve();
      const pending = handlers.controlTeam(f.command, { action: 'workspace', target: 'node-1', operation: 'integrate', expectedSourceHead: 'a'.repeat(40), expectedTargetHead: 'b'.repeat(40) });
      f.revoke(); release(); await first;
      await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
      expect(team).not.toHaveBeenCalled();
      f.revokeControl();
      await expect(handlers.controlTeam(f.command, { action: 'interrupt', target: 'node-1' })).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      expect(team).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('rejects a stale selection before any goal or task mutation and refuses untrusted reads', async () => {
    const f = await fixture();
    try {
      const goal = vi.spyOn(f.service, 'controlGoalMax');
      const task = vi.spyOn(f.service, 'createTask');
      await f.service.newSession(); // Legacy desktop selection until T19.
      await expect(createScopedGoalHandlers(f.handle, f.authorize).control(f.command, { action: 'pause' })).rejects.toMatchObject({ code: 'STALE_SESSION' });
      await expect(createScopedTaskHandlers(f.handle, f.authorize).create(f.command, { title: 'Wrong session' })).rejects.toMatchObject({ code: 'STALE_SESSION' });
      expect(goal).not.toHaveBeenCalled();
      expect(task).not.toHaveBeenCalled();
      await f.service.openProject({ path: f.a, name: 'A', trusted: false });
      await expect(createScopedTaskHandlers(f.handle, f.authorize).get()).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
      await expect(createScopedAgentHandlers(f.handle, f.authorize, f.rootSessionId).monitor({})).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
    } finally { await f.dispose(); }
  });

  it('retains Team review, expected heads, and stop-failure results instead of fabricating success', async () => {
    const f = await fixture();
    try {
      const input = { action: 'workspace' as const, target: 'node-1', operation: 'integrate' as const,
        expectedSourceHead: 'a'.repeat(40), expectedTargetHead: 'b'.repeat(40) };
      const delegate = vi.spyOn(f.service, 'controlAgentTeam').mockRejectedValue(new Error('Expected heads must exactly match the retained review.'));
      await expect(createAgentHandlers(f.service).controlTeam(input)).rejects.toThrow(/retained review/);
      expect(delegate).toHaveBeenCalledWith(input);
      delegate.mockRejectedValueOnce(new Error('turn still owns its writer lease'));
      await expect(createAgentHandlers(f.service).controlTeam({ action: 'close', target: 'node-1', force: true })).rejects.toThrow(/writer lease/);
      expect(delegate).toHaveBeenCalledTimes(2);
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('refuses a paused workflow activation on a read and does not grant child authority from payload', async () => {
    const f = await fixture();
    try {
      const handlers = createScopedAgentHandlers(f.handle, f.authorize, f.rootSessionId);
      const control = vi.spyOn(f.service, 'controlAgentTeam');
      const startingPermission = f.service.getState(false).permissionLevel;
      const dashboard = await handlers.monitor({});
      expect(dashboard.sources.teams).toBe('ready');
      expect(control).not.toHaveBeenCalled();
      await expect(handlers.controlTeam(f.command, { action: 'resumeTeam', teamId: 'not-owned', callerNodeId: 'foreign' })).rejects.toThrow();
      expect(control).not.toHaveBeenCalled();
      const goals = createScopedGoalHandlers(f.handle, f.authorize);
      const tasks = createScopedTaskHandlers(f.handle, f.authorize);
      await expect(goals.create(f.command, { objective: 'Try', permissionLevel: 'full-access' })).rejects.toThrow();
      await expect(tasks.create(f.command, { title: 'Try', source: 'goalmax' })).rejects.toThrow();
      expect(f.service.getState(false).permissionLevel).toBe(startingPermission);
    } finally { await f.dispose(); }
  });
});
