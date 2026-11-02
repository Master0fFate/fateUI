import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { recoveryNoticeSchema, type PermissionLevel, type RuntimeState } from '../../shared/contracts/ipc';

export const RECOVERY_SNAPSHOT_VERSION = 1 as const;
const WRITE_INTERVAL_MS = 750;

export const recoverySnapshotSchema = recoveryNoticeSchema.extend({
  version: z.literal(RECOVERY_SNAPSHOT_VERSION),
  dirty: z.boolean(),
}).strict();

export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;

export function snapshotFromRuntime(state: Pick<RuntimeState, 'project' | 'sessionId' | 'permissionLevel' | 'streaming' | 'activeSessionRunning' | 'queue' | 'eventCursor' | 'tools'>, now = Date.now()): RecoverySnapshot {
  const runningTool = [...(state.tools ?? [])].reverse().find((tool) => tool.status === 'running');
  return {
    version: RECOVERY_SNAPSHOT_VERSION,
    dirty: true,
    projectPath: state.project?.path ?? null,
    sessionId: state.sessionId,
    ...(state.permissionLevel ? { permissionLevel: state.permissionLevel as PermissionLevel } : {}),
    streaming: state.streaming,
    activeSessionRunning: state.activeSessionRunning ?? false,
    queueSteering: state.queue?.steering ?? 0,
    queueFollowUp: state.queue?.followUp ?? 0,
    ...(state.eventCursor === undefined ? {} : { eventCursor: state.eventCursor }),
    lastToolName: runningTool?.name ?? null,
    writtenAt: now,
  };
}

export function recoveryFilePath(dataRoot: string, slot = 1): string {
  return path.join(dataRoot, `recovery-slot-${slot}.json`);
}

export interface RecoverySnapshotStore {
  read(filePath: string): Promise<string>;
  write(filePath: string, contents: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

const diskStore: RecoverySnapshotStore = {
  async read(filePath) {
    return fs.readFile(filePath, 'utf8');
  },
  async write(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
  },
  async remove(filePath) {
    await fs.rm(filePath, { force: true });
  },
};

export class RecoverySnapshotService {
  private pending: RecoverySnapshot | null = null;
  private reader: (() => Parameters<typeof snapshotFromRuntime>[0]) | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly store: RecoverySnapshotStore = diskStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static defaultFilePath(slot = 1, dataRoot = process.env.FATE_GUI_DATA_DIR ? path.resolve(process.env.FATE_GUI_DATA_DIR) : path.join(os.homedir(), '.pi', 'fateGUI')): string {
    return recoveryFilePath(dataRoot, slot);
  }

  /** Load a dirty snapshot from disk. A clean or corrupt file is ignored. */
  async load(): Promise<RecoverySnapshot | null> {
    try {
      const parsed = recoverySnapshotSchema.parse(JSON.parse(await this.store.read(this.filePath)));
      if (!parsed.dirty || !parsed.projectPath || !parsed.sessionId) {
        this.pending = null;
        return null;
      }
      this.pending = parsed;
      return parsed;
    } catch {
      this.pending = null;
      return null;
    }
  }

  peek(): RecoverySnapshot | null {
    this.capture();
    return this.pending;
  }

  /** Persist the live runtime. Throttled so a stream does not hammer disk. */
  remember(read: () => Parameters<typeof snapshotFromRuntime>[0]): void {
    this.reader = read;
    const wait = Math.max(0, WRITE_INTERVAL_MS - (this.now() - this.lastWrite));
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.capture();
      this.flushing = this.flushing.then(() => this.persist(this.pending));
    }, wait);
    this.writeTimer.unref?.();
  }

  /** Successful shutdown: drop the dirty file so relaunch is silent. */
  async markClean(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pending = null;
    this.reader = null;
    await this.flushing;
    await this.store.remove(this.filePath).catch(() => undefined);
  }

  private capture(): void {
    const read = this.reader;
    if (!read) return;
    this.reader = null;
    try {
      this.pending = snapshotFromRuntime(read(), this.now());
    } catch {
      return;
    }
  }

  private async persist(snapshot: RecoverySnapshot | null): Promise<void> {
    if (!snapshot?.dirty) return;
    this.lastWrite = this.now();
    await this.store.write(this.filePath, `${JSON.stringify(snapshot)}\n`);
  }
}
