import { getDesktopApi, getDesktopApiOptional } from '../../platform/api';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, X } from 'lucide-react';
import { emptyActivation, lessonContentSchema, type LearningCapture, type LearningMutation, type LearningScope, type LearningState, type LessonContent, type PreviewEvidenceInput } from '../../../shared/contracts/learning';
import { learningMarkdown } from '../../../shared/learningMarkdown';
import { isCoreMemory, memoryKindLabel, newCoreMemory } from '../../../shared/learningMemory';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ipcErrorMessage } from '../../lib/ipcError';
import { InlineConfirm } from '../../components/InlineConfirm';
import { SelectControl } from '../../components/SelectControl';
import { useSkinComponents } from '../../skins/SkinProvider';
import { learningDraftKey, useLearningStore } from './learningStore';
import './learning.css';

type Editor = { id?: string; lessonId?: string; content: LessonContent; evidenceIds: string[]; review?: { epoch: string; expectedRevision: number; digest: string } | undefined };
type MutationAction = LearningMutation extends infer T ? T extends LearningMutation ? Omit<T, 'binding' | 'epoch' | 'expectedRevision'> : never : never;
const newNote = (): LessonContent => ({ kind: 'note', title: '', body: { guidance: '', rationale: '', exceptions: [] }, activation: { ...emptyActivation } });
const lineList = (value: string) => value ? value.split('\n') : [];
const readError = (error: unknown) => ipcErrorMessage(error, 'Memory Learning could not complete this action.');
const scopeName: Record<LearningScope, string> = { global: 'Profile', project: 'Project' };
const modeOptions = [{ value: 'off', label: 'Off' }, { value: 'manual', label: 'Manual' }, { value: 'automatic', label: 'Automatic' }];
const projectKindOptions = [{ value: 'note', label: 'Note' }, { value: 'procedure', label: 'Project skill (procedure)' }, { value: 'project-brief', label: 'Project briefing' }];
const activationLabels = { relativePaths: 'Paths', symbols: 'Symbols', keywords: 'Keywords' } as const;
const humanize = (field: string) => { const words = field.replace(/([A-Z])/gu, ' $1').toLowerCase(); return words.charAt(0).toUpperCase() + words.slice(1); };
const activationSummary = (activation: LessonContent['activation']) => [...activation.relativePaths, ...activation.symbols, ...activation.keywords, ...(activation.branchRestriction ? [`branch ${activation.branchRestriction}`] : [])].join(', ');

export function LearningPanel() {
  const open = useLearningStore((state) => state.open);
  const correction = useLearningStore((state) => state.correction);
  const runtimeProject = useRuntimeStore((state) => state.runtime.project?.path);
  const runtimeProjectName = useRuntimeStore((state) => state.runtime.project?.name);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const compactMode = useUiStore((state) => state.compactMode);
  const { ActionContent } = useSkinComponents();
  const key = learningDraftKey(runtimeProject, sessionId);
  const [state, setState] = useState<LearningState | null>(null);
  const [editScope, setEditScope] = useState<LearningScope>(() => useLearningStore.getState().focus ?? 'project');
  const [view, setView] = useState<'lessons' | 'drafts' | 'recent'>(() => useLearningStore.getState().focus ? 'drafts' : 'lessons');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [capture, setCapture] = useState<LearningCapture | null>(null);
  const [excerpts, setExcerpts] = useState<{ id: string; text: string }[]>([]);
  const [manual, setManual] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [filePath, setFilePath] = useState('');
  const [startLine, setStartLine] = useState(1);
  const [endLine, setEndLine] = useState(30);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const captureRef = useRef<LearningCapture | null>(null);
  const stateRef = useRef<LearningState | null>(null);
  const generation = useRef(0);
  const captureInitialized = useRef(false);
  const snapshot = state?.snapshot;
  const activeScope = state?.binding?.scope ?? 'project';
  const isGlobal = activeScope === 'global';
  const enabled = state?.enabled && snapshot?.mode !== 'off';
  const recentUse = state?.recentUse ?? snapshot?.manifests ?? [];
  const pendingDrafts = snapshot?.drafts.filter((draft) => draft.state === 'pending').length ?? 0;
  stateRef.current = state;
  captureRef.current = capture;
  const refresh = useCallback(async () => {
    if (!getDesktopApiOptional()?.getLearningState) return;
    const current = generation.current;
    try {
      const next = await getDesktopApi().getLearningState(editScope);
      if (current !== generation.current) return;
      if (stateRef.current?.binding && next.binding && stateRef.current.binding.scope !== next.binding.scope) { setEditor(null); setCapture(null); setExcerpts([]); }
      setState(next);
      if (!captureInitialized.current && next.binding) {
        captureInitialized.current = true;
        if (correction !== null) setEditor({ content: next.binding.scope === 'global' ? newCoreMemory('global') : newNote(), evidenceIds: [] });
      }
    } catch (failure) { if (current === generation.current) setError(readError(failure)); }
  }, [correction, editScope]);
  useEffect(() => {
    if (!open) return;
    ++generation.current;
    captureInitialized.current = false;
    setState(null); setEditor(null);
    setManual(correction ?? ''); setIntent(''); setCapture(null); setExcerpts([]); setSelectedSources([]); setFilePath(''); setError(null); setNotice(null); setBusy(false); setConfirmDelete(null);
    void refresh();
    const unsubscribe = getDesktopApiOptional()?.onLearningChanged?.(() => { void refresh(); });
    return () => {
      ++generation.current; unsubscribe?.();
      const binding = stateRef.current?.binding;
      if (binding) {
        if (request.current) void getDesktopApi().cancelLearning({ binding, id: request.current }).catch(() => undefined);
        if (captureRef.current) void getDesktopApi().cancelLearning({ binding, id: captureRef.current.id }).catch(() => undefined);
      }
      request.current = null;
    };
  }, [open, runtimeProject, sessionId, correction, refresh]);
  const run = async (operation: () => Promise<void>) => {
    const current = generation.current;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (failure) { if (current === generation.current) setError(readError(failure)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const mutate = async (action: MutationAction, review?: Editor['review']) => {
    if (!state?.binding || !snapshot) return;
    const current = generation.current;
    const result = await getDesktopApi().mutateLearning({ binding: state.binding, epoch: review?.epoch ?? snapshot.epoch, expectedRevision: review?.expectedRevision ?? snapshot.revision, ...action } as LearningMutation);
    if (current === generation.current) { setState(result); setEditor(null); setCapture(null); }
  };
  const preview = () => run(async () => {
    if (!state?.binding) return;
    const sources: PreviewEvidenceInput['sources'] = selectedSources.flatMap((id) => {
      const source = state.sources.find((item) => item.entryId === id);
      return source ? [{ kind: 'entry' as const, entryId: id, leafId: source.leafId }] : [];
    });
    if (manual.trim()) sources.push({ kind: 'manual', text: manual });
    if (filePath.trim()) sources.push({ kind: 'file', path: filePath.trim(), startLine, endLine });
    const current = generation.current;
    if (capture) await getDesktopApi().cancelLearning({ binding: state.binding, id: capture.id });
    const requestId = crypto.randomUUID(); request.current = requestId;
    try {
      const next = await getDesktopApi().previewLearningEvidence({ binding: state.binding, requestId, sources });
      if (current !== generation.current) return;
      setCapture(next); setExcerpts(next.evidence.map(({ id, text }) => ({ id, text })));
    } finally { if (request.current === requestId) request.current = null; }
  });
  const previewUnchanged = capture && JSON.stringify(excerpts) === JSON.stringify(capture.evidence.map(({ id, text }) => ({ id, text })));
  const generate = () => run(async () => {
    if (!capture || !state?.binding || !snapshot || !state.provider || !previewUnchanged) return;
    const id = crypto.randomUUID(); request.current = id;
    const current = generation.current;
    try {
      const result = await getDesktopApi().generateLearningDraft({ binding: state.binding, epoch: snapshot.epoch, expectedRevision: snapshot.revision, captureId: capture.id, captureDigest: capture.digest, requestId: id, ...(editor ? { kind: editor.content.kind } : {}), correction: intent, ...state.provider, consent: true });
      if (current !== generation.current) return;
      setState(result.state); setNotice(result.reason ?? 'Pending draft created. Review and approve it separately.'); setView('drafts'); setEditor(null);
    } finally { if (request.current === id) request.current = null; }
  });
  const updateContent = (content: LessonContent) => setEditor((previous) => previous ? { ...previous, content, review: undefined } : null);
  const updateBody = (field: string, value: string | string[]) => {
    if (!editor) return;
    updateContent({ ...editor.content, body: { ...editor.content.body, [field]: value } } as LessonContent);
  };
  const openCore = () => {
    const scope = state?.binding?.scope ?? 'project';
    const kind = scope === 'global' ? 'user-profile' : 'project-brief';
    const lesson = snapshot?.lessons.find((item) => snapshot.revisions.some((revision) => revision.id === item.activeRevisionId && revision.content.kind === kind));
    const revision = lesson ? snapshot?.revisions.find((item) => item.id === lesson.activeRevisionId) : null;
    setEditor(revision && lesson ? { lessonId: lesson.id, content: structuredClone(revision.content), evidenceIds: revision.evidenceIds } : { content: newCoreMemory(scope), evidenceIds: [] });
    setView('drafts');
  };
  const changeKind = (kind: string) => {
    if (!editor) return;
    updateContent(kind === 'user-profile' ? newCoreMemory('global') : kind === 'project-brief' ? newCoreMemory('project') : kind === 'note' ? newNote() : { kind: 'procedure', title: editor.content.title, body: { purpose: '', useWhen: [], doNotUseWhen: [], preconditions: [], steps: [], verification: [], stopConditions: [] }, activation: { ...emptyActivation } });
  };
  const openSettings = () => { useLearningStore.getState().close(); useUiStore.getState().setSettingsOpen(true); };
  const evidenceView = (ids: string[]) => ids.map((id) => {
    const evidence = snapshot?.evidence.find((item) => item.id === id);
    return <details key={id}><summary>{evidence ? `${evidence.basis} · ${evidence.source.path ?? evidence.source.entryId ?? 'manual text'}` : 'Evidence deleted — review required'}</summary>{evidence && <><pre>{evidence.text}</pre><small>Commit: {evidence.codeState.commit ?? 'unknown'} · verification/code-state association: unknown · {evidence.omitted ? 'excerpt / omissions' : 'selected text'}</small><button type="button" className="settings-inline-action" disabled={busy} onClick={() => void run(() => mutate({ action: 'delete-evidence', id }))}>Delete evidence</button></>}</details>;
  });
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) useLearningStore.getState().close(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="learning-dialog" aria-describedby="learning-description">
      <header className="settings-header">
        <div><Dialog.Title><Brain size={16} /> Memory Learning</Dialog.Title><Dialog.Description id="learning-description">{scopeName[activeScope]} · {(state?.binding && runtimeProjectName) || state?.projectName || 'No trusted project'} · not model training</Dialog.Description></div>
        <Dialog.Close className="settings-close" aria-label="Close Memory Learning"><ActionContent text="close"><X size={17} /></ActionContent></Dialog.Close>
      </header>
      <div className="learning-body">
        {error && <p className="learning-warning" role="alert">{error}</p>}{notice && <p className="settings-card-status" role="status">{notice}</p>}
        {busy && <div className="settings-card-status" role="status">Working… <button type="button" className="settings-inline-action" aria-label="Cancel capture or generation" onClick={() => { const binding = stateRef.current?.binding; if (binding && request.current) void getDesktopApi().cancelLearning({ binding, id: request.current }).catch(() => undefined); }}>Cancel</button></div>}
        {state && !enabled && <div className="settings-empty-card" role="status"><strong>Learning is off</strong><span>Stored memory stays editable.</span><button type="button" className="settings-inline-action" onClick={openSettings}>Open Settings</button></div>}
        {state?.diagnostic && <p className="settings-card-status" role="status">{state.diagnostic}</p>}
        {snapshot && state?.binding && <>
          <div className="settings-group">
            <div className="settings-select-row"><div><strong>Memory</strong><small>{isGlobal ? 'Your stated preferences, all projects' : 'This repo: briefing and notes'}</small></div><div className="activity-filters" role="group" aria-label="Memory scope"><button type="button" className="activity-chip" aria-pressed={editScope === 'global'} onClick={() => { setEditScope('global'); setEditor(null); }}>Profile</button><button type="button" className="activity-chip" aria-pressed={editScope === 'project'} onClick={() => { setEditScope('project'); setEditor(null); }}>Project</button></div></div>
            <div className="settings-select-row"><div><strong>Selection</strong></div><SelectControl compact={compactMode} label="Learning selection mode" className="settings-thinking-select" value={snapshot.mode} disabled={busy} options={modeOptions} onValueChange={(mode) => void run(() => mutate({ action: 'set-mode', mode: mode as 'off' | 'manual' | 'automatic' }))} /></div>
            {state.contextModes && enabled && <div className="settings-select-row"><div><strong>Layers</strong><small>Profile {state.contextModes.global ?? 'n/a'} · Project {state.contextModes.project ?? 'n/a'}</small></div><button type="button" className="settings-inline-action" onClick={openSettings}>Open Settings</button></div>}
          </div>
          <div className="learning-toolbar">
            <nav className="activity-filters" aria-label="Learning views">{(['lessons', 'drafts', 'recent'] as const).map((tab) => <button type="button" className="activity-chip" aria-pressed={view === tab} key={tab} onClick={() => { setView(tab); setEditor(null); }}>{tab === 'recent' ? 'Recent use' : tab === 'drafts' ? `Drafts${pendingDrafts ? ` · ${pendingDrafts}` : ''}` : 'Lessons'}</button>)}</nav>
            <div>{!isGlobal && <button type="button" className="settings-inline-action" disabled={!enabled || busy} onClick={() => { setEditor({ content: newNote(), evidenceIds: [] }); setView('drafts'); }}>Add lesson</button>}<button type="button" className="settings-inline-action" disabled={!enabled || busy} onClick={openCore}>{isGlobal ? 'User profile' : 'Project briefing'}</button><button type="button" className="settings-inline-action" onClick={() => void refresh()}>Refresh</button></div>
          </div>
          {view === 'lessons' && !editor && <>
            {!snapshot.lessons.length && <div className="settings-empty-card"><strong>No lessons</strong><span>{isGlobal ? 'Open User profile to add preferences.' : 'Add a briefing, note or skill.'}</span></div>}
            {snapshot.lessons.map((lesson) => {
              const revision = snapshot.revisions.find((item) => item.id === lesson.activeRevisionId)!;
              const activation = activationSummary(revision.content.activation);
              const revisions = snapshot.revisions.filter((item) => item.lessonId === lesson.id);
              return <article className="settings-card" key={lesson.id}>
                <div className="settings-toggle settings-card-head"><div><strong>{revision.content.title}</strong><small>{memoryKindLabel(revision.content.kind)} · v{revision.revisionNumber} · {lesson.enabled ? 'Enabled' : 'Disabled'} · {lesson.freshness}{lesson.conflict ? ' · conflict' : ''}</small></div></div>
                <pre>{learningMarkdown(revision.content)}</pre>
                {activation && <small>Activates on: {activation}</small>}
                <div className="settings-card-actions"><button type="button" className="settings-inline-action" disabled={!enabled || !lesson.enabled || lesson.conflict || lesson.freshness !== 'current' || !sessionId} onClick={() => {
                  if (!state.binding) return;
                  const existing = useLearningStore.getState().turns[key];
                  const sameSession = existing && existing.binding.projectKey === state.binding.projectKey && existing.binding.sessionId === state.binding.sessionId && existing.binding.runtimeGeneration === state.binding.runtimeGeneration;
                  const pins = sameSession ? existing.pins.filter((item) => item.lessonId !== lesson.id).map((item) => ({ ...item, scope: item.scope ?? existing.binding.scope })) : [];
                  if (pins.length >= 3) { setError('At most three items can be selected for one turn.'); return; }
                  useLearningStore.getState().setTurn(key, { binding: state.binding, pins: [...pins, { lessonId: lesson.id, revisionId: revision.id, scope: state.binding.scope }], excluded: existing?.excluded ?? [] });
                  setNotice('Selected exact revision for the next turn. Eligibility is checked again at dispatch.');
                }}>Use next turn</button><button type="button" className="settings-inline-action" aria-label="Edit as new draft" disabled={!enabled || busy} onClick={() => setEditor({ lessonId: lesson.id, content: structuredClone(revision.content), evidenceIds: revision.evidenceIds })}>Edit</button><button type="button" className="settings-inline-action" disabled={busy} onClick={() => void run(() => mutate({ action: 'set-enabled', id: lesson.id, enabled: !lesson.enabled }))}>{lesson.enabled ? 'Disable' : 'Enable'}</button><button type="button" className="settings-inline-action" disabled={busy} onClick={() => void run(() => mutate({ action: 'set-conflict', id: lesson.id, conflict: !lesson.conflict }))}>{lesson.conflict ? 'Resolve' : 'Mark conflict'}</button><button type="button" className="settings-inline-action" aria-label="Delete lesson" disabled={busy} onClick={() => setConfirmDelete(lesson.id)}>Delete</button></div>
                {confirmDelete === lesson.id && <InlineConfirm title="Delete lesson?" message="Removes all revisions and orphan evidence. Past requests and sessions keep their text." confirmLabel="Delete" busy={busy} onCancel={() => setConfirmDelete(null)} onConfirm={() => { setConfirmDelete(null); void run(() => mutate({ action: 'delete-lesson', id: lesson.id })); }} />}
                <details><summary>History · {revisions.length}</summary>{evidenceView(revision.evidenceIds)}{revisions.map((item) => <details key={item.id}><summary>Revision {item.revisionNumber}</summary><pre>{learningMarkdown(item.content)}</pre><code>{item.contentDigest}</code><div className="settings-card-actions"><button type="button" className="settings-inline-action" disabled={!enabled || busy} onClick={() => setEditor({ lessonId: lesson.id, content: structuredClone(item.content), evidenceIds: item.evidenceIds })}>Edit revision</button></div></details>)}</details>
              </article>;
            })}
          </>}
          {view === 'drafts' && !editor && <>
            {!snapshot.drafts.length && <div className="settings-empty-card"><strong>No drafts</strong><span>Manual drafts work without a provider.</span></div>}
            {snapshot.drafts.map((draft) => <article className="settings-card" key={draft.id}>
              <div className="settings-toggle settings-card-head"><div><strong>{draft.content.title}</strong><small>{draft.state}</small></div></div>
              <div className="settings-card-actions">{draft.state === 'pending' && <button type="button" className="settings-inline-action" onClick={() => setEditor({ id: draft.id, ...(draft.lessonId ? { lessonId: draft.lessonId } : {}), content: structuredClone(draft.content), evidenceIds: draft.evidenceIds, review: { epoch: snapshot.epoch, expectedRevision: snapshot.revision, digest: draft.digest } })}>Review draft</button>}<button type="button" className="settings-inline-action" aria-label="Delete draft" disabled={busy} onClick={() => void run(() => mutate({ action: 'delete-draft', id: draft.id }))}>Delete</button></div>
            </article>)}
          </>}
          {editor && <section className="learning-editor" aria-label="Lesson review">
            <div className="settings-title settings-title--spaced"><div><h3>{editor.id ? 'Review exact draft' : editor.lessonId ? 'New revision' : 'Add lesson'}</h3>{editor.lessonId && !editor.id && <p>Approved version stays live.</p>}</div></div>
            <div className="settings-group"><div className="settings-select-row"><div><strong>Type</strong>{isCoreMemory(editor.content) && <small>Reused when mode is Automatic. Briefings need review after 7 days.</small>}</div><SelectControl compact={compactMode} label="Lesson type" className="settings-thinking-select" value={editor.content.kind} options={isGlobal ? [{ value: 'user-profile', label: 'User coding profile' }, ...(editor.content.kind !== 'user-profile' ? [{ value: editor.content.kind, label: 'Legacy (convert)' }] : [])] : projectKindOptions} onValueChange={changeKind} /></div></div>
            <label className="settings-input-row"><span>Title</span><input value={editor.content.title} maxLength={160} onChange={(event) => updateContent({ ...editor.content, title: event.target.value })} /></label>
            {Object.entries(editor.content.body).map(([field, value]) => <label className="settings-input-row" key={field}><span>{humanize(field)}</span><textarea aria-label={field} value={Array.isArray(value) ? value.join('\n') : value} onChange={(event) => updateBody(field, Array.isArray(value) ? lineList(event.target.value) : event.target.value)} /></label>)}
            {snapshot.drafts.find((item) => item.id === editor.id)?.uncertainty.map((text, index) => <p className="learning-warning" key={index}>{text}</p>)}
            {!isCoreMemory(editor.content) && <>
              <div className="settings-title settings-title--spaced"><div><h3>Activation</h3></div></div>
              {(['relativePaths', 'symbols', 'keywords'] as const).map((field) => <label className="settings-input-row" key={field}><span>{activationLabels[field]}</span><textarea aria-label={field} placeholder="One per line" value={editor.content.activation[field].join('\n')} onChange={(event) => updateContent({ ...editor.content, activation: { ...editor.content.activation, [field]: lineList(event.target.value) } })} /></label>)}
              <label className="settings-input-row"><span>Branch</span><input value={editor.content.activation.branchRestriction ?? ''} onChange={(event) => updateContent({ ...editor.content, activation: { ...editor.content.activation, branchRestriction: event.target.value || null } })} /></label>
            </>}
            {snapshot.revisions.filter((item) => item.lessonId !== editor.lessonId && JSON.stringify(item.content.body) === JSON.stringify(editor.content.body)).slice(0, 3).map((item) => <p className="learning-warning" key={item.id}>Duplicate of {item.content.title}.</p>)}
            {snapshot.revisions.filter((item) => item.lessonId !== editor.lessonId && item.content.activation.keywords.filter((word) => editor.content.activation.keywords.includes(word)).length >= 2).slice(0, 3).map((item) => <p className="learning-warning" key={item.id}>Overlaps {item.content.title}. Mark conflicts before reuse.</p>)}
            <div className="settings-title settings-title--spaced"><div><h3>Evidence</h3></div></div>
            {evidenceView(editor.evidenceIds)}{!editor.evidenceIds.length && <p className="settings-card-status">Manual content without runtime evidence is unverified.</p>}
            <details open={correction !== null}><summary>Add evidence</summary>
              <p className="settings-card-status">Pasted text counts as your assertion.</p>
              <label className="settings-input-row"><span>Pasted text</span><textarea value={manual} onChange={(event) => setManual(event.target.value)} maxLength={16384} /></label>
              {state.sources.length > 0 && <div className="settings-group">{state.sources.map((source) => <label className="settings-toggle" key={source.entryId}><div><strong>{source.role}</strong><small>{source.preview}</small></div><input type="checkbox" checked={selectedSources.includes(source.entryId)} onChange={(event) => setSelectedSources((previous) => event.target.checked ? [...previous, source.entryId] : previous.filter((id) => id !== source.entryId))} /><span aria-hidden="true" /></label>)}</div>}
              <label className="settings-input-row"><span>File (optional)</span><input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="src/main/example.ts" /></label>
              <div className="settings-card-grid"><label className="settings-input-row"><span>First line</span><input type="number" min={1} value={startLine} onChange={(event) => setStartLine(event.target.valueAsNumber)} /></label><label className="settings-input-row"><span>Last line</span><input type="number" min={1} value={endLine} onChange={(event) => setEndLine(event.target.valueAsNumber)} /></label></div>
              <div className="settings-card-actions"><button type="button" className="settings-inline-action" disabled={!enabled || busy} onClick={() => void preview()}>Preview evidence</button></div>
            </details>
            {capture && <section aria-label="Exact provider source preview">
              <div className="settings-title settings-title--spaced"><div><h3>Sources to send</h3><p>Redaction can miss secrets.</p></div></div>
              {excerpts.map((excerpt) => <div key={excerpt.id}><label className="settings-input-row"><span>Source {excerpt.id}</span><textarea value={excerpt.text} onChange={(event) => setExcerpts((previous) => previous.map((item) => item.id === excerpt.id ? { ...item, text: event.target.value } : item))} /></label><div className="settings-card-actions"><button type="button" className="settings-inline-action" aria-label={`Remove source ${excerpt.id}`} onClick={() => setExcerpts((previous) => previous.filter((item) => item.id !== excerpt.id))}>Remove</button></div></div>)}
              <div className="settings-card-actions"><button type="button" className="settings-inline-action" disabled={busy || !excerpts.length} onClick={() => void run(async () => { if (!state.binding) return; const current = generation.current; const next = await getDesktopApi().reviewLearningCapture({ binding: state.binding, captureId: capture.id, excerpts }); if (current === generation.current) { setCapture(next); setExcerpts(next.evidence.map(({ id, text }) => ({ id, text }))); } })}>Accept preview</button></div>
              <label className="settings-input-row"><span>Correction</span><textarea value={intent} maxLength={4000} onChange={(event) => setIntent(event.target.value)} /></label>
              <small>{state.provider ? `${state.provider.provider} · ${state.provider.model} · one request, may cost` : 'No provider. Edit manually.'}</small>
              <div className="settings-card-actions"><button type="button" className="settings-inline-action" aria-label="Generate draft and send reviewed sources" disabled={!enabled || busy || !state.provider || !previewUnchanged} onClick={() => void generate()}>Generate draft</button>{request.current && <button type="button" className="settings-inline-action" onClick={() => { if (state.binding && request.current) void getDesktopApi().cancelLearning({ binding: state.binding, id: request.current }); }}>Cancel generation</button>}</div>
            </section>}
            <div className="settings-card-actions settings-card-actions--panel"><button type="button" className="settings-inline-action" disabled={!enabled || busy || Boolean(capture && !previewUnchanged)} onClick={() => void run(async () => {
              const candidate: unknown = JSON.parse(JSON.stringify(editor.content), (_key, value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.map((item: string) => item.trim()).filter(Boolean) : value);
              const validated = lessonContentSchema.safeParse(candidate);
              if (!validated.success) throw new Error(validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).slice(0, 4).join('; '));
              await mutate({ action: 'save-draft', ...(editor.id ? { id: editor.id } : {}), ...(editor.lessonId ? { lessonId: editor.lessonId } : {}), content: validated.data, evidenceIds: editor.evidenceIds, ...(capture ? { captureId: capture.id } : {}) }); setView('drafts');
            })}>Save draft</button>{editor.id && <><button type="button" className="primary-button" disabled={busy || !editor.review} onClick={() => void run(() => mutate({ action: 'approve', id: editor.id!, digest: editor.review!.digest }, editor.review))}>Approve exact revision</button><button type="button" className="settings-inline-action" disabled={busy} onClick={() => void run(() => mutate({ action: 'reject', id: editor.id! }))}>Reject</button></>}<button type="button" className="settings-inline-action" aria-label="Cancel review" onClick={() => setEditor(null)}>Cancel</button></div>
            {!editor.review && editor.id && <small>Save edits before approving.</small>}
          </section>}
          {view === 'recent' && !editor && <>
            {!recentUse.length && <div className="settings-empty-card"><strong>Nothing sent yet</strong></div>}
            {[...recentUse].reverse().map((manifest) => {
              const handed = manifest.state === 'handed-to-runtime';
              const prepared = manifest.state === 'prepared';
              return <article className="settings-card" key={manifest.dispatchId}>
                <div className="settings-toggle settings-card-head"><div><h3>{handed ? 'Handed to runtime' : prepared ? 'Prepared' : manifest.state}</h3><small>{[handed ? 'Receipt unproven' : prepared ? 'Delivery uncertain' : '', `${manifest.bytes} B`, `~${manifest.estimatedTokens} tokens`].filter(Boolean).join(' · ')}</small></div></div>
                <ul>{manifest.items.map((item) => <li key={item.revisionId}>{scopeName[item.scope ?? manifest.scope]} · {item.revisionId}{(item.scope ?? manifest.scope) !== snapshot.scope ? ' (other scope)' : snapshot.revisions.some((revision) => revision.id === item.revisionId) ? '' : ' (deleted)'} — {item.reasons.join('; ')}</li>)}{manifest.skipped.map((item) => <li key={item.lessonId}>Skipped {item.lessonId}: {item.reason}</li>)}</ul>
              </article>;
            })}
            {snapshot.generationUsage.length > 0 && <><div className="settings-title settings-title--spaced"><div><h3>Generation cost</h3></div></div>{snapshot.generationUsage.map((usage) => <p className="settings-card-status" key={usage.requestId}>{usage.provider}/{usage.model} · {usage.outcome} · {usage.costUsd === null ? 'cost unknown' : `$${usage.costUsd}`} · input {usage.inputTokens ?? 'unknown'} / output {usage.outputTokens ?? 'unknown'}</p>)}</>}
          </>}
        </>}
        <div className="settings-title settings-title--spaced"><div><h3>Reset scope</h3><p>Disable stops use. Reset can't erase text already sent or kept in sessions, exports or backups.</p></div></div>
        <label className="settings-input-row"><span>Type DELETE LEARNING</span><input aria-label="Reset learning confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <div className="settings-card-actions"><button type="button" className="settings-inline-action" aria-label="Reset selected learning scope" disabled={busy || confirmation !== 'DELETE LEARNING' || !state?.binding} onClick={() => void run(async () => {
          if (!state?.binding) return;
          if (snapshot) await mutate({ action: 'reset', confirmation: 'DELETE LEARNING' });
          else if (state.recoveryDigest) setState(await getDesktopApi().recoverLearning({ binding: state.binding, action: 'reset-store', digest: state.recoveryDigest, confirmation: 'DELETE LEARNING' }));
          else throw new Error('Unsafe or oversized store requires manual recovery; no automatic reset is offered.');
          setConfirmation('');
        })}>Reset</button>{state?.recoveryDigest && snapshot && <button type="button" className="settings-inline-action" disabled={busy} onClick={() => void run(async () => { if (state.binding && state.recoveryDigest) setState(await getDesktopApi().recoverLearning({ binding: state.binding, action: 'recover-lock', digest: state.recoveryDigest })); })}>Recover lock</button>}</div>
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
