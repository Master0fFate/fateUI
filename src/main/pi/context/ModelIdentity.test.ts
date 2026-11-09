import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, ExtensionHandler } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createModelIdentityExtension, modelIdentityLine, withModelIdentityLine } from './ModelIdentity';

describe('model identity prompt line', () => {
  it('names the model, its provider id and the effort on one line', () => {
    const line = modelIdentityLine('Misery: DeepSeek V4.1 Flash 1017', 'misery', 'deepseek-ai/DeepSeek-V4.1-Flash', 'max');

    expect(line).toBe('Running model: Misery: DeepSeek V4.1 Flash 1017 (misery/deepseek-ai/DeepSeek-V4.1-Flash), thinking effort max.');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('replaces an earlier identity line instead of stacking it', () => {
    const first = withModelIdentityLine('Base prompt.', modelIdentityLine('Model A', 'provider', 'model-a', 'low'));
    const second = withModelIdentityLine(first, modelIdentityLine('Model B', 'provider', 'model-b', 'max'));

    expect(second).toBe('Base prompt.\n\nRunning model: Model B (provider/model-b), thinking effort max.\n');
    expect(second.match(/Running model: /gu)).toHaveLength(1);
  });

  it('keeps an empty prompt to just the identity line', () => {
    expect(withModelIdentityLine('', modelIdentityLine('Model A', 'provider', 'model-a', 'off'))).toBe('Running model: Model A (provider/model-a), thinking effort off.\n');
  });

  it('writes the live model and effort into the session prompt', () => {
    const extension = createModelIdentityExtension();
    if (typeof extension === 'function' || !extension.factory) throw new Error('Expected an inline extension object.');
    let handler: ExtensionHandler<BeforeAgentStartEvent, { systemPrompt?: string }> | undefined;
    const api = {
      on: (event: string, registered: typeof handler) => { if (event === 'before_agent_start') handler = registered; return () => {}; },
      getThinkingLevel: () => 'max',
    } as unknown as ExtensionAPI;
    extension.factory(api);
    const event = { type: 'before_agent_start', systemPrompt: 'Base prompt.', systemPromptOptions: {} } as unknown as BeforeAgentStartEvent;
    const context = { model: { name: 'Misery: DeepSeek V4.1 Flash 1017', provider: 'misery', id: 'deepseek-ai/DeepSeek-V4.1-Flash' } } as unknown as ExtensionContext;

    expect(handler?.(event, context)).toEqual({ systemPrompt: 'Base prompt.\n\nRunning model: Misery: DeepSeek V4.1 Flash 1017 (misery/deepseek-ai/DeepSeek-V4.1-Flash), thinking effort max.\n' });
  });

  it('leaves the prompt alone when the session has no model yet', () => {
    const extension = createModelIdentityExtension();
    if (typeof extension === 'function' || !extension.factory) throw new Error('Expected an inline extension object.');
    let handler: ExtensionHandler<BeforeAgentStartEvent, { systemPrompt?: string }> | undefined;
    const api = {
      on: (event: string, registered: typeof handler) => { if (event === 'before_agent_start') handler = registered; return () => {}; },
      getThinkingLevel: () => 'off',
    } as unknown as ExtensionAPI;
    extension.factory(api);
    const event = { type: 'before_agent_start', systemPrompt: 'Base prompt.', systemPromptOptions: {} } as unknown as BeforeAgentStartEvent;

    expect(handler?.(event, { model: undefined } as unknown as ExtensionContext)).toBeUndefined();
  });
});
