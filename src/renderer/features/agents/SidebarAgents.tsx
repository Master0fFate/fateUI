import * as Popover from '@radix-ui/react-popover';
import { Bell, BellDot, BellOff, BellRing, Bot, MoreHorizontal, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentDefinition, AgentInboxItem, AgentLibrary } from '../../../shared/contracts/agents';
import { AppTooltip } from '../../components/AppTooltip';
import { formatRelativeTime } from '../../lib/relativeTime';
import { getDesktopApi } from '../../platform/api';
import { useSkinComponents } from '../../skins/SkinProvider';
import { agentDraft, agentError, agentLabel, openAgent, useAgentsStore } from '../../stores/agentsStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { AgentInboxPanel } from './AgentInbox';

type Attention = 'running' | 'completed' | 'error';
const permissionLabels = { 'read-only': 'Read only', edit: 'Edit files', 'full-access': 'Full access' } as const;
const folderName = (projectPath: string) => projectPath.split(/[\\/]/u).filter(Boolean).pop() ?? projectPath;

function agentStatus(agent: AgentDefinition, library: AgentLibrary, unread: AgentInboxItem | undefined, now: number): { attention: Attention | null; detail: string } {
  const runs = library.runs.filter((run) => run.agentId === agent.id && run.routineId === null);
  const active = runs.find((run) => run.status === 'running' || run.status === 'queued');
  if (active) return { attention: 'running', detail: `Working in ${folderName(active.projectPath)} · ${active.request}` };
  if (!agent.enabled) return { attention: null, detail: 'Off' };
  const attention = unread ? unread.status === 'failed' || unread.status === 'interrupted' ? 'error' : 'completed' : null;
  if (unread) return { attention, detail: `${unread.title} · ${formatRelativeTime(unread.at, now)}` };
  const paused = library.watches.some((watch) => watch.agentId === agent.id && watch.enabled
    && library.watchStates.some((state) => state.watchId === watch.id && state.revision === watch.revision && state.pausedAt !== null));
  if (paused) return { attention, detail: 'Watch paused' };
  const last = runs.find((run) => run.finishedAt !== null);
  if (!last?.finishedAt) return { attention, detail: `Ready · ${permissionLabels[agent.defaults.permission]}` };
  const failed = last.status === 'failed' || last.status === 'needs-attention';
  return { attention, detail: `${failed ? 'Run failed' : 'Run done'} · ${formatRelativeTime(last.finishedAt, now)}` };
}

export function SidebarAgents() {
  const { ActionContent, Symbol } = useSkinComponents();
  const currentAgentId = useRuntimeStore((state) => state.runtime.project?.agentId ?? null);
  const compactSessions = useUiStore((state) => state.compactSessions);
  const library = useAgentsStore((state) => state.library);
  const inbox = useAgentsStore((state) => state.inbox);
  const busy = useAgentsStore((state) => state.busy);
  const loading = useAgentsStore((state) => state.loading);
  const [query, setQuery] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const now = useMemo(() => Date.now(), [library, inbox]);
  const latestUnread = useMemo(() => {
    const latest = new Map<string, AgentInboxItem>();
    for (const item of inbox.items) if (item.readAt === null && !latest.has(item.agentId)) latest.set(item.agentId, item);
    return latest;
  }, [inbox]);
  const muted = useMemo(() => new Set(inbox.muted), [inbox]);
  const unread = library.agents.reduce((sum, agent) => sum + (inbox.unread[agent.id] ?? 0), 0);
  useEffect(() => { void useAgentsStore.getState().load(); }, []);

  const needle = query.trim().toLocaleLowerCase();
  const visible = library.agents.filter((agent) => !needle || agent.name.toLocaleLowerCase().includes(needle));
  const perform = (operation: () => Promise<unknown>) => {
    void useAgentsStore.getState().mutate(operation).catch((error: unknown) => {
      useUiStore.getState().showToast({ kind: 'error', title: 'Agents', message: agentError(error) });
    });
  };
  const expected = (agent: AgentDefinition) => library.revisions[`agent:${agent.id}`]!;
  const toggle = (agent: AgentDefinition) => perform(() => getDesktopApi().saveAgentDefinition({ id: agent.id, expected: expected(agent), value: { ...agentDraft(agent), enabled: !agent.enabled } }));
  const remove = (agent: AgentDefinition) => {
    setConfirmingDelete(null);
    perform(() => getDesktopApi().deleteAgentLibraryItem({ kind: 'agent', id: agent.id, expected: expected(agent) }));
  };

  const actions = (agent: AgentDefinition, inMenu: boolean) => (
    <div className={`session-row-actions${inMenu ? ' session-row-actions--menu' : ''}`} role={inMenu ? 'menu' : undefined}>
      {[
        { key: 'edit', label: 'Edit agent', icon: Pencil, onClick: () => useAgentsStore.getState().edit(agent.id) },
        { key: 'toggle', label: agent.enabled ? 'Turn off' : 'Turn on', icon: Power, onClick: () => toggle(agent) },
        muted.has(agent.id)
          ? { key: 'notify', label: 'Unmute notifications', icon: BellRing, onClick: () => perform(() => getDesktopApi().setAgentNotifications({ agentId: agent.id, notify: true })) }
          : { key: 'notify', label: 'Mute notifications', icon: BellOff, onClick: () => perform(() => getDesktopApi().setAgentNotifications({ agentId: agent.id, notify: false })) },
        { key: 'delete', label: 'Delete agent', icon: Trash2, onClick: () => setConfirmingDelete(agent.id), className: 'session-delete-button' },
      ].map(({ key, label, icon: Icon, onClick, className }) => (
        <AppTooltip key={key} content={label} wrapTrigger>
          <button type="button" role={inMenu ? 'menuitem' : undefined} className={className} aria-label={`${label}: ${agent.name}`} disabled={busy} onClick={onClick}>
            <Icon size={13} aria-hidden="true" />
          </button>
        </AppTooltip>
      ))}
    </div>
  );

  const row = (agent: AgentDefinition) => {
    if (confirmingDelete === agent.id) {
      return (
        <div className="session-delete-confirm" key={agent.id}>
          <span>Delete this agent?</span>
          <AppTooltip content="Delete agent" wrapTrigger triggerClassName="session-delete-confirm-button session-delete-confirm-button--danger"><button type="button" onClick={() => remove(agent)}>Delete</button></AppTooltip>
          <AppTooltip content="Cancel deletion" wrapTrigger triggerClassName="session-delete-confirm-button"><button type="button" onClick={() => setConfirmingDelete(null)}>Cancel</button></AppTooltip>
        </div>
      );
    }
    const current = agent.id === currentAgentId;
    const { attention, detail } = agentStatus(agent, library, latestUnread.get(agent.id), now);
    const label = attention === 'running' ? 'Agent working' : `${inbox.unread[agent.id] ?? 1} unread${attention === 'error' ? ' · failed' : ''}`;
    const dot = !current && attention && (
      <AppTooltip content={label} side="right" sideOffset={6}>
        <span className="session-attention-dot" data-attention={attention} role="img" aria-label={label} />
      </AppTooltip>
    );
    const open = { type: 'button' as const, disabled: current || busy || !agent.enabled, onClick: () => void openAgent(agent.id) };
    if (compactSessions) {
      return (
        <div key={agent.id} className={`session-row session-row--compact${current ? ' session-row--current' : ''}`} aria-current={current ? 'page' : undefined}>
          <AppTooltip content={`${agent.name}\n${detail}`} side="right" sideOffset={8} wrapTrigger triggerClassName="session-open-tooltip">
            <button className="session-open session-open--compact" {...open}><span className="session-title-label">{agentLabel(agent)}</span></button>
          </AppTooltip>
          {dot}
          <Popover.Root>
            <AppTooltip content="Agent actions">
              <Popover.Trigger asChild>
                <button className="session-menu-trigger" type="button" aria-label={`Actions for ${agent.name}`}><MoreHorizontal size={14} /></button>
              </Popover.Trigger>
            </AppTooltip>
            <Popover.Portal>
              <Popover.Content className="session-action-menu" side="top" align="end" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()}>
                {actions(agent, true)}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      );
    }
    return (
      <div key={agent.id} className={`session-row${current ? ' session-row--current' : ''}`} aria-current={current ? 'page' : undefined}>
        <AppTooltip content={agent.description || agent.name} side="right" sideOffset={8} wrapTrigger triggerClassName="session-open-tooltip">
          <button className="session-open" {...open}>
            <span>{agentLabel(agent)}</span>
            <small>{detail}</small>
          </button>
        </AppTooltip>
        {dot}
        {actions(agent, false)}
      </div>
    );
  };

  return <>
    <div className="sidebar-tab-toolbar session-toolbar">
      <label className="session-search sidebar-search">
        <Symbol text="/"><Search size={15} aria-hidden="true" /></Symbol>
        <input className="icon-label" type="search" aria-label={showInbox ? 'Search inbox' : 'Search agents'} placeholder={showInbox ? 'Search inbox' : 'Search agents'} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <AppTooltip content="New agent" wrapTrigger triggerClassName="sidebar-toolbar-action sidebar-toolbar-action--primary session-toolbar-action--new">
        <button type="button" aria-label="New agent" disabled={busy} onClick={() => useAgentsStore.getState().edit('new')}><ActionContent text="new"><Plus size={15} /></ActionContent></button>
      </AppTooltip>
      <AppTooltip content={unread ? `Inbox · ${unread} new` : 'Inbox'} wrapTrigger triggerClassName="sidebar-toolbar-action">
        <button type="button" aria-label={unread ? `Inbox, ${unread} new` : 'Inbox'} aria-pressed={showInbox} onClick={() => setShowInbox((open) => !open)}>
          <ActionContent text={unread ? `inbox ${unread}` : 'inbox'}>{unread ? <BellDot size={15} /> : <Bell size={15} />}</ActionContent>
        </button>
      </AppTooltip>
    </div>
    {showInbox ? <AgentInboxPanel query={needle} /> : <div className="folder-list" aria-label="Agents" aria-busy={loading}>
      <div className="session-list">{visible.map(row)}</div>
      {!loading && !visible.length && (
        <div className="empty-sessions">
          <Bot size={19} />
          <p>{library.agents.length ? 'No match' : 'No agents yet'}</p>
        </div>
      )}
    </div>}
  </>;
}
