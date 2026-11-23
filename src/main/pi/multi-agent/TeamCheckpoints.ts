import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentTeamLedgerEvent } from './AgentTeamTypes';
import { TEAM_CHECKPOINT_PRUNED } from '../../../shared/contracts/multiAgent';

const TEAM_EVENT = 'fate-agent-team-event';
const REWRITE_INTERVAL_BYTES = 24 * 1024 * 1024;
const CHECKPOINT_INTERVAL = 8;
export const MAX_LIVE_SESSION_BYTES = 128 * 1024 * 1024;
const checks = new WeakMap<SessionManager, { file: string; count: number; nextSize: number }>();

export function assertSessionFitsInMemory(file: string): void {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && stat.size > MAX_LIVE_SESSION_BYTES) {
    throw new Error('This saved chat exceeds the 128 MiB live session limit. Its history is unchanged. Start a new chat to continue.');
  }
}

function checkpointReplacements(entries: SessionEntry[]) {
  const children = new Map<string, number>();
  const newest = new Map<string, Map<string, number>>();
  const replacements = new Map<string, { entry: Extract<SessionEntry, { type: 'custom' }>; data: AgentTeamLedgerEvent }>();
  for (const { parentId } of entries) if (parentId) children.set(parentId, (children.get(parentId) ?? 0) + 1);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    let claims = newest.get(entry.id);
    newest.delete(entry.id);
    if (entry.type === 'custom' && entry.customType === TEAM_EVENT) {
      const event = entry.data as AgentTeamLedgerEvent | undefined;
      if (event?.kind === TEAM_EVENT && event.version === 1 && typeof event.teamId === 'string' && Number.isSafeInteger(event.sequence)) {
        claims ??= new Map();
        const later = claims.get(event.teamId);
        if (event.payload?.team && later !== undefined && later >= event.sequence) {
          replacements.set(entry.id, { entry, data: { ...event, type: TEAM_CHECKPOINT_PRUNED, payload: {} } });
        }
        claims.set(event.teamId, Math.max(later ?? event.sequence, event.sequence));
      }
    }
    if (claims && entry.parentId && children.get(entry.parentId) === 1) {
      newest.set(entry.parentId, claims);
    }
  }
  return replacements;
}

export function persistTeamCheckpoint(manager: SessionManager, event: AgentTeamLedgerEvent): void {
  manager.appendCustomEntry(TEAM_EVENT, event);
  if (!manager.isPersisted?.()) return;
  const file = manager.getSessionFile();
  if (!file) return;
  let check = checks.get(manager);
  if (check?.file !== file) {
    check = { file, count: 0, nextSize: REWRITE_INTERVAL_BYTES };
    checks.set(manager, check);
  }
  if (++check.count < CHECKPOINT_INTERVAL) return;
  check.count = 0;
  try {
    const before = lstatSync(file, { throwIfNoEntry: false });
    if (!before?.isFile() || before.size < check.nextSize) return;
    check.nextSize = before.size + REWRITE_INTERVAL_BYTES;
    const compactedSize = compactTeamCheckpoints(manager, file, before);
    if (compactedSize !== undefined) check.nextSize = compactedSize + REWRITE_INTERVAL_BYTES;
  } catch (error) {
    console.warn('Team checkpoint cleanup failed; the last checkpoint was saved.', error);
  }
}

function compactTeamCheckpoints(manager: SessionManager, file: string, before: ReturnType<typeof lstatSync>): number | undefined {
  const header = manager.getHeader();
  if (!header || !before) return;
  const entries = manager.getEntries();
  const replacements = checkpointReplacements(entries);
  if (replacements.size < CHECKPOINT_INTERVAL) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(header)}\n`);
      for (const entry of entries) {
        const replacement = replacements.get(entry.id);
        writeFileSync(fd, `${JSON.stringify(replacement ? { ...entry, data: replacement.data } : entry)}\n`);
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const now = lstatSync(file);
    if (now.ino !== before.ino || now.dev !== before.dev || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) return;
    const compactedSize = lstatSync(temporary).size;
    renameSync(temporary, file);
    for (const { entry, data } of replacements.values()) entry.data = data;
    return compactedSize;
  } finally { rmSync(temporary, { force: true }); }
}
