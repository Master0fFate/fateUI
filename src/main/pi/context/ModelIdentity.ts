import type { InlineExtension } from '@earendil-works/pi-coding-agent';

const LINE_PREFIX = 'Running model: ';
const LINE_PATTERN = /^Running model: .*$/gmu;

export function modelIdentityLine(name: string, provider: string, id: string, effort: string): string {
  return `${LINE_PREFIX}${name} (${provider}/${id}), thinking effort ${effort}.`;
}

export function withModelIdentityLine(prompt: string, line: string): string {
  const body = prompt.replace(LINE_PATTERN, '').replace(/\n{3,}/gu, '\n\n').trimEnd();
  return body ? `${body}\n\n${line}\n` : `${line}\n`;
}

export function createModelIdentityExtension(): InlineExtension {
  return {
    name: 'fate-model-identity',
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', (event, ctx) => {
        const model = ctx.model;
        if (!model) return undefined;
        const systemPrompt = withModelIdentityLine(event.systemPrompt, modelIdentityLine(model.name, model.provider, model.id, pi.getThinkingLevel()));
        return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
      });
    },
  };
}
