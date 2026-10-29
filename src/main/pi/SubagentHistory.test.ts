import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { PiEvent, SubagentRun } from '../../shared/contracts/ipc';
import { SubagentHistory } from './SubagentHistory';

const model = {
  provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 100_000,
  input: ['text'] as ('text' | 'image')[], api: 'test', baseUrl: 'https://example.test', maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const alternateModel = { ...model, provider: 'alternate', id: 'glm', name: 'Alternate GLM', contextWindow: 200_000 };

function runtime(models = [model, alternateModel]) {
  return {
    getAvailable: vi.fn(async () => models),
    getModel: vi.fn((provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id)),
  } as unknown as ModelRuntime;
}

function parentSession(messages: unknown[] = []) {
  return {
    sessionId: 'parent-1', model, thinkingLevel: 'medium', messages,
    sessionManager: { getBranch: () => [] },
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
  } as unknown as AgentSession;
}

function history(parent: AgentSession, options: { disabled?: string[]; emit?: (event: PiEvent) => void; persist?: (run: SubagentRun) => void } = {}) {
  return new SubagentHistory({
    resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
    ...(options.disabled ? { getDisabledModels: () => options.disabled! } : {}),
    emit: (_parent, event) => options.emit?.(event),
    persist: (_parent, run) => options.persist?.(run),
  });
}

function catalog(subject: SubagentHistory, modelRuntime: ModelRuntime, toolCallId: string, params: unknown) {
  return subject.createCatalogTool(modelRuntime).execute(toolCallId, params, undefined, undefined, { cwd: '/project', sessionManager: { getSessionId: () => 'parent-1' } } as never);
}

const modelInfo = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 100_000 };

function completedRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: 'run-completed', parentSessionId: 'parent-1', parentToolCallId: 'delegate-1', task: 'Inspect the project',
    role: 'scout', agentName: 'direct', agentSource: 'direct', permissionLevel: 'read-only', enabledTools: ['read', 'grep', 'find', 'ls'],
    skills: [], skillMode: 'all', preloadedSkills: [], status: 'completed', model: modelInfo, routingModels: [modelInfo], thinkingLevel: 'medium', executionMode: 'blocking',
    controlCount: 0, attempt: 1, maxAttempts: 1, mailbox: { state: 'disabled', ttlMs: 0, followUpCount: 0 }, notification: 'never',
    dependsOn: [], createdAt: 5, updatedAt: 9, endedAt: 9, messages: [], tools: [], result: 'Result for scout',
    omittedActivity: 0, transcriptTruncated: false, usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.01, contextTokens: 16, turns: 1 },
    ...overrides,
  } as SubagentRun;
}

describe('SubagentHistory', () => {
  it('catalogs authenticated models and reusable Pi agent selectors without exposing prompts', async () => {
    const result = await catalog(history(parentSession()), runtime(), 'catalog-1', {});
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/alternate\/glm[\s\S]*Capability contract/u) });
    const contract = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(contract).toMatch(/One canonical agent system:[\s\S]*spawn_agent fields:[\s\S]*agent_workflow-only controls:/u);
    expect(contract).toMatch(/no cap on agent count[\s\S]*32 KiB[\s\S]*stays readable after it is released[\s\S]*clamped/u);
    expect(contract).toMatch(/send_message[\s\S]*non-executable[\s\S]*followup_task[\s\S]*executable/u);
    expect(contract).toMatch(/isolated worktree files never transfer or integrate automatically[\s\S]*result-unavailable[\s\S]*never replayed/u);
    expect(contract).not.toMatch(/Agent Teams V2|legacy subagents|retarget|uncapped|subagent_start|subagent_manage|subagent_workflow/iu);
    const spawnFields = (contract.split('\n').find((line) => line.startsWith('spawn_agent fields:')) ?? '').split('It creates')[0]!;
    expect(spawnFields).not.toMatch(/timeoutSeconds|idleTimeoutSeconds|mailboxTtlSeconds|routing|budget|notifyParent/u);
    expect(result.details).toMatchObject({ kind: 'fate-subagent-catalog', version: 2 });
    expect(JSON.stringify(result.details)).not.toContain('Complete only the delegated task');
    expect(JSON.stringify(result.details)).not.toContain('example.test');
  });

  it('treats blank provider filters as unfiltered and reads live availability on every call', async () => {
    const subject = history(parentSession());
    const models = runtime();
    const first = await catalog(subject, models, 'before-logout', { section: 'models', provider: ' ' });
    expect(JSON.stringify(first.details)).toContain('alternate');
    vi.mocked(models.getAvailable).mockResolvedValue([]);
    const second = await catalog(subject, models, 'after-logout', { section: 'models' });
    expect(second.details).toMatchObject({ models: [] });
  });

  it('hides Fate-disabled models from the catalog', async () => {
    const result = await catalog(history(parentSession(), { disabled: ['alternate/glm'] }), runtime(), 'catalog-disabled', {});
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('test/model') });
    expect(JSON.stringify(result.details)).not.toContain('alternate/glm');
  });

  it('restores archived children as terminal history and allows only rename by handle', () => {
    const managed = completedRun({
      id: 'managed-before-restart', parentToolCallId: 'managed-start', task: 'Persist through restart', executionMode: 'managed',
      status: 'running', mailbox: { state: 'available', ttlMs: 120_000, expiresAt: 1, followUpCount: 2 }, updatedAt: 20,
      endedAt: undefined, result: undefined, error: 'stale provider metadata',
    });
    const parent = parentSession([
      {
        role: 'assistant', timestamp: 10, content: [
          { type: 'toolCall', id: 'delegate-1', name: 'subagent', arguments: { task: 'Inspect the project', role: 'scout', permission: 'read-only' } },
          { type: 'toolCall', id: 'unfinished', name: 'subagent', arguments: { task: 'Finish later', role: 'worker', permission: 'edit' } },
          { type: 'toolCall', id: 'managed-start', name: 'subagent_start', arguments: { task: 'Persist through restart', mailboxTtlSeconds: 120 } },
        ],
      },
      { role: 'toolResult', toolCallId: 'delegate-1', toolName: 'subagent', details: { kind: 'fate-subagent', version: 3, runIds: ['run-completed'], runs: [completedRun()] }, content: [{ type: 'text', text: 'done' }] },
      { role: 'toolResult', toolCallId: 'managed-start', toolName: 'subagent_start', details: { kind: 'fate-subagent', version: 3, runIds: [managed.id], runs: [managed] }, content: [{ type: 'text', text: 'launched' }] },
    ]);
    const events: PiEvent[] = [];
    const persisted: SubagentRun[] = [];
    const subject = history(parent, { emit: (event) => events.push(event), persist: (run) => persisted.push(run) });

    subject.restoreParent(parent);

    expect(subject.getRuns('parent-1').map((run) => run.status).sort()).toEqual(['completed', 'interrupted', 'interrupted']);
    const interrupted = subject.getRuns('parent-1').find((run) => run.task === 'Finish later');
    expect(interrupted).toMatchObject({ role: 'worker', status: 'interrupted', mailbox: { state: 'disabled' }, result: 'Fate UI restarted before this child run settled.' });
    expect(interrupted?.error).toBeUndefined();
    const restoredManaged = subject.getRuns('parent-1').find((run) => run.id === managed.id);
    expect(restoredManaged).toMatchObject({ status: 'interrupted', result: 'Fate UI restarted before this child run settled.', mailbox: { state: 'expired', ttlMs: 120_000, followUpCount: 2 } });
    expect(restoredManaged?.error).toBeUndefined();
    expect(restoredManaged?.timeoutAt).toBeUndefined();

    const handle = restoredManaged!.handle!;
    const renamed = subject.controlRun('parent-1', { action: 'rename', target: `@${handle}`, displayName: 'Boundary Analyst' });
    expect(renamed[0]).toMatchObject({ id: managed.id, handle, displayName: 'Boundary Analyst' });
    expect(subject.getRuns('parent-1').find((run) => run.id === managed.id)).toMatchObject({ handle, displayName: 'Boundary Analyst' });
    expect(events).toEqual([expect.objectContaining({ type: 'subagent.updated', runId: managed.id, displayName: 'Boundary Analyst' })]);
    expect(persisted).toEqual([expect.objectContaining({ id: managed.id, displayName: 'Boundary Analyst' })]);
    expect(() => subject.controlRun('parent-1', { action: 'followUp', target: `@${handle}`, message: 'Continue.' })).toThrow(/Only rename is available/u);
    expect(() => subject.controlRun('parent-1', { action: 'cancel', target: 'all' })).toThrow(/legacy execution cannot be reactivated/u);
  });
});
