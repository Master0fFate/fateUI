import { FileText, Pencil, Plus, RotateCw } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_WORD_NOTE_LENGTH, type WordReviewApi, type WordReviewParagraph, type WordReviewRun, type WordReviewView } from '../../../shared/contracts/wordReview';
import { AppTooltip } from '../../components/AppTooltip';
import { getWordReviewApiOptional } from '../../platform/api';
import { messageOf } from '../../stores/workspaceStore';
import './wordReviewPreview.css';

function formatRun(run: WordReviewRun): ReactNode {
  let value: ReactNode = run.text;
  if (run.bold) value = <strong>{value}</strong>;
  if (run.italic) value = <em>{value}</em>;
  if (run.underline) value = <u>{value}</u>;
  return value;
}

const Paragraph = memo(function Paragraph({ paragraph, editing, editDisabled, onEdit, onClose, onSave }: {
  paragraph: WordReviewParagraph;
  editing: boolean;
  editDisabled: boolean;
  onEdit: (id: number) => void;
  onClose: () => void;
  onSave: (id: number, note: string) => Promise<void>;
}) {
  const { id, headingLevel, runs, note } = paragraph;
  const labelId = useId();
  const previousEditing = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (editing) textarea.current?.focus();
    else if (previousEditing.current) button.current?.focus();
    previousEditing.current = editing;
  }, [editing]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try { await onSave(id, draft.trim() ? draft : ''); }
    catch (error) { setError(messageOf(error)); }
    finally { setSaving(false); }
  };
  const content = runs.some(({ text }) => text.trim())
    ? runs.map((run, index) => <span key={index}>{formatRun(run)}</span>)
    : <span className="word-review-blank">Empty paragraph</span>;
  return <li className="word-review-paragraph">
    <span className="word-review-anchor" aria-hidden="true">{id}</span>
    <div className="word-review-paragraph-body">
      {headingLevel ? <div role="heading" aria-level={headingLevel} className="word-review-text" dir="auto">{content}</div>
        : <p className="word-review-text" dir="auto">{content}</p>}
      {!editing && <>
        {note !== null && <div className="word-review-note"><span>Local note</span><p dir="auto">{note}</p></div>}
        <button type="button" className="word-review-button word-review-note-action" ref={button} disabled={editDisabled}
          aria-label={`${note === null ? 'Add note' : 'Edit note'} for paragraph ${id}`} onClick={() => {
            setDraft(note ?? '');
            setError('');
            onEdit(id);
          }}>{note === null ? <><Plus size={14} aria-hidden="true" />Add note</> : <><Pencil size={13} aria-hidden="true" />Edit note</>}</button>
      </>}
      {editing && <form className="word-review-editor" onSubmit={(event) => void save(event)} aria-busy={saving}>
        <label htmlFor={labelId}>Note for paragraph {id}</label>
        <textarea id={labelId} rows={3} ref={textarea} value={draft} readOnly={saving} dir="auto"
          maxLength={MAX_WORD_NOTE_LENGTH} onChange={(event) => setDraft(event.target.value)} />
        <div className="word-review-editor-actions">
          <button type="submit" className="word-review-button word-review-save" disabled={saving}>{saving ? 'Saving…' : 'Save note'}</button>
          <button type="button" className="word-review-button" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
        {note !== null && <span className="word-review-hint">Clear the text and save to remove the note.</span>}
        {error && <p className="word-review-error" role="alert">{error}</p>}
      </form>}
    </div>
  </li>;
});

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; view: WordReviewView };

export function WordReviewPreview({ path, api }: { path: string; api: WordReviewApi }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const title = useId();
  const revision = load.status === 'ready' ? load.view.revision : undefined;
  useEffect(() => {
    let current = true;
    void api.readWordReview({ path }).then((view) => {
      if (current) setLoad({ status: 'ready', view });
    }, (error: unknown) => {
      if (current) setLoad({ status: 'error', message: messageOf(error) });
    });
    return () => { current = false; };
  }, [api, attempt, path]);
  const startEdit = useCallback((id: number) => {
    setAnnouncement('');
    setEditing(id);
  }, []);
  const closeEditor = useCallback(() => setEditing(null), []);
  const save = useCallback(async (paragraphId: number, note: string) => {
    if (!revision || getWordReviewApiOptional() !== api) throw new Error('The local Word review is no longer active.');
    await api.saveWordReviewNote({ path, revision, paragraphId, note });
    setLoad((current) => current.status === 'ready' && current.view.revision === revision ? {
      status: 'ready', view: { ...current.view, paragraphs: current.view.paragraphs.map((paragraph) => paragraph.id === paragraphId
        ? { ...paragraph, note: note || null } : paragraph) },
    } : current);
    setEditing(null);
    setAnnouncement(note ? `Note saved for paragraph ${paragraphId}.` : `Note removed from paragraph ${paragraphId}.`);
  }, [api, path, revision]);
  return <section className="file-preview word-review" aria-labelledby={title}>
    <header className="preview-heading"><AppTooltip content={path}><span>{path}</span></AppTooltip></header>
    <div className="preview-body word-review-scroll">
      <div className="word-review-sheet">
        <header className="word-review-header">
          <div className="word-review-title"><FileText size={17} aria-hidden="true" /><h2 id={title}>Word review</h2><span>Read only</span></div>
          <button type="button" className="word-review-button" disabled={load.status === 'loading' || editing !== null}
            onClick={() => { setLoad({ status: 'loading' }); setAnnouncement(''); setAttempt((value) => value + 1); }}><RotateCw size={13} aria-hidden="true" />Reload</button>
        </header>
        <p className="word-review-description">Body paragraphs and headings with basic formatting. Tables, images and page layout aren’t shown. Notes are saved locally for this revision, not in the document.</p>
        <span className="sr-only" role="status">{announcement}</span>
        {load.status === 'loading' && <p className="word-review-empty" role="status">Reading Word document…</p>}
        {load.status === 'error' && <p className="word-review-empty word-review-error" role="alert">{load.message}</p>}
        {load.status === 'ready' && !load.view.notesAvailable && <p className="word-review-error" role="status">Local notes could not be read. The document is still available.</p>}
        {load.status === 'ready' && (load.view.paragraphs.length === 0
          ? <p className="word-review-empty">No supported body paragraphs in this document.</p>
          : <ol className="word-review-paragraphs" aria-label="Word document paragraphs" role="list">
            {load.view.paragraphs.map((paragraph) => <Paragraph key={paragraph.id} paragraph={paragraph}
              editing={editing === paragraph.id} editDisabled={editing !== null || !load.view.notesAvailable} onEdit={startEdit} onClose={closeEditor} onSave={save} />)}
          </ol>)}
      </div>
    </div>
  </section>;
}
