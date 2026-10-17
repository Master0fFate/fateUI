import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES_PER_PROJECT = 256 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HASH_NAME = /^[0-9a-f]{64}$/;

interface BlobEntry { size: number; mtimeMs: number }

interface ProjectIndex { entries: Map<string, BlobEntry>; bytes: number }

export interface CheckpointStoreOptions {
  maxBytesPerProject?: number;
  maxAgeMs?: number;
}

export class CheckpointStore {
  private readonly indexes = new Map<string, Promise<ProjectIndex>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(private readonly dataRoot: string, options: CheckpointStoreOptions = {}) {
    this.maxBytes = options.maxBytesPerProject ?? DEFAULT_MAX_BYTES_PER_PROJECT;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  private dir(projectHash: string): string {
    return path.join(this.dataRoot, 'checkpoints', 'v1', projectHash);
  }

  private index(projectHash: string): Promise<ProjectIndex> {
    let loading = this.indexes.get(projectHash);
    if (!loading) {
      loading = this.load(projectHash);
      this.indexes.set(projectHash, loading);
      loading.catch(() => this.indexes.delete(projectHash));
    }
    return loading;
  }

  private async load(projectHash: string): Promise<ProjectIndex> {
    const dir = this.dir(projectHash);
    const entries = new Map<string, BlobEntry>();
    let bytes = 0;
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const cutoff = Date.now() - this.maxAgeMs;
    for (const name of names) {
      const file = path.join(dir, name);
      if (!HASH_NAME.test(name)) {
        if (name.endsWith('.tmp')) await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      entries.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
      bytes += stat.size;
    }
    return { entries, bytes };
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  put(projectHash: string, hash: string, content: Buffer): Promise<void> {
    return this.serialized(async () => {
      const index = await this.index(projectHash);
      const dir = this.dir(projectHash);
      const file = path.join(dir, hash);
      const now = Date.now();
      const existing = index.entries.get(hash);
      if (existing) {
        await fs.utimes(file, now / 1000, now / 1000).catch(() => undefined);
        existing.mtimeMs = now;
        return;
      }
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      const temp = path.join(dir, `${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, content, { flag: 'wx', mode: FILE_MODE });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
      index.entries.set(hash, { size: content.length, mtimeMs: now });
      index.bytes += content.length;
      await this.evict(projectHash, index);
    });
  }

  private async evict(projectHash: string, index: ProjectIndex): Promise<void> {
    if (index.bytes <= this.maxBytes) return;
    const oldest = [...index.entries.entries()].sort((left, right) => left[1].mtimeMs - right[1].mtimeMs);
    for (const [hash, entry] of oldest) {
      if (index.bytes <= this.maxBytes) break;
      await fs.rm(path.join(this.dir(projectHash), hash), { force: true }).catch(() => undefined);
      index.entries.delete(hash);
      index.bytes -= entry.size;
    }
  }

  async get(projectHash: string, hash: string): Promise<Buffer | null> {
    const index = await this.index(projectHash);
    const entry = index.entries.get(hash);
    if (!entry) return null;
    const file = path.join(this.dir(projectHash), hash);
    const content = await fs.readFile(file).catch(() => null);
    if (content && createHash('sha256').update(content).digest('hex') === hash) return content;
    await this.serialized(async () => {
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (index.entries.delete(hash)) index.bytes -= entry.size;
    });
    return null;
  }
}
