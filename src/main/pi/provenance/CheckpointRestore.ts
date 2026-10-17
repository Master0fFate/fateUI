import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ATTESTATION_QUERY_LIMIT_MAX, type CheckpointRestoreResult, type CheckpointSkipReason, type MutationAttestation } from '../../../shared/contracts/mutationAttestation';
import { PiDesktopError } from '../errors';
import { MAX_PRE_HASH_BYTES, buildRestoreAttestation, projectPathHash } from './attestationRecord';
import type { CheckpointStore } from './CheckpointStore';
import type { MutationAttestationLedger } from './MutationAttestationLedger';

interface CurrentFile { hash: string; content: Buffer }

type Ledger = Pick<MutationAttestationLedger, 'query' | 'record'>;

export class CheckpointRestoreService {
  constructor(private readonly ledger: Ledger, private readonly store: CheckpointStore) {}

  async restore(projectRoot: string, attestationId: string, sessionId: string | null): Promise<CheckpointRestoreResult> {
    const { rows } = await this.ledger.query({ projectPath: projectRoot, limit: ATTESTATION_QUERY_LIMIT_MAX });
    const start = rows.findIndex((row) => row.id === attestationId);
    if (start < 0) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That checkpoint is no longer in the retained ledger window.', retryable: false });
    const targets = new Map<string, { first: MutationAttestation; last: MutationAttestation }>();
    for (let index = start; index < rows.length; index += 1) {
      const row = rows[index]!;
      const entry = targets.get(row.path);
      if (entry) entry.last = row;
      else targets.set(row.path, { first: row, last: row });
    }
    const projectHash = projectPathHash(projectRoot);
    const result: CheckpointRestoreResult = { restored: [], skipped: [] };
    for (const [relative, { first, last }] of targets) {
      const reason = await this.restorePath(projectRoot, projectHash, relative, first, last, sessionId);
      if (reason) result.skipped.push({ path: relative, reason });
      else result.restored.push(relative);
    }
    return result;
  }

  private async restorePath(
    projectRoot: string,
    projectHash: string,
    relative: string,
    first: MutationAttestation,
    last: MutationAttestation,
    sessionId: string | null,
  ): Promise<CheckpointSkipReason | null> {
    if (first.preState === 'oversize') return 'oversize';
    const target = path.resolve(projectRoot, ...relative.split('/'));
    const current = await this.readCurrent(target);
    if (current === 'unavailable') return 'unavailable';
    const expectedHash = last.postState === 'missing' ? null : last.postHash;
    if ((current?.hash ?? null) !== expectedHash) return 'changed';
    const desiredHash = first.preState === 'missing' ? null : first.preHash;
    if ((current?.hash ?? null) === desiredHash) return null;
    const desired = desiredHash ? await this.store.get(projectHash, desiredHash) : null;
    if (desiredHash && !desired) return 'evicted';
    if (current) await this.store.put(projectHash, current.hash, current.content);
    if (desired) await this.writeAtomically(target, desired);
    else await fs.unlink(target);
    const row = buildRestoreAttestation({
      projectRoot,
      targetPath: target,
      sessionId,
      preHash: current?.hash ?? null,
      preState: current ? 'hashed' : 'missing',
      postHash: desiredHash,
    });
    if (row) await this.ledger.record(row);
    return null;
  }

  private async readCurrent(target: string): Promise<CurrentFile | null | 'unavailable'> {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return 'unavailable';
    }
    if (!stat.isFile() || stat.size > MAX_PRE_HASH_BYTES) return 'unavailable';
    const content = await fs.readFile(target);
    return { hash: createHash('sha256').update(content).digest('hex'), content };
  }

  private async writeAtomically(target: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { flag: 'wx' });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
