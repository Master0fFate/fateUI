import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, createSyntheticSourceInfo, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeToolsForPermission, createProjectConfinedTools } from '../pi/PiToolPolicy';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('D0-02 real Pi SDK feasibility (no provider requests)', () => {
  it('keeps Agent instructions in system context and the exact TaskTemplate as a user message', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-sdk-')));
    roots.push(root);
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json'), modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey('anthropic', 'local-fixture-no-provider-request');
    const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
    if (!model) throw new Error('Required local model fixture unavailable.');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const skillPath = path.join(root, 'SKILL.md');
    await fs.writeFile(skillPath, '# Method\nRead carefully.');
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      systemPromptOverride: () => 'System baseline.',
      appendSystemPromptOverride: () => ['Agent persona: deliberate review.'],
      skillsOverride: () => ({ skills: [{ name: 'method', description: 'Careful review method', filePath: skillPath, baseDir: root, sourceInfo: createSyntheticSourceInfo(skillPath, { source: 'sdk' }), disableModelInvocation: false }], diagnostics: [] }),
    });
    await loader.reload();
    const tools = await createProjectConfinedTools(root, { fullAccess: false });
    const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, thinkingLevel: 'high', resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: ['read'], customTools: tools as unknown as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['customTools']> });
    const task = '/command @live ~saved\nTask payload, not instructions.';
    let observedSystem = '';
    let observedUser: unknown;
    const stream = vi.fn<typeof session.agent.streamFunction>((requestedModel, context) => {
      observedSystem = getCurrentSystemPrompt(context.messages);
      observedUser = context.messages.find((message) => message.role === 'user');
      const events = createAssistantMessageEventStream();
      const response: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Local test response.' }], api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      events.push({ type: 'done', reason: 'stop', message: response });
      events.end(response);
      return events;
    });
    session.agent.streamFunction = stream;
    try {
      expect(session.model?.id).toBe(model.id);
      expect(session.thinkingLevel).toBe('high');
      expect(session.getActiveToolNames()).toEqual(['read']);
      expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(['method']);
      await session.prompt(task, { expandPromptTemplates: false });
      expect(stream).toHaveBeenCalledOnce();
      expect(observedSystem).toContain('Agent persona: deliberate review.');
      expect(observedSystem).not.toContain(task);
      expect(observedUser).toMatchObject({ role: 'user', content: [{ type: 'text', text: task }] });
      expect(session.messages.some((message) => message.role === 'assistant')).toBe(true);
    } finally { session.dispose(); }
  });

  it('proves ordinary root Read only is not a background effect boundary', () => {
    const enabled = activeToolsForPermission(['write', 'edit', 'bash', 'browser_click', 'third_party_effect'], 'read-only');
    expect(enabled).toContain('browser_click');
    expect(enabled).toContain('third_party_effect');
    expect(activeToolsForPermission(['generate_image'], 'read-only')).toContain('generate_image');
    expect(enabled).not.toContain('write');
  });
});
