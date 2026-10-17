import type { InlineExtension } from '@earendil-works/pi-coding-agent';

const DESCRIPTION_LIMIT = 160;
const MIN_SENTENCE = 60;

function shorten(description: string): string {
  const text = description.trim().replace(/\s+/g, ' ');
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const head = text.slice(0, DESCRIPTION_LIMIT);
  const sentence = /^.*[.!?](?=\s)/.exec(head)?.[0];
  return sentence && sentence.length >= MIN_SENTENCE ? sentence : `${head.trimEnd()}…`;
}

export function trimSkillDescriptions(prompt: string): string {
  return prompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/, (section) =>
    section.replace(/<description>([\s\S]*?)<\/description>/g, (_match, description: string) => `<description>${shorten(description)}</description>`));
}

export function createSkillPromptExtension(): InlineExtension {
  return {
    name: 'fate-skill-prompt',
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', (event) => {
        const systemPrompt = trimSkillDescriptions(event.systemPrompt);
        return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
      });
    },
  };
}
