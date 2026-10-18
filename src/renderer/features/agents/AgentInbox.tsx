import { CheckCheck, CircleAlert, CircleCheck, CirclePause, Eye, Inbox, Play, Radio, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentInboxItem } from '../../../shared/contracts/agents';
import { formatRelativeTime } from '../../lib/relativeTime';
import { openInboxItem, useAgentsStore } from '../../stores/agentsStore';
import { useUiStore } from '../../stores/uiStore';

const statusIcons = { succeeded: CircleCheck, failed: CircleAlert, interrupted: CirclePause, notice: Radio } as const;
const statusLabels = { succeeded: 'Done', failed: 'Failed', interrupted: 'Interrupted', notice: 'Alert' } as const;
const kindIcons = { run: Play, routine: Repeat, watch: Eye } as const;

export function AgentInboxPanel({ query }: { query: string }) {
  const agents = useAgentsStore((state) => state.library.agents);
  const inbox = useAgentsStore((state) => state.inbox);
  const compactSessions = useUiStore((state) => state.compactSessions);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const known = inbox.items.filter((item) => names.has(item.agentId));
  const unread = agents.reduce((sum, agent) => sum + (inbox.unread[agent.id] ?? 0), 0);
  const now = useMemo(() => Date.now(), [inbox]);
  const visible = known.filter((item) => (!unreadOnly || item.readAt === null)
    && (!query || `${names.get(item.agentId)} ${item.title} ${item.summary}`.toLocaleLowerCase().includes(query)));

  const row = (item: AgentInboxItem) => {
    const Status = statusIcons[item.status];
    const Kind = kindIcons[item.kind];
    const name = names.get(item.agentId)!;
    return (
      <button key={item.id} type="button" className="activity-row" data-clickable="true" title={item.summary || item.title}
        aria-label={`${statusLabels[item.status]}${item.readAt === null ? ', new' : ''}: ${name}, ${item.title}`} onClick={() => void openInboxItem(item)}>
        <span className="activity-kind"><Status size={12} aria-hidden="true" /></span>
        <span className="activity-kind"><Kind size={12} aria-hidden="true" /></span>
        <span className="activity-text">
          <strong>{item.title}</strong>
          <small>{item.readAt === null && <span className="activity-tag">new</span>}{compactSessions || !item.summary ? name : `${name} · ${item.summary}`}</small>
        </span>
        <time className="activity-time" dateTime={new Date(item.at).toISOString()} title={new Date(item.at).toLocaleString()}>{formatRelativeTime(item.at, now)}</time>
      </button>
    );
  };

  return (
    <section className="activity-panel" aria-label="Inbox">
      <div className="activity-head">
        <strong>Inbox</strong>
        <span className="activity-counts">{unread} new</span>
        <button type="button" className="activity-refresh" disabled={!unread} onClick={() => void useAgentsStore.getState().markRead({})}>
          <CheckCheck size={10} aria-hidden="true" />Read all
        </button>
      </div>
      <div className="activity-filters" role="group" aria-label="Filter inbox">
        <button type="button" className="activity-chip" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</button>
        <button type="button" className="activity-chip" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread</button>
      </div>
      {visible.length
        ? <div className="folder-list">{visible.map(row)}</div>
        : <div className="empty-sessions"><Inbox size={19} /><p>{known.length ? 'No match' : 'Nothing yet'}</p></div>}
    </section>
  );
}
