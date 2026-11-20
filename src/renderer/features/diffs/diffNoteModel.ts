import type { GitHunk } from '../../../shared/contracts/ipc';

export interface DiffLineRange {
  side: 'original' | 'modified';
  start: number;
  end: number;
}

export interface LocalDiffNote extends DiffLineRange {
  project: string;
  path: string;
  head: string;
  fingerprint: string;
  text: string;
}

export const NOTE_TEXT_LIMIT = 4_000;
export const NOTE_STORE_KEY = 'fate.desktop.diff-notes.v1';
const NOTE_STORE_LIMIT = 750_000;
const NOTE_COUNT_LIMIT = 128;
const digest = /^[a-f0-9]{64}$/u;
const headHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function describeDiffRange({ side, start, end }: DiffLineRange) {
  return `${side === 'original' ? 'Before' : 'After'} · ${start === end ? `line ${start}` : `lines ${start}–${end}`}`;
}

export function sameDiffRange(a: DiffLineRange, b: DiffLineRange) {
  return a.side === b.side && a.start === b.start && a.end === b.end;
}

export function isReviewHead(value: unknown): value is string {
  return typeof value === 'string' && headHash.test(value);
}

export async function fingerprintDiff(original: string, modified: string, oldPath: string | null) {
  const bytes = new TextEncoder().encode(JSON.stringify([oldPath, original, modified]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validNote(value: unknown): value is LocalDiffNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<LocalDiffNote>;
  return typeof note.project === 'string' && note.project.length > 0 && note.project.length <= 32_768
    && typeof note.path === 'string' && note.path.length > 0 && note.path.length <= 4_096
    && isReviewHead(note.head) && typeof note.fingerprint === 'string' && digest.test(note.fingerprint)
    && typeof note.text === 'string' && note.text.trim().length > 0 && note.text.length <= NOTE_TEXT_LIMIT
    && (note.side === 'original' || note.side === 'modified') && typeof note.start === 'number' && typeof note.end === 'number'
    && Number.isSafeInteger(note.start) && Number.isSafeInteger(note.end) && note.start > 0 && note.end >= note.start;
}

export function readLocalNotes(): LocalDiffNote[] {
  const raw = window.localStorage.getItem(NOTE_STORE_KEY);
  if (!raw) return [];
  if (raw.length > NOTE_STORE_LIMIT) throw new Error('Local note storage is too large.');
  const notes: unknown = JSON.parse(raw);
  if (!Array.isArray(notes) || notes.length > NOTE_COUNT_LIMIT || !notes.every(validNote)) throw new Error('Local notes could not be read.');
  return notes;
}

export function writeLocalNote(project: string, path: string, previous: LocalDiffNote | null, next: LocalDiffNote | null) {
  const notes = readLocalNotes();
  const matches = (note: LocalDiffNote) => note.project === project && note.path === path;
  if (JSON.stringify(notes.find(matches) ?? null) !== JSON.stringify(previous)) throw new Error('The saved note changed. Reopen the file and try again.');
  const updated = notes.filter((note) => !matches(note));
  if (next) {
    if (!validNote(next) || !matches(next)) throw new Error('This note could not be saved.');
    updated.push(next);
  }
  const raw = JSON.stringify(updated);
  if (updated.length > NOTE_COUNT_LIMIT || raw.length > NOTE_STORE_LIMIT) throw new Error('Local note storage is full. Delete a note to save another.');
  window.localStorage.setItem(NOTE_STORE_KEY, raw);
}

function splitFileLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function fileLineCount(text: string) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/u).length - Number(/[\r\n]$/u.test(text));
}

export function hunkRangeFinder(original: string, modified: string) {
  const originals = splitFileLines(original);
  const modifications = splitFileLines(modified);
  return (hunk: GitHunk): DiffLineRange[] => {
    if (hunk.truncated) return [];
    const ranges: DiffLineRange[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const append = (side: DiffLineRange['side'], line: number) => {
      const previous = ranges.at(-1);
      if (previous?.side === side && previous.end + 1 === line) previous.end = line;
      else ranges.push({ side, start: line, end: line });
    };
    for (const row of hunk.text.split('\n').slice(1)) {
      if (row.startsWith('\\ ')) continue;
      const value = row.slice(1).replace(/\r$/u, '');
      switch (row[0]) {
        case ' ':
          if (originals[oldLine++ - 1] !== value || modifications[newLine++ - 1] !== value) return [];
          break;
        case '-':
          if (originals[oldLine - 1] !== value) return [];
          append('original', oldLine++);
          break;
        case '+':
          if (modifications[newLine - 1] !== value) return [];
          append('modified', newLine++);
          break;
        default:
          return [];
      }
    }
    return oldLine === hunk.oldStart + hunk.oldLines && newLine === hunk.newStart + hunk.newLines ? ranges : [];
  };
}
