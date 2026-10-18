import { getDesktopApi, getDesktopApiOptional } from '../platform/api';
import { create } from 'zustand';
import type { AgentDefinition, AgentDraft, AgentLibrary, LegacyImportItem, RoutineDefinition, RoutineDraft, WatchDefinition, WatchDraft } from '../../shared/contracts/agents';
import { useRuntimeStore } from './runtimeStore';
import { useUiStore } from './uiStore';

export const emptyAgentLibrary = (): AgentLibrary => ({ agents: [], routines: [], runs: [], states: [], diagnostics: [], revisions: {}, nextDue: {}, watches: [], watchStates: [] });
export const agentDraft = ({ name, description, instructions, skillRefs, defaults, enabled }: AgentDefinition): AgentDraft => ({ name, description, instructions, skillRefs, defaults, enabled });
export const routineDraft = ({ name, agentId, message, intervalMinutes, timeZone, enabled, notify, osNotify }: RoutineDefinition): RoutineDraft => ({ name, agentId, message, intervalMinutes, timeZone, enabled, notify, osNotify });
export const watchDraft = ({ name, agentId, url, condition, text, price, intervalMinutes, enabled }: WatchDefinition): WatchDraft => ({ name, agentId, url, condition, text, price, intervalMinutes, enabled });
export function agentError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed.message === 'string') return parsed.message; } catch { /* Plain errors need no decoding. */ }
  return text;
}
interface AgentsState {
  library: AgentLibrary;
  legacy: LegacyImportItem[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  editing: string | null;
  load: () => Promise<void>;
  loadLegacy: () => Promise<void>;
  mutate: (operation: () => Promise<unknown>) => Promise<void>;
  edit: (agentId: string | 'new') => void;
}
let generation = 0;
export const useAgentsStore = create<AgentsState>((set, get) => ({
  library: emptyAgentLibrary(), legacy: [], loading: false, busy: false, error: null, editing: null,
  load: async () => {
    const current = ++generation;
    if (!getDesktopApiOptional()?.getAgentLibrary) return;
    set({ loading: true, error: null });
    try {
      const library = await getDesktopApi().getAgentLibrary();
      if (current === generation) set({ library, loading: false });
    } catch (error) { if (current === generation) set({ error: agentError(error), loading: false }); }
  },
  loadLegacy: async () => {
    if (!getDesktopApiOptional()?.listLegacyAutomations) return;
    try { set({ legacy: await getDesktopApi().listLegacyAutomations() }); }
    catch { set({ legacy: [] }); }
  },
  mutate: async (operation) => {
    if (get().busy) throw new Error('Wait for the current Agent operation.');
    set({ busy: true, error: null });
    try {
      await operation();
      await get().load();
    } catch (error) {
      set({ error: agentError(error) });
      throw error;
    } finally { set({ busy: false }); }
  },
  edit: (editing) => {
    set({ editing });
    useUiStore.getState().openSettingsSection('agent');
  },
}));

export async function openAgent(agentId: string): Promise<void> {
  try {
    useRuntimeStore.getState().setRuntime(await getDesktopApi().openAgentConversation({ agentId }));
    useUiStore.getState().setSidebarTab('agents');
    void useAgentsStore.getState().load();
  } catch (error) { useUiStore.getState().showToast({ kind: 'error', title: 'Agent unavailable', message: agentError(error) }); }
}

export async function openAgentNotice(runId: string): Promise<void> {
  try {
    useRuntimeStore.getState().setRuntime(await getDesktopApi().openAgentRunSession({ runId }));
    useUiStore.getState().setSidebarCollapsed(false);
  } catch (error) { useUiStore.getState().showToast({ kind: 'error', title: 'Agent run unavailable', message: agentError(error) }); }
}
