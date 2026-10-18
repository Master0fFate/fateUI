import { getDesktopApi, getDesktopApiOptional } from '../platform/api';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AgentDefinition, AgentDraft, AgentInboxItem, AgentInboxOverview, AgentLibrary, LegacyImportItem, RoutineDefinition, RoutineDraft, WatchDefinition, WatchDraft } from '../../shared/contracts/agents';
import { useRuntimeStore } from './runtimeStore';
import { useUiStore } from './uiStore';

export const emptyAgentLibrary = (): AgentLibrary => ({ agents: [], routines: [], runs: [], states: [], diagnostics: [], revisions: {}, nextDue: {}, watches: [], watchStates: [] });
export const emptyAgentInbox = (): AgentInboxOverview => ({ items: [], unread: {}, muted: [] });
export const agentDraft = ({ name, description, instructions, skillRefs, defaults, enabled, google, tone, avatar }: AgentDefinition): AgentDraft => ({ name, description, instructions, skillRefs, defaults, enabled, google, tone: tone ?? '', avatar: avatar ?? '' });
export const agentLabel = ({ name, avatar }: { name: string; avatar?: string | undefined }): string => avatar ? `${avatar} ${name}` : name;
export const routineDraft = ({ name, agentId, message, intervalMinutes, timeZone, enabled, notify, osNotify }: RoutineDefinition): RoutineDraft => ({ name, agentId, message, intervalMinutes, timeZone, enabled, notify, osNotify });
export const watchDraft = ({ name, agentId, url, condition, text, price, intervalMinutes, enabled }: WatchDefinition): WatchDraft => ({ name, agentId, url, condition, text, price, intervalMinutes, enabled });
export function agentError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed.message === 'string') return parsed.message; } catch { /* Plain errors need no decoding. */ }
  return text;
}
interface AgentsState {
  library: AgentLibrary;
  inbox: AgentInboxOverview;
  legacy: LegacyImportItem[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  editing: string | null;
  load: () => Promise<void>;
  loadInbox: () => Promise<void>;
  markRead: (input: { agentId?: string; itemIds?: string[] }) => Promise<void>;
  loadLegacy: () => Promise<void>;
  mutate: (operation: () => Promise<unknown>) => Promise<void>;
  edit: (agentId: string | 'new') => void;
}
let generation = 0;
let inboxGeneration = 0;
export const useAgentsStore = create<AgentsState>((set, get) => ({
  library: emptyAgentLibrary(), inbox: emptyAgentInbox(), legacy: [], loading: false, busy: false, error: null, editing: null,
  load: async () => {
    const current = ++generation;
    if (!getDesktopApiOptional()?.getAgentLibrary) return;
    void get().loadInbox();
    set({ loading: true, error: null });
    try {
      const library = await getDesktopApi().getAgentLibrary();
      if (current === generation) set({ library, loading: false });
    } catch (error) { if (current === generation) set({ error: agentError(error), loading: false }); }
  },
  loadInbox: async () => {
    const current = ++inboxGeneration;
    if (!getDesktopApiOptional()?.getAgentInbox) return;
    const inbox = await getDesktopApi().getAgentInbox().catch(() => null);
    if (inbox && current === inboxGeneration) set({ inbox });
  },
  markRead: async (input) => {
    if (!getDesktopApiOptional()?.markAgentInboxRead) return;
    await getDesktopApi().markAgentInboxRead(input).catch(() => undefined);
    await get().loadInbox();
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

export function useAgentInboxReads(): void {
  const agentId = useRuntimeStore((state) => state.runtime.project?.agentId ?? null);
  const unread = useAgentsStore((state) => agentId ? state.inbox.unread[agentId] ?? 0 : 0);
  useEffect(() => {
    if (!agentId || !unread) return;
    const read = () => { if (document.hasFocus()) void useAgentsStore.getState().markRead({ agentId }); };
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [agentId, unread]);
}
export const useAgentLabel = (agentId: string | null | undefined): string | null => useAgentsStore((state) => {
  const agent = agentId ? state.library.agents.find((item) => item.id === agentId) : undefined;
  return agent ? agentLabel(agent) : null;
});

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
    const unread = useAgentsStore.getState().inbox.items.filter((item) => item.runId === runId && item.readAt === null);
    if (unread.length) void useAgentsStore.getState().markRead({ agentId: unread[0]!.agentId, itemIds: unread.map((item) => item.id) });
  } catch (error) { useUiStore.getState().showToast({ kind: 'error', title: 'Agent run unavailable', message: agentError(error) }); }
}

export function openInboxItem(item: AgentInboxItem): Promise<void> {
  if (item.readAt === null) void useAgentsStore.getState().markRead({ agentId: item.agentId, itemIds: [item.id] });
  return item.source === 'run' && item.runId ? openAgentNotice(item.runId) : openAgent(item.agentId);
}
