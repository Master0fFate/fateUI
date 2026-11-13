import type { InlineExtension } from '@earendil-works/pi-coding-agent';

export const HYP3RC0D3_CUSTOM_TYPE = 'fate-hyp3rc0d3';

interface SessionMode {
  enabled: boolean;
  revision: number;
  preparing: Set<symbol>;
}

const SESSIONS = new Map<string, SessionMode>();

export function hyp3rc0d3EntryEnabled(entry: unknown): boolean | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const value = entry as Record<string, unknown>;
  if (value.type !== 'custom' || value.customType !== HYP3RC0D3_CUSTOM_TYPE || !value.data || typeof value.data !== 'object') return undefined;
  const data = value.data as Record<string, unknown>;
  return data.version === 1 && typeof data.enabled === 'boolean' ? data.enabled : undefined;
}

export function readHyp3rc0d3Session(entries: readonly unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const enabled = hyp3rc0d3EntryEnabled(entries[index]);
    if (enabled !== undefined) return enabled;
  }
  return false;
}

export function hydrateHyp3rc0d3Session(sessionId: string, enabled: boolean): void {
  if (!SESSIONS.has(sessionId)) SESSIONS.set(sessionId, { enabled, revision: 0, preparing: new Set() });
}

export function isHyp3rc0d3(sessionId: string | null | undefined): boolean {
  return sessionId ? SESSIONS.get(sessionId)?.enabled === true : false;
}

export function setHyp3rc0d3Session(sessionId: string, enabled: boolean): void {
  hydrateHyp3rc0d3Session(sessionId, enabled);
  const state = SESSIONS.get(sessionId)!;
  state.revision += 1;
  state.preparing.clear();
  state.enabled = enabled;
}

export function prepareHyp3rc0d3Session(sessionId: string): { prepare(): void; commit(persist: () => void): void; cancel(): void } {
  hydrateHyp3rc0d3Session(sessionId, false);
  const state = SESSIONS.get(sessionId)!;
  const revision = state.revision;
  const token = Symbol();
  let cancelled = false;
  const current = () => !cancelled && SESSIONS.get(sessionId) === state && state.revision === revision;
  return {
    prepare() {
      if (current()) state.preparing.add(token);
    },
    commit(persist) {
      if (!current()) return;
      persist();
      state.enabled = true;
      state.preparing.delete(token);
      cancelled = true;
    },
    cancel() {
      cancelled = true;
      state.preparing.delete(token);
    },
  };
}

export function forgetHyp3rc0d3Session(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

function hyp3rc0d3Guidance(): string {
  return `Hyp3rc0d3 mode is on for this session.

Adapt the workflow to the task. Answer greetings, simple questions, and small bounded changes directly. For unfamiliar code, scout the relevant files, callers, installed versions, and current documentation first, then use the findings to stage a dependency graph for substantive work. Run independent work in parallel and sequence work that depends on earlier findings. Continue with new graphs when discoveries change the plan; a single upfront graph is not a requirement.

Use agent_workflow for coordinated graphs. If it is not declared, discover it with tool_search using query "agent_workflow". If delegation is unavailable in this session, continue useful work directly and explain the unavailable capability instead of stalling or claiming agents ran. Use the exact available agent and model catalog, choosing the agent, model, and effort appropriate to each task. Preserve the user's selected root effort. Follow the active Goal strategy and existing permission policy; give each node the authority it needs within that policy rather than silently narrowing it or bypassing it.

Each node brief must be self-contained: objective, relevant context, exact scope and file ownership, expected outcome, needed authority, and verification. Nodes do not see this conversation or each other's work automatically. Add dependsOn where a result is needed and set includeDependencyResults to true to deliver that result. Keep concurrent writes disjoint or order them explicitly.

Use existing collaboration tools to inspect progress, communicate findings, and reuse suitable agents. Use agent_workflow status for progress and agent_workflow results with workflowId, nodeIds, textOffset, and textLength to retrieve retained result text, including further ranges when needed. Keep intermediate dumps inside the workflow. Prefer notifyParent "immediate" for completion delivery unless the task calls for different timing. For delegated work call agent_workflow action finalize immediately before the final report, discovering it with tool_search if needed. Do not issue final completion until ready; collect and synthesize all required results and ranges, and recheck after further delegation. For wait use bounded wait_agent with stateOnly:true, not repeated status polling. For a blocked writer lease yield a brief progress-only turn and continue on automatic join. Review paused or unresolved work explicitly. Delayed notifications warrant a user update only for material changes, never repeated already-incorporated replies.

Integrate changes into the actual owning workspace using the available workspace tools; a child report or isolated checkout is not an integrated result. Review the combined outcome and run task-appropriate verification against the integrated work. Ask a focused question when a missing decision genuinely blocks safe progress. Finish with concise evidence of what changed, what verification showed, and any remaining blocker, not a transcript of node replies.`;
}

export function createHyp3rc0d3Extension(): InlineExtension {
  return {
    name: HYP3RC0D3_CUSTOM_TYPE,
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', (event, ctx) => {
        const state = SESSIONS.get(ctx.sessionManager.getSessionId());
        if (!state?.enabled && !state?.preparing.size) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${hyp3rc0d3Guidance()}\n` };
      });
    },
  };
}
