import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_WORD_NOTE_LENGTH, MAX_WORD_PARAGRAPHS, wordReviewNoteSchema, type WordReviewSaveNoteInput, type WordReviewView } from '../../shared/contracts/wordReview';
import { PiDesktopError } from '../pi/errors';
import type { FilesystemService } from './FilesystemService';
import { parseWordReview } from './WordReviewParser';

const noteRecordsSchema = z.array(z.tuple([
  z.number().int().min(1).max(MAX_WORD_PARAGRAPHS), wordReviewNoteSchema.min(1),
])).max(MAX_WORD_PARAGRAPHS);
const MAX_NOTES_BYTES = MAX_WORD_PARAGRAPHS * (MAX_WORD_NOTE_LENGTH * 6 + 16) + 2;
const MAX_ACTIVE_REVIEWS = 2;
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function reviewError(message: string, retryable = false): never {
  throw new PiDesktopError({ code: 'INVALID_REQUEST', message, retryable });
}

function storageError(): never {
  reviewError('Fate could not access local Word review notes.', true);
}

export class WordReviewService {
  private active = 0;
  private saving = false;

  constructor(private readonly settingsPath: () => string) {}

  async read(files: FilesystemService, relativePath: string, check: () => Promise<void>): Promise<WordReviewView> {
    return this.run(false, async () => {
      const source = await this.readSource(files, relativePath, check);
      const paragraphs = await parseWordReview(source.bytes);
      const notes = await this.notesFile(source.revision, false).then((target) => this.loadNotes(target)).catch(() => null);
      await check();
      const usable = notes && ![...notes.keys()].some((id) => id > paragraphs.length) ? notes : null;
      return { revision: source.revision, notesAvailable: usable !== null, paragraphs: paragraphs.map((paragraph) => ({ ...paragraph, note: usable?.get(paragraph.id) ?? null })) };
    });
  }

  async saveNote(files: FilesystemService, input: WordReviewSaveNoteInput, check: () => Promise<void>): Promise<{ saved: true }> {
    return this.run(true, async () => {
      const source = await this.readSource(files, input.path, check);
      if (source.revision !== input.revision) reviewError('The Word document changed. Reopen it before saving a note.', true);
      const paragraphs = await parseWordReview(source.bytes);
      if (!paragraphs.some(({ id }) => id === input.paragraphId)) reviewError('That paragraph is not in this Word review.');
      const target = await this.notesFile(source.revision, true);
      if (!target) storageError();
      const notes = await this.loadNotes(target);
      if ([...notes.keys()].some((id) => id > paragraphs.length)) storageError();
      const note = input.note.trim() ? input.note : '';
      if ((notes.get(input.paragraphId) ?? '') !== note) {
        if (note) notes.set(input.paragraphId, note);
        else notes.delete(input.paragraphId);
        await this.storeNotes(target, notes, async () => {
          const latest = await this.readSource(files, input.path, check);
          if (latest.revision !== input.revision) reviewError('The Word document changed. Reopen it before saving a note.', true);
        });
      }
      return { saved: true };
    });
  }

  private async run<T>(saving: boolean, operation: () => Promise<T>): Promise<T> {
    if (saving && this.saving || this.active >= MAX_ACTIVE_REVIEWS) reviewError('Another Word review is in progress. Try again.', true);
    this.active += 1;
    if (saving) this.saving = true;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (saving) this.saving = false;
    }
  }

  private async readSource(files: FilesystemService, relativePath: string, check: () => Promise<void>) {
    await check();
    const root = files.getRoot();
    const source = await files.readWordReviewSource(relativePath).catch((error: unknown) => {
      if (error instanceof PiDesktopError) throw error;
      reviewError('Fate could not read this .docx inside the active project.', true);
    });
    await check();
    const revision = digest(JSON.stringify(['word-review:1', root, source.canonicalPath, digest(source.bytes)]));
    return { bytes: source.bytes, revision };
  }

  private async notesFile(key: string, create: boolean): Promise<string | null> {
    try {
      const dataRoot = path.dirname(this.settingsPath());
      if (create) await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const directory = path.join(await fs.realpath(dataRoot), 'word-review');
      if (create) {
        await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      }
      await this.assertNotesDirectory(directory);
      return path.join(directory, `${key}.json`);
    } catch (error) {
      if (!create && missing(error)) return null;
      storageError();
    }
  }

  private async assertNotesDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.normalize(await fs.realpath(directory)) !== directory) storageError();
  }

  private async loadNotes(target: string | null): Promise<Map<number, string>> {
    if (!target) return new Map();
    try {
      const expected = await fs.lstat(target, { bigint: true }).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!expected) return new Map();
      if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_NOTES_BYTES) storageError();
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.ino <= 0n || stat.ino !== expected.ino || stat.dev !== expected.dev || stat.size > MAX_NOTES_BYTES) storageError();
        await this.assertNotesDirectory(path.dirname(target));
        const size = Number(stat.size);
        const bytes = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== size) storageError();
        const records = noteRecordsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
        const notes = new Map(records);
        if (notes.size !== records.length) storageError();
        return notes;
      } finally {
        await handle.close();
      }
    } catch {
      storageError();
    }
  }

  private async storeNotes(target: string, notes: Map<number, string>, check: () => Promise<void>): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      try {
        await fs.writeFile(temporary, JSON.stringify([...notes]), { flag: 'wx', mode: 0o600 });
        await this.assertNotesDirectory(path.dirname(target));
      } catch { storageError(); }
      await check();
      try { await fs.rename(temporary, target); }
      catch { storageError(); }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
