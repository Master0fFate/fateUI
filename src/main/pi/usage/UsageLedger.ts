import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { USAGE_TOP_ROWS, usageRecordSchema, type UsageQueryResult, type UsageRecord, type UsageTotals } from '../../../shared/contracts/usage';
import { projectPathHash } from '../provenance/attestationRecord';

const MAX_RECORDS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const emptyTotals = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });

function add(totals: UsageTotals, record: UsageRecord): void {
  totals.turns += 1;
  totals.input += record.input;
  totals.output += record.output;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.costUsd += record.costUsd;
}

function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const ledgers = new Map<string, UsageLedger>();

export function usageLedgerFor(dataRoot: string): UsageLedger {
  const key = process.platform === 'win32' ? dataRoot.toLowerCase() : dataRoot;
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new UsageLedger(dataRoot);
    ledgers.set(key, ledger);
  }
  return ledger;
}

export class UsageLedger {
  private queue: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, UsageRecord[]>();

  constructor(private readonly dataRoot: string) {}

  private file(projectRoot: string): string {
    return path.join(this.dataRoot, 'usage', 'v1', `${projectPathHash(projectRoot)}.jsonl`);
  }

  private async load(projectRoot: string): Promise<UsageRecord[]> {
    const cached = this.cache.get(projectRoot);
    if (cached) return cached;
    let text = '';
    try {
      text = await fs.readFile(this.file(projectRoot), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const records: UsageRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = usageRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch {
        continue;
      }
    }
    this.cache.set(projectRoot, records);
    return records;
  }

  record(projectRoot: string, record: UsageRecord): Promise<void> {
    const work = this.queue.then(async () => {
      const records = await this.load(projectRoot);
      records.push(record);
      const file = this.file(projectRoot);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      if (records.length > MAX_RECORDS) {
        records.splice(0, records.length - MAX_RECORDS);
        await fs.writeFile(file, records.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
        return;
      }
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const stat = await fs.stat(file);
      if (stat.size > MAX_BYTES) {
        records.splice(0, Math.floor(records.length / 2));
        await fs.writeFile(file, records.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  async todayCost(projectRoot: string): Promise<number> {
    const today = localDay(Date.now());
    let total = 0;
    for (const record of await this.load(projectRoot)) if (localDay(record.at) === today) total += record.costUsd;
    return total;
  }

  async query(projectRoot: string, days: number, dailyBudgetUsd: number | null): Promise<UsageQueryResult> {
    const records = await this.load(projectRoot);
    const now = Date.now();
    const today = localDay(now);
    const cutoff = now - days * DAY_MS;
    const result: UsageQueryResult = { today: emptyTotals(), window: emptyTotals(), days: [], models: [], sessions: [], dailyBudgetUsd };
    const byDay = new Map<string, { costUsd: number; turns: number }>();
    const byModel = new Map<string, UsageTotals>();
    const bySession = new Map<string, UsageTotals>();
    for (const record of records) {
      if (record.at < cutoff) continue;
      const day = localDay(record.at);
      if (day === today) add(result.today, record);
      add(result.window, record);
      const dayTotals = byDay.get(day) ?? { costUsd: 0, turns: 0 };
      dayTotals.costUsd += record.costUsd;
      dayTotals.turns += 1;
      byDay.set(day, dayTotals);
      const modelKey = `${record.provider}/${record.model}`;
      const modelTotals = byModel.get(modelKey) ?? emptyTotals();
      add(modelTotals, record);
      byModel.set(modelKey, modelTotals);
      const sessionTotals = bySession.get(record.sessionId) ?? emptyTotals();
      add(sessionTotals, record);
      bySession.set(record.sessionId, sessionTotals);
    }
    result.days = [...byDay].sort((left, right) => left[0].localeCompare(right[0])).map(([day, totals]) => ({ day, ...totals }));
    result.models = [...byModel].sort((left, right) => right[1].costUsd - left[1].costUsd).slice(0, USAGE_TOP_ROWS).map(([model, totals]) => ({ model, ...totals }));
    result.sessions = [...bySession].sort((left, right) => right[1].costUsd - left[1].costUsd).slice(0, USAGE_TOP_ROWS).map(([sessionId, totals]) => ({ sessionId, ...totals }));
    return result;
  }
}

export interface UsageExtensionDeps {
  ledger: UsageLedger;
  projectRoot: string;
  dailyBudgetUsd?: () => number | null;
}

export function createFateUsageExtension(deps: UsageExtensionDeps): InlineExtension {
  return {
    name: 'fate-usage',
    hidden: true,
    factory(pi) {
      let warnedDay = '';
      pi.on('turn_end', async (event, ctx) => {
        const message = event.message;
        if (message.role !== 'assistant') return;
        const usage = message.usage;
        const record: UsageRecord = {
          at: Date.now(),
          sessionId: ctx.sessionManager.getSessionId(),
          provider: String(message.provider),
          model: message.model,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          costUsd: usage.cost.total,
        };
        await deps.ledger.record(deps.projectRoot, record).catch(() => undefined);
        const budget = deps.dailyBudgetUsd?.();
        if (!budget) return;
        const spent = await deps.ledger.todayCost(deps.projectRoot);
        const day = localDay(record.at);
        if (spent <= budget || warnedDay === day) return;
        warnedDay = day;
        ctx.ui.notify(`Today's spend for this project is $${spent.toFixed(2)}, above the $${budget.toFixed(2)} daily budget.`, 'warning');
      });
    },
  };
}
