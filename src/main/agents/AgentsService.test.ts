import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDraft, AgentRun } from '../../shared/contracts/agents';
import { LegacyAutomations, legacyDocumentPath } from '../automations/LegacyAutomations';
import { AgentRepository } from './AgentRepository';
import type { AgentMessage, AgentRunOutcome, AgentRunTarget } from './AgentRunTool';
import { AgentsService, type AgentsHost, type AgentWorkspace } from './AgentsService';

const roots: string[] = [];
const services: AgentsService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.dispose())); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const draft: AgentDraft = { name: 'Analyst', description: '', instructions: 'Agent system persona.', skillRefs: [], enabled: true, google: false, defaults: { model: { provider: 'test', id: 'model' }, thinkingLevel: 'high', permission: 'edit', workspace: 'shared' } };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-service-')));
  roots.push(root);
  const projectPath = path.join(root, 'project');
  await fs.mkdir(projectPath);
  const started: AgentRunTarget[] = [];
  const delivered: AgentMessage[] = [];
  const finish: Array<(outcome: AgentRunOutcome) => void> = [];
  const workspace: AgentWorkspace = {
    startAgentRun: vi.fn(async (target: AgentRunTarget, assertAdmission: () => void) => {
      assertAdmission();
      started.push(target);
      return { sessionId: target.sessionId, settled: new Promise<AgentRunOutcome>((resolve) => { finish.push(resolve); }), abort: vi.fn(async () => { finish.at(-1)?.({ failed: true, summary: '', error: null }); }) };
    }),
    deliverAgentMessage: vi.fn(async (_path: string, _id: string, message: AgentMessage) => { delivered.push(message); }),
    refreshAgentSession: vi.fn(async () => undefined),
  };
  const host: AgentsHost = {
    workspace: vi.fn(async () => workspace), liveWorkspace: () => workspace, trustedProjects: async () => [projectPath],
    currentModel: () => ({ provider: 'test', id: 'model' }), currentProjectPath: () => projectPath,
    sessionsRoot: path.join(root, 'sessions'), notify: vi.fn(),
  };
  const repository = new AgentRepository(path.join(root, 'data'));
  const automations = new LegacyAutomations({ write: vi.fn() }, path.join(root, 'automations'));
  const service = new AgentsService(host, repository, automations);
  services.push(service);
  const agent = await service.saveAgent({ expected: null, value: draft });
  const home = { agentId: agent.id, permission: 'edit' as const, model: null };
  return { root, projectPath, service, host, repository, automations, workspace, started, delivered, finish, agent, home };
}
async function settled(service: AgentsService, id: string): Promise<AgentRun> {
  let run: AgentRun | undefined;
  await vi.waitFor(async () => { run = (await service.list()).runs.find((item) => item.id === id); expect(['succeeded', 'failed']).toContain(run?.status); }, { timeout: 10_000 });
  return run!;
}
const runId = (text: string) => /\((runs:[^)]+)\)/u.exec(text)![1]!;

describe('Agents production service boundaries', { timeout: 15_000 }, () => {
  it('shares one monitor read across concurrent clients and retries after a read failure', async () => {
    const { service, projectPath, repository } = await fixture();
    await service.list();
    const list = vi.spyOn(repository, 'list');
    const results = await Promise.all(Array.from({ length: 24 }, () => service.monitorRuns(projectPath)));
    expect(list).toHaveBeenCalledTimes(1);
    expect(results.every((value) => value.runs.length === 0)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    list.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(service.monitorRuns(projectPath)).rejects.toThrow('synthetic read failure');
    await expect(service.monitorRuns(projectPath)).resolves.toMatchObject({ partial: false });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('opens one home chat in the Agent folder, keeps it across renames and blocks disabled Agents', async () => {
    const { service, agent, repository } = await fixture();
    const homes = await Promise.all([service.open(agent.id), service.open(agent.id)]);
    expect(homes[0]).toEqual(homes[1]);
    expect(homes[0]!.path).toBe(await fs.realpath(repository.homePath(agent.id)));
    const library = await service.list();
    await service.saveAgent({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { ...draft, name: 'Renamed', instructions: 'Changed persona.' } });
    expect((await service.open(agent.id)).sessionId).toBe(homes[0]!.sessionId);
    expect(await service.currentPreset({ schemaVersion: 1, agentId: agent.id, revision: 1, name: 'Analyst', instructions: 'Old.', skillRefs: [], defaults: draft.defaults, background: false, runId: null, projectPath: homes[0]!.path }))
      .toMatchObject({ name: 'Renamed', instructions: 'Changed persona.', revision: 2 });
    const updated = await service.list();
    await service.saveAgent({ id: agent.id, expected: updated.revisions[`agent:${agent.id}`]!, value: { ...draft, enabled: false } });
    await expect(service.open(agent.id)).rejects.toThrow(/Enable/);
    expect((await service.list()).states[0]?.homeSessionId).toBe(homes[0]!.sessionId);
  });

  it('starts a project run with the narrower permission and posts its result into the Agent chat', async () => {
    const { service, home, started, delivered, finish, projectPath } = await fixture();
    const reply = await service.startProjectRun({ ...home, permission: 'read-only' }, { project: 'project', request: 'Check the build.', mode: 'goal' });
    expect(started).toEqual([expect.objectContaining({ request: 'Check the build.', mode: 'goal', permission: 'read-only', timeLimitMs: 30 * 60_000 })]);
    finish[0]!({ failed: false, summary: 'Build is green.', error: null });
    expect(await settled(service, runId(reply))).toMatchObject({ status: 'succeeded', projectPath, permission: 'read-only', resultSummary: 'Build is green.' });
    await vi.waitFor(() => expect(delivered).toEqual([expect.objectContaining({ customType: 'fate-agent-run-result', text: expect.stringContaining('Build is green.') })]));
  });

  it('refuses unknown projects and storage-fenced runs before any session starts', async () => {
    const { service, home, host, started } = await fixture();
    await expect(service.startProjectRun(home, { project: 'elsewhere', request: 'x', mode: 'turn' })).rejects.toThrow(/Trusted projects: project/);
    host.assertAdmission = () => { throw new Error('STORAGE_UNAVAILABLE: recovery checkpoint failed.'); };
    await expect(service.startProjectRun(home, { project: 'project', request: 'x', mode: 'turn' })).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(started).toHaveLength(0);
  });

  it('stops an active run without replay and records it as failed', async () => {
    const { service, home, delivered } = await fixture();
    const id = runId(await service.startProjectRun(home, { project: 'project', request: 'Long task.', mode: 'turn' }));
    await service.cancel(id);
    expect(await settled(service, id)).toMatchObject({ status: 'failed', error: 'The run was stopped.' });
    await vi.waitFor(() => expect(delivered[0]?.text).toContain('failed: The run was stopped.'));
  });

  it('posts a due Routine into the Agent chat once, retaining its watermark on repeated ticks', async () => {
    const { service, agent, delivered } = await fixture();
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Schedule', agentId: agent.id, message: 'Check CI.', intervalMinutes: 1, timeZone: 'UTC', enabled: true, notify: false, osNotify: false } });
    const due = (await service.list()).nextDue[routine.id]!;
    await service.tick(due);
    await service.tick(due);
    const runs = (await service.list()).runs.filter((run) => run.routineId === routine.id);
    expect(runs).toEqual([expect.objectContaining({ status: 'succeeded', request: 'Check CI.' })]);
    expect(delivered).toEqual([expect.objectContaining({ customType: 'fate-agent-routine', text: 'Routine "Schedule":\nCheck CI.' })]);
  });

  it('does not post a scheduled occurrence after its Agent is disabled', async () => {
    const { service, agent, delivered } = await fixture();
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Schedule', agentId: agent.id, message: 'Check CI.', intervalMinutes: 1, timeZone: 'UTC', enabled: true, notify: false, osNotify: false } });
    const library = await service.list();
    await service.saveAgent({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { ...draft, enabled: false } });
    await service.tick((await service.list()).nextDue[routine.id]!);
    expect((await service.list()).runs).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it('copies legacy Automations into a disabled Routine once without modifying source bytes', async () => {
    const { service, automations, projectPath, root, agent } = await fixture();
    const source = {
      id: '00000000-0000-4000-8000-000000000111', projectPath, name: 'Original Automation', prompt: 'x'.repeat(200_000), permissionLevel: 'edit' as const,
      createdAt: 1, updatedAt: 2, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    const sourceFile = legacyDocumentPath(projectPath, path.join(root, 'automations'));
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, JSON.stringify({ version: 1, projectPath, automations: [source] }, null, 2) + '\n', 'utf8');
    const bytes = await fs.readFile(sourceFile);
    const [item] = await service.listLegacy();
    const copied = await service.copyAutomation(source.id, item!.sourceDigest, agent.id);
    expect((await service.copyAutomation(source.id, item!.sourceDigest, agent.id)).id).toBe(copied.id);
    expect(copied).toMatchObject({ message: source.prompt, enabled: false, agentId: agent.id, automationSourceId: source.id });
    expect((await service.listLegacy())[0]?.existingRoutineId).toBe(copied.id);
    expect(await fs.readFile(sourceFile)).toEqual(bytes);
    expect((await automations.list(projectPath))[0]).toEqual(source);
  });
});
