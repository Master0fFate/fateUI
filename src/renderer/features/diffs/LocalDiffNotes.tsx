import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GitDiff, GitStatus } from '../../../shared/contracts/ipc';
import { getDesktopApiOptional, getWebApiOptional } from '../../platform/api';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { LazyDiffViewer } from '../files/LazyMonaco';
import { HunkStrip } from './HunkStrip';
import { describeDiffRange, fingerprintDiff, hunkRangeFinder, isReviewHead, NOTE_STORE_KEY, NOTE_TEXT_LIMIT, readLocalNotes, sameDiffRange, writeLocalNote, type DiffLineRange, type LocalDiffNote } from './diffNoteModel';

const NOTE_UPDATE = 'fate-local-diff-notes';

function localProjectMatches(project: string) {
  const runtime = useRuntimeStore.getState();
  return runtime.source === 'desktop' && runtime.runtime.project?.path === project
    && useWorkspaceStore.getState().projectPath === project && Boolean(getDesktopApiOptional()) && !getWebApiOptional();
}

export function useLocalNotes(project: string | null) {
  const [state, setState] = useState<{ project: string; notes: LocalDiffNote[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!project) return;
    const refresh = () => {
      if (!localProjectMatches(project)) return;
      try { setState({ project, notes: readLocalNotes().filter((note) => note.project === project), error: false }); }
      catch { setState({ project, notes: [], error: true }); }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === NOTE_STORE_KEY || event.key === null) refresh(); };
    refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener(NOTE_UPDATE, refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(NOTE_UPDATE, refresh);
    };
  }, [project]);
  return project && state?.project === project ? state : null;
}

async function saveLocalNote(project: string, path: string, previous: LocalDiffNote | null, note: LocalDiffNote | null, current: () => boolean = () => true) {
  if (!navigator.locks) throw new Error('Local note storage is unavailable.');
  await navigator.locks.request(NOTE_STORE_KEY, () => {
    if (!localProjectMatches(project) || !current()) throw new Error('The diff changed. Review it before saving.');
    writeLocalNote(project, path, previous, note);
    window.dispatchEvent(new Event(NOTE_UPDATE));
  });
}

export function UnselectedDiffNotes({ notes, git, onSelect }: { notes: LocalDiffNote[]; git: GitStatus | null; onSelect: (path: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!notes.length) return null;
  return <details className="diff-unselected-notes">
    <summary>Local notes ({notes.length})</summary>
    <div className="diff-unselected-notes-list">
      {notes.map((note) => {
        const selectable = git?.changes.some((change) => change.path === note.path);
        const stale = note.head !== git?.head || (!git?.truncated && !selectable);
        return (
          <section key={note.path} aria-label={`Local note on ${note.path}`}>
            <strong>{note.path}</strong>
            <div className="diff-note-anchor" data-stale={stale || undefined}>{stale ? 'Stale · ' : ''}{describeDiffRange(note)}</div>
            <p className="diff-note-text">{note.text}</p>
            {selectable && <button className="diff-review-button" type="button" onClick={() => onSelect(note.path)}>Open diff</button>}
            {!selectable && <button className="diff-review-button" type="button" onClick={async () => {
              try { await saveLocalNote(note.project, note.path, note, null); setError(null); }
              catch { setError('Could not delete the local note.'); }
            }}>Delete note</button>}
          </section>
        );
      })}
      {error && <span role="alert">{error}</span>}
    </div>
  </details>;
}

function useDiffFingerprint(original: string, modified: string, oldPath: string | null, enabled: boolean) {
  const [state, setState] = useState<{ original: string; modified: string; oldPath: string | null; value: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const apply = (value: string | null) => { if (!disposed) setState({ original, modified, oldPath, value }); };
    void fingerprintDiff(original, modified, oldPath).then(apply, () => apply(null));
    return () => { disposed = true; };
  }, [original, modified, oldPath, enabled]);
  return enabled && state && state.original === original && state.modified === modified && state.oldPath === oldPath ? state.value : undefined;
}

export function FileDiffReview({ diff, git, noteState, refreshing }: { diff: GitDiff; git: GitStatus | null; noteState: ReturnType<typeof useLocalNotes>; refreshing: boolean }) {
  const note = noteState?.notes.find((entry) => entry.path === diff.path) ?? null;
  const project = noteState?.project;
  const original = diff.original ?? '';
  const modified = diff.modified ?? '';
  const oldPath = git?.changes.find((change) => change.path === diff.path)?.oldPath ?? null;
  const textDiff = diff.state === 'text';
  const head = isReviewHead(git?.head) ? git.head : null;
  const comparable = Boolean(project && !noteState?.error && textDiff && head && diff.head === head);
  const fingerprint = useDiffFingerprint(original, modified, oldPath, comparable);
  const findRanges = useMemo(() => hunkRangeFinder(original, modified), [original, modified]);
  const [draft, setDraft] = useState<{ anchor: DiffLineRange; head: string; fingerprint: string; text: string; previous: LocalDiffNote | null } | null>(null);
  const [split, setSplit] = useState(note?.side === 'original');
  const [message, setMessage] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const requestRef = useRef<(() => void) | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const fieldId = useId();
  const stale = Boolean(note && (!comparable || note.head !== head || (fingerprint !== undefined && fingerprint !== note.fingerprint)));
  const active = note && !stale && note.fingerprint === fingerprint ? note : null;
  const canWrite = Boolean(!refreshing && head && fingerprint);
  const draftStale = Boolean(draft && (!comparable || draft.head !== head || (fingerprint !== undefined && fingerprint !== draft.fingerprint)));
  const open = (range: DiffLineRange | null) => {
    setMessage(null);
    if (pendingSave.current || !canWrite || !head || !fingerprint) return;
    if (!range) { setMessage('Select a changed line or a contiguous range on one side.'); return; }
    if (note && (!active || !sameDiffRange(note, range))) { setMessage('This file already has a note at a different range.'); return; }
    if (draft && !sameDiffRange(draft.anchor, range)) { setMessage('Save or cancel the open note first.'); return; }
    if (draft) { document.getElementById(fieldId)?.focus(); return; }
    if (range.side === 'original') setSplit(true);
    setDraft({ anchor: range, head, fingerprint, text: active?.text ?? '', previous: note });
  };
  const closeDraft = () => {
    setDraft(null);
    setMessage(null);
    requestAnimationFrame(() => actionRef.current?.focus());
  };
  const save = async () => {
    if (pendingSave.current || !project || !draft || !canWrite || draftStale || !draft.text.trim()) return;
    const current = useWorkspaceStore.getState();
    if (current.diff !== diff || current.gitLoading || current.diffLoading || current.git?.head !== head) { setMessage('The diff changed. Review it before saving.'); return; }
    pendingSave.current = true;
    setSaving(true);
    try {
      await saveLocalNote(project, diff.path, draft.previous, { ...draft.anchor, head: draft.head, fingerprint: draft.fingerprint, text: draft.text, project, path: diff.path }, () => {
        const latest = useWorkspaceStore.getState();
        return latest.diff === diff && !latest.gitLoading && !latest.diffLoading && latest.git?.head === head;
      });
      closeDraft();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the local note.'); }
    finally { pendingSave.current = false; setSaving(false); }
  };
  const removeNote = async () => {
    if (!project || !note) return;
    try { await saveLocalNote(project, diff.path, note, null); setRemove(false); closeDraft(); }
    catch { setMessage('Could not delete the local note.'); }
  };
  return <>
    {textDiff && <HunkStrip path={diff.path} {...(canWrite && !stale ? { notes: { active, ranges: findRanges, open } } : {})} />}
    {project && (textDiff || note) && <div className="diff-local-note" aria-label="Local diff note">
      <div className="diff-local-note-bar">
        {note ? <span className="diff-note-anchor" data-stale={stale || undefined}>{stale ? 'Stale · ' : ''}{describeDiffRange(note)}</span> : <span>Local note</span>}
        {!draft && !stale && <button ref={actionRef} type="button" className="diff-review-button" disabled={!canWrite} aria-keyshortcuts="Control+Alt+N Meta+Alt+N"
          title={note ? 'Edit the saved local note' : 'Select changed lines, then press Ctrl/⌘+Alt+N or use the editor menu'}
          onClick={() => { if (note) open(note); else if (requestRef.current) requestRef.current(); else open(null); }}>
          {note ? 'Edit note' : 'Add note'}
        </button>}
        {textDiff && <button type="button" className="diff-review-button" aria-pressed={split} title="Show Before and After editors side by side" onClick={() => setSplit(!split)}>Split</button>}
      </div>
      {stale && <p className="diff-local-feedback" role="status">{note?.head !== head || diff.head !== head ? 'HEAD changed or could not be verified.' : 'The diff changed.'} The note stays at its original range.</p>}
      {!draft && note && <p className="diff-note-text">{note.text}</p>}
      {!draft && note && (
        <div className="diff-local-actions">
          {remove ? <>
            <button type="button" className="diff-review-button" onClick={removeNote}>Confirm delete</button>
            <button type="button" className="diff-review-button" onClick={() => setRemove(false)}>Cancel</button>
          </> : <button type="button" className="diff-review-button" onClick={() => setRemove(true)}>Delete note</button>}
        </div>
      )}
      {!note && !draft && (noteState?.error || !comparable || fingerprint === null) && <p className="diff-local-feedback" role="status">
        {noteState?.error ? 'Local note storage is unavailable.' : fingerprint === null ? 'Could not verify diff contents.' : 'Notes require a diff for the current committed HEAD.'}
      </p>}
      {draft && <form className="diff-note-form" onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pendingSave.current) closeDraft(); }
      }}>
        <label className="diff-note-anchor" htmlFor={fieldId}>Local note · {describeDiffRange(draft.anchor)}</label>
        <textarea id={fieldId} autoFocus maxLength={NOTE_TEXT_LIMIT} rows={2} value={draft.text} readOnly={draftStale || saving} onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })} />
        {draftStale && <p className="diff-local-feedback" role="status" data-stale="true">Stale draft · The original diff changed. It can’t be saved.</p>}
        <div className="diff-local-actions">
          <button className="diff-review-button" type="submit" data-primary="true" disabled={saving || !canWrite || draftStale || !draft.text.trim()}>{saving ? 'Saving…' : 'Save locally'}</button>
          <button className="diff-review-button" type="button" disabled={saving} onClick={closeDraft}>Cancel</button>
        </div>
      </form>}
      {message && <p className="diff-local-feedback" role="status">{message}</p>}
    </div>}
    {textDiff && <div className="preview-body"><LazyDiffViewer original={original} modified={modified} language={diff.language} path={diff.path}
      {...(project ? { review: { split, mark: refreshing ? null : active ?? (!draftStale ? draft?.anchor ?? null : null), revealMark: Boolean(draft && !draftStale), requestRef, onRequest: open } } : {})} /></div>}
  </>;
}
