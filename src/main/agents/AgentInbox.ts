import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentInboxItemSchema, type AgentInboxItem, type AgentInboxOverview, type AgentRun } from '../../shared/contracts/agents';
import { DefinitionJournal } from './DefinitionJournal';

const ITEM_LIMIT = 100;
const OVERVIEW_LIMIT = 500;
const inboxSchema = z.object({
  schemaVersion: z.literal(1), agentId: z.string().uuid(), notify: z.boolean(), checkedAt: z.number().int().safe().nonnegative(),
  items: z.array(agentInboxItemSchema).max(ITEM_LIMIT),
}).strict();
type Inbox = z.infer<typeof inboxSchema>;
export type AgentNotice = Pick<AgentInboxItem, 'kind' | 'status' | 'title' | 'summary' | 'runId' | 'source'>;
export type RunOutcome = 'succeeded' | 'failed' | 'interrupted';

const clip = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
const outcomes: Record<RunOutcome, string> = { succeeded: 'finished', failed: 'failed', interrupted: 'interrupted' };

export function runNotice(run: AgentRun, status: RunOutcome): AgentNotice {
  const detail = status === 'succeeded' ? run.resultSummary : status === 'failed' ? run.error : null;
  return { kind: 'run', status, title: `Run in ${path.basename(run.projectPath)} ${outcomes[status]}`, summary: detail || run.request, runId: run.id, source: run.sessionId ? 'run' : 'chat' };
}
const inboxItem = (agentId: string, notice: AgentNotice, at: number, readAt: number | null): AgentInboxItem => agentInboxItemSchema.parse({
  ...notice, title: clip(notice.title, 200), summary: clip(notice.summary, 2000), id: randomUUID(), agentId, at, readAt,
});

export class AgentInbox {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}

  private journal(): DefinitionJournal { return new DefinitionJournal(path.join(this.root, 'inbox'), 2, this.root); }

  private async read(agentId: string): Promise<Inbox | null> {
    const saved = await this.journal().read(agentId);
    if (!saved) return null;
    const inbox = inboxSchema.parse(saved.metadata);
    if (inbox.agentId !== agentId) throw new Error('Inbox ownership conflict.');
    return inbox;
  }

  private change(agentId: string, update: (inbox: Inbox) => Inbox): Promise<Inbox> {
    const operation = async () => {
      const journal = this.journal();
      const snapshot = await journal.read(agentId);
      const current = snapshot ? inboxSchema.parse(snapshot.metadata) : { schemaVersion: 1 as const, agentId, notify: true, checkedAt: 0, items: [] };
      const next = update(current);
      const items = [...next.items].sort((left, right) => right.at - left.at);
      const evicted = items.splice(ITEM_LIMIT);
      const trimmed = inboxSchema.parse({ ...next, items, checkedAt: Math.max(next.checkedAt, ...evicted.map((item) => item.at)) });
      if (JSON.stringify(trimmed) === JSON.stringify(current)) return current;
      await journal.save(agentId, snapshot, { metadata: trimmed, body: '' });
      return trimmed;
    };
    const result = (this.queues.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(agentId, settled);
    void settled.then(() => { if (this.queues.get(agentId) === settled) this.queues.delete(agentId); });
    return result;
  }

  async add(agentId: string, notice: AgentNotice, at = Date.now()): Promise<AgentInboxItem> {
    const item = inboxItem(agentId, notice, at, null);
    await this.change(agentId, (inbox) => ({ ...inbox, items: [item, ...inbox.items.filter((entry) => !item.runId || entry.runId !== item.runId)] }));
    return item;
  }

  async reconcile(agentId: string, runs: readonly AgentRun[], now = Date.now()): Promise<number> {
    let unread = 0;
    await this.change(agentId, (inbox) => {
      const known = new Set(inbox.items.flatMap((item) => item.runId ? [item.runId] : []));
      const missed = runs.flatMap((run) => {
        if (known.has(run.id)) return [];
        if (run.status === 'needs-attention' && (run.startedAt ?? run.scheduledFor) > inbox.checkedAt) return [{ notice: runNotice(run, 'interrupted'), at: now }];
        if ((run.status === 'succeeded' || run.status === 'failed') && run.finishedAt !== null && run.finishedAt > inbox.checkedAt) return [{ notice: runNotice(run, run.status), at: run.finishedAt }];
        return [];
      }).map(({ notice, at }) => inboxItem(agentId, notice, at, inbox.checkedAt || notice.status === 'interrupted' ? null : now));
      unread = missed.filter((item) => item.readAt === null).length;
      const pending = runs.filter((run) => run.status === 'queued' || run.status === 'running').map((run) => (run.startedAt ?? run.scheduledFor) - 1);
      return { ...inbox, checkedAt: Math.max(inbox.checkedAt, Math.min(now, ...pending)), items: [...missed, ...inbox.items] };
    });
    return unread;
  }

  async notifies(agentId: string): Promise<boolean> {
    return (await this.read(agentId))?.notify ?? true;
  }

  async setNotify(agentId: string, notify: boolean): Promise<void> {
    await this.change(agentId, (inbox) => ({ ...inbox, notify }));
  }

  async markRead(agentId: string | undefined, itemIds: readonly string[] | undefined, now = Date.now()): Promise<void> {
    const targets = new Set(itemIds);
    for (const id of agentId ? [agentId] : await this.journal().ids(1000)) {
      await this.change(id, (inbox) => ({ ...inbox, items: inbox.items.map((item) => item.readAt === null && (!itemIds || targets.has(item.id)) ? { ...item, readAt: now } : item) }));
    }
  }

  async overview(): Promise<AgentInboxOverview> {
    const inboxes = (await Promise.all((await this.journal().ids(1000)).map((id) => this.read(id).catch(() => null)))).flatMap((inbox) => inbox ? [inbox] : []);
    return {
      items: inboxes.flatMap((inbox) => inbox.items).sort((left, right) => right.at - left.at).slice(0, OVERVIEW_LIMIT),
      unread: Object.fromEntries(inboxes.flatMap((inbox) => {
        const count = inbox.items.filter((item) => item.readAt === null).length;
        return count ? [[inbox.agentId, count]] : [];
      })),
      muted: inboxes.filter((inbox) => !inbox.notify).map((inbox) => inbox.agentId),
    };
  }
}
