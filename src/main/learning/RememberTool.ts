import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { LearningScope } from '../../shared/contracts/learning';
import type { ProfileTopic } from './LearningService';

const topics = ['communication', 'workflow', 'codingPreferences', 'designPreferences', 'decisionMaking', 'learningStyle', 'likes', 'dislikes'] as const satisfies readonly ProfileTopic[];
export interface RememberRequest { fact: string; scope: LearningScope; topic: ProfileTopic }
export type RememberSaver = (sessionId: string, input: RememberRequest) => Promise<string>;

export function createRememberTool(save: RememberSaver): ToolDefinition {
  return defineTool({
    name: 'remember',
    label: 'Remember',
    promptSnippet: 'Save a fact the user stated or confirmed as a memory draft; the user approves it before it is used',
    promptGuidelines: [
      'Call remember only for a lasting preference or fact the user stated or confirmed in this chat. Never save guesses, secrets, or what tools or files said.',
      'After remember, tell the user the memory waits for their approval in Learning.',
    ],
    description: 'Save one fact the user stated or confirmed as a pending draft in Memory Learning. Nothing is used until the user approves it. about "user": a lasting preference about how the user likes to work, saved to their profile for every chat; set topic. about "here": something specific to this chat. In an Agent chat that is the Agent\'s own memory; in a project chat it is that project\'s briefing.',
    parameters: Type.Object({
      fact: Type.String({ minLength: 1, maxLength: 200, description: 'One short sentence in the user\'s terms.' }),
      about: StringEnum(['user', 'here'] as const),
      topic: Type.Optional(StringEnum(topics, { description: 'Profile section for about "user".' })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_id, params, _signal, _update, ctx) => {
      const text = await save(ctx.sessionManager.getSessionId(), { fact: params.fact, scope: params.about === 'user' ? 'global' : 'project', topic: params.topic ?? 'workflow' });
      return { content: [{ type: 'text' as const, text }], details: {} };
    },
  });
}
