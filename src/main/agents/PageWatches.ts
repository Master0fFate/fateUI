import { createHash } from 'node:crypto';
import { watchStateSchema, type AgentDefinition, type AgentLibrary, type WatchDefinition, type WatchState } from '../../shared/contracts/agents';
import type { AgentRepository } from './AgentRepository';
import type { DefinitionSnapshot } from './DefinitionJournal';
import { fetchWatchedPage, pageText } from './WatchFetch';

const GRACE_MS = 30_000;
const PAUSE_AFTER = 5;
const KEPT_TEXT = 50_000;
const RELATIVE_TIME = /\b(?:\d+|an?|one)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b|\bjust now\b/giu;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const squash = (value: string) => value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
export const retryDelay = (failures: number) => 2 ** failures * 60_000;

export function usdPrice(text: string): number | null {
  const match = /(?:US\s?\$|\$|\bUSD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?![\d,])|\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?USD\b/iu.exec(text);
  if (!match) return null;
  return Number(`${(match[1] ?? match[3])!.replace(/,/gu, '')}${match[2] ?? match[4] ?? ''}`);
}

function changedLines(before: string, after: string): string {
  const old = new Set(before.split('\n'));
  const now = new Set(after.split('\n'));
  const lines = (marker: string, from: Set<string>, against: Set<string>) => [...from].filter((line) => !against.has(line)).slice(0, 20).map((line) => `${marker} ${line.slice(0, 300)}`);
  return [...lines('+', now, old), ...lines('-', old, now)].join('\n');
}

function observe(watch: WatchDefinition, state: WatchState, previousText: string, text: string): Pick<WatchState, 'fingerprint' | 'matched' | 'price'> & { hit: string | null } {
  if (watch.condition === 'change') {
    const fingerprint = hash(text.replace(RELATIVE_TIME, ''));
    const lines = state.fingerprint && state.fingerprint !== fingerprint ? changedLines(previousText, text) : null;
    return { fingerprint, matched: null, price: null, hit: lines === null ? null : `the page changed.${lines ? `\n\nChanged lines, quoted from the page:\n${lines}` : ''}` };
  }
  if (watch.condition === 'appears' || watch.condition === 'disappears') {
    const present = squash(text).includes(squash(watch.text));
    const matched = watch.condition === 'appears' ? present : !present;
    return { fingerprint: null, matched, price: null, hit: matched && state.matched !== true ? `"${watch.text}" ${present ? 'is on' : 'is gone from'} the page.` : null };
  }
  const price = usdPrice(text);
  if (price === null) throw new Error('No USD price was found on the page.');
  const matched = watch.condition === 'above' ? price > watch.price! : price < watch.price!;
  return { fingerprint: null, matched, price, hit: matched && state.matched !== true ? `the price is ${usd(price)}, ${watch.condition} ${usd(watch.price!)}.` : null };
}

function restart(watch: WatchDefinition, previous: WatchState | null, now: number): WatchState {
  const basis = hash(JSON.stringify(watch.condition === 'change' ? [watch.url] : [watch.url, watch.condition, watch.condition === 'above' || watch.condition === 'below' ? watch.price : watch.text]));
  const kept = previous?.basis === basis ? previous : null;
  return { schemaVersion: 1, watchId: watch.id, revision: watch.revision, basis, nextCheckAt: now, lastCheckedAt: previous?.lastCheckedAt ?? null, lastHitAt: previous?.lastHitAt ?? null,
    fingerprint: kept?.fingerprint ?? null, matched: kept?.matched ?? null, price: kept?.price ?? null, failures: 0, pausedAt: null, error: null };
}

export interface WatchEvents {
  hit(agent: AgentDefinition, watch: WatchDefinition, text: string): Promise<void>;
  changed(agentId: string, paused?: { title: string; summary: string }): void;
}

export class PageWatches {
  private readonly shutdown = new AbortController();

  constructor(private readonly repository: AgentRepository, private readonly events: WatchEvents, private readonly fetchPage = fetchWatchedPage) {}

  stop(): void { this.shutdown.abort(); }

  private async read(watchId: string): Promise<{ snapshot: DefinitionSnapshot | null; state: WatchState | null }> {
    const snapshot = await this.repository.watchStateJournal().read(watchId);
    const parsed = watchStateSchema.safeParse(snapshot?.metadata);
    return { snapshot, state: parsed.success ? parsed.data : null };
  }

  async states(watches: readonly WatchDefinition[]): Promise<WatchState[]> {
    const states = await Promise.all(watches.map((watch) => this.read(watch.id).then((saved) => saved.state, () => null)));
    return states.filter((state) => state !== null);
  }

  async scan(library: AgentLibrary, now: number): Promise<number> {
    const due = await Promise.all(library.watches.flatMap((watch) => {
      const agent = library.agents.find((item) => item.id === watch.agentId);
      return watch.enabled && agent?.enabled ? [this.visit(agent, watch, now).catch(() => now + retryDelay(1))] : [];
    }));
    return Math.min(Infinity, ...due);
  }

  private async visit(agent: AgentDefinition, watch: WatchDefinition, now: number): Promise<number> {
    const { snapshot, state: saved } = await this.read(watch.id);
    const state = saved?.revision === watch.revision ? saved : restart(watch, saved, now);
    if (state.pausedAt !== null) return Infinity;
    if (now < state.nextCheckAt) return state.nextCheckAt;
    const previousText = snapshot?.body ?? '';
    const next = now - state.nextCheckAt > GRACE_MS
      ? { state: { ...state, nextCheckAt: now + (state.failures ? retryDelay(state.failures) : watch.intervalMinutes * 60_000) }, text: previousText, hit: null }
      : await this.check(watch, state, previousText, now);
    await this.repository.watchStateJournal().save(watch.id, snapshot, { metadata: next.state, body: next.text });
    if (next.hit) await this.events.hit(agent, watch, `Watch "${watch.name}" at ${watch.url}: ${next.hit}`).catch(() => undefined);
    else this.events.changed(agent.id, next.state.pausedAt === null ? undefined : { title: `${watch.name} paused after ${PAUSE_AFTER} failed checks`, summary: next.state.error ?? '' });
    return next.state.pausedAt === null ? next.state.nextCheckAt : Infinity;
  }

  private async check(watch: WatchDefinition, state: WatchState, previousText: string, now: number): Promise<{ state: WatchState; text: string; hit: string | null }> {
    try {
      const page = await this.fetchPage(watch.url, this.shutdown.signal);
      const text = pageText(page.body, page.type);
      if (!text) throw new Error('The page has no readable text.');
      const { hit, ...seen } = observe(watch, state, previousText, text);
      return { state: { ...state, ...seen, nextCheckAt: now + watch.intervalMinutes * 60_000, lastCheckedAt: now, lastHitAt: hit ? now : state.lastHitAt, failures: 0, error: null },
        text: watch.condition === 'change' ? text.slice(0, KEPT_TEXT) : '', hit };
    } catch (error) {
      if (this.shutdown.signal.aborted) throw error;
      const failures = state.failures + 1;
      return { state: { ...state, lastCheckedAt: now, failures, error: failure(error), pausedAt: failures >= PAUSE_AFTER ? now : null, nextCheckAt: now + retryDelay(failures) }, text: previousText, hit: null };
    }
  }
}
