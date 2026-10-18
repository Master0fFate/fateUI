import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentPermission } from '../../shared/contracts/agents';
import { CAPABILITIES_TOOL_NAME } from './AgentCapabilities';

export const AGENT_HOME_TOOL_NAMES: ReadonlySet<string> = new Set(['run_in_project', CAPABILITIES_TOOL_NAME]);
export interface ProjectRunRequest { project: string; request: string; mode: 'turn' | 'goal' }
export type ProjectRunStarter = (sessionId: string, input: ProjectRunRequest) => Promise<string>;
export interface AgentHomeContext { agentId: string; permission: AgentPermission; model: { provider: string; id: string } | null }
export type AgentRunStarter = (home: AgentHomeContext, input: ProjectRunRequest) => Promise<string>;
export interface AgentRunTarget { sessionPath: string; sessionId: string; request: string; mode: 'turn' | 'goal'; permission: AgentPermission; timeLimitMs: number }
export interface AgentRunOutcome { failed: boolean; summary: string; error: string | null }
export interface AgentRunHandle { sessionId: string; settled: Promise<AgentRunOutcome>; abort(): Promise<void> }
export interface AgentMessage { customType: 'fate-agent-run-result' | 'fate-agent-routine' | 'fate-agent-watch'; text: string; details: Record<string, unknown> }

export function createRunInProjectTool(start: ProjectRunStarter): ToolDefinition {
  return defineTool({
    name: 'run_in_project',
    label: 'Run in project',
    promptSnippet: 'Start background work in a trusted project; its result is posted back to this chat',
    description: 'Start a background conversation in one of the user\'s trusted projects, with your instructions and permission. It returns at once; when the run finishes, its result is posted into this chat. Use mode "goal" for a multi-step outcome that should be checked before it counts as done, "turn" for a single request. Name the project by folder name or absolute path.',
    parameters: Type.Object({
      project: Type.String({ minLength: 1, maxLength: 4096, description: 'Trusted project folder name or absolute path.' }),
      request: Type.String({ minLength: 1, maxLength: 200_000, description: 'What to do in that project.' }),
      mode: Type.Optional(StringEnum(['turn', 'goal'] as const)),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_id, params, _signal, _update, ctx) => {
      const text = await start(ctx.sessionManager.getSessionId(), { project: params.project, request: params.request, mode: params.mode ?? 'turn' });
      return { content: [{ type: 'text' as const, text }], details: {} };
    },
  });
}
