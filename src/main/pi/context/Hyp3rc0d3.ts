import { clampThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentSession, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '../../../shared/contracts/ipc';

type Hyp3rc0d3Model = NonNullable<AgentSession['model']>;

const ENABLED = new Set<string>();
const MAX_CONCURRENT_ENV = 'FATE_HYP3RC0D3_MAX_CONCURRENT_AGENTS';
const MAX_CHILDREN_ENV = 'FATE_HYP3RC0D3_MAX_CHILD_AGENTS';
const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_CHILDREN = 1_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function hyp3rc0d3MaxConcurrent(): number {
  return positiveIntFromEnv(MAX_CONCURRENT_ENV, DEFAULT_MAX_CONCURRENT);
}

export function hyp3rc0d3MaxChildren(): number {
  return positiveIntFromEnv(MAX_CHILDREN_ENV, DEFAULT_MAX_CHILDREN);
}

export function isHyp3rc0d3(sessionId: string | null | undefined): boolean {
  return sessionId ? ENABLED.has(sessionId) : false;
}

export function setHyp3rc0d3Session(sessionId: string, enabled: boolean): void {
  if (enabled) ENABLED.add(sessionId);
  else ENABLED.delete(sessionId);
}

export function forgetHyp3rc0d3Session(sessionId: string): void {
  ENABLED.delete(sessionId);
}

export function hyp3rc0d3ThinkingLevel(model: Hyp3rc0d3Model): ThinkingLevel {
  return clampThinkingLevel(model, 'xhigh');
}

function hyp3rc0d3Guidance(level: ThinkingLevel | null): string {
  const maxConcurrent = hyp3rc0d3MaxConcurrent();
  const maxChildren = hyp3rc0d3MaxChildren();
  const pinned = level && level !== 'off' ? ` Reasoning effort is pinned to ${level}, so spend that effort on structure rather than on length.` : '';
  return `Hyp3rc0d3 mode is on for this session.${pinned}

Plan before acting. Write a dependency graph whose nodes each own one bounded outcome, add an edge only where a node needs another node's result, and include the verification the work needs. Dispatch the graph with one agent_workflow call instead of describing the plan in this conversation or calling spawn_agent once per piece.

Every node brief must stand alone: the task, the areas or files in scope, the outcome you will accept, and how the node proves its own result. A node cannot see this conversation, your reasoning, or another node's work unless its brief says so.

Keep results inside the workflow. Read them with agent_workflow status, and rely on the graph-level notifyParent instead of copying node answers into this conversation.

When nodes write, keep their files disjoint: different files, different directories, or an explicit order in dependsOn. Two nodes touch the same file only when one depends on the other.

At most ${maxConcurrent} nodes run at a time and this session admits at most ${maxChildren} child agents in total. Set maxConcurrency within that, and continue a larger plan in further agent_workflow calls instead of raising either number.

Do not ask the user anything while the graph runs. If a node needs a decision its brief does not cover, end that node, finish the rest, and report the open question once at the end.`;
}

export function createHyp3rc0d3Extension(): InlineExtension {
  return {
    name: 'fate-hyp3rc0d3',
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', (event, ctx) => {
        if (!isHyp3rc0d3(ctx.sessionManager.getSessionId())) return undefined;
        const level = ctx.model ? hyp3rc0d3ThinkingLevel(ctx.model) : null;
        return { systemPrompt: `${event.systemPrompt}\n\n${hyp3rc0d3Guidance(level)}\n` };
      });
    },
  };
}
