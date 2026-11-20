import Editor, { loader } from '@monaco-editor/react';
import * as monaco from './monacoRuntime';
import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { fileLineCount, type DiffLineRange } from '../diffs/diffNoteModel';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

loader.config({ monaco });

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

const readMonacoAppearance = () => ({
  theme: document.documentElement.dataset.themeTone === 'light' ? 'vs' : 'vs-dark',
  fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()
    || '"JetBrains Mono Variable", "Noto Sans Mono Variable", ui-monospace, Consolas, monospace',
});

const useMonacoAppearance = () => {
  const [appearance, setAppearance] = useState(readMonacoAppearance);
  useEffect(() => {
    const sync = () => setAppearance(readMonacoAppearance());
    window.addEventListener('fate-theme-change', sync);
    window.addEventListener('fate-font-change', sync);
    return () => {
      window.removeEventListener('fate-theme-change', sync);
      window.removeEventListener('fate-font-change', sync);
    };
  }, []);
  return appearance;
};

const commonOptions = {
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 19,
  renderWhitespace: 'selection' as const,
  fontLigatures: true,
  padding: { top: 10, bottom: 10 },
};

export function FileMonacoViewer({ value, language, path }: { value: string; language: string; path: string }) {
  const { theme, fontFamily } = useMonacoAppearance();
  return (
    <Editor
      height="100%"
      path={`file://pi-desktop/${path}`}
      language={language}
      value={value}
      theme={theme}
      options={{ ...commonOptions, fontFamily, wordWrap: 'off' }}
      loading={<div className="preview-loading">Loading editor…</div>}
    />
  );
}

export interface DiffViewerProps {
  original: string;
  modified: string;
  language: string;
  path: string;
  review?: {
    split: boolean;
    mark: DiffLineRange | null;
    revealMark: boolean;
    requestRef: MutableRefObject<(() => void) | null>;
    onRequest: (range: DiffLineRange | null) => void;
  };
}

export function DiffMonacoViewer({ original, modified, language, path, review }: DiffViewerProps) {
  const { theme, fontFamily } = useMonacoAppearance();
  const viewerId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const requestRef = review?.requestRef;
  const request = useRef(review?.onRequest);
  useLayoutEffect(() => { request.current = review?.onRequest; }, [review?.onRequest]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Each viewer owns its models, even when two previews show the same path.
    const modelUri = (side: string) => monaco.Uri.from({
      scheme: 'file', authority: 'pi-desktop',
      path: `/diff/${encodeURIComponent(viewerId)}/${side}/${path}`,
    });
    const originalModel = monaco.editor.createModel('', undefined, modelUri('original'));
    const modifiedModel = monaco.editor.createModel('', undefined, modelUri('modified'));
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      ...commonOptions, renderSideBySide: false, originalEditable: false,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      // Monaco requires reset before either attached text model is disposed.
      // Own the whole teardown rather than relying on React DiffEditor's order.
      editor.setModel(null);
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [path, viewerId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !requestRef) return;
    const before = editor.getOriginalEditor();
    const after = editor.getModifiedEditor();
    const lineCounts = { original: fileLineCount(original), modified: fileLineCount(modified) };
    let focused: DiffLineRange['side'] | null = before.hasTextFocus() ? 'original' : after.hasTextFocus() ? 'modified' : null;
    let ready = false;
    const addNote = (side: DiffLineRange['side'] | null) => {
      const selection = side === 'original' ? before.getSelection() : side === 'modified' ? after.getSelection() : null;
      if (!ready || !side || !selection) { request.current?.(null); return; }
      const start = selection.startLineNumber;
      const end = selection.endLineNumber - Number(selection.endLineNumber > start && selection.endColumn === 1);
      const computed = (editor as typeof editor & { getDiffComputationResult?: () => { quitEarly: boolean } | null }).getDiffComputationResult?.();
      const valid = computed?.quitEarly === false && end <= lineCounts[side] && editor.getLineChanges()?.some((change) => side === 'original'
        ? start >= change.originalStartLineNumber && end <= change.originalEndLineNumber
        : start >= change.modifiedStartLineNumber && end <= change.modifiedEndLineNumber);
      request.current?.(valid ? { side, start, end } : null);
    };
    requestRef.current = () => addNote(focused);
    const bindings = [editor.onDidUpdateDiff(() => { ready = true; })];
    for (const [side, codeEditor] of [['original', before], ['modified', after]] as const) {
      bindings.push(codeEditor.onDidFocusEditorText(() => { focused = side; }));
      bindings.push(codeEditor.addAction({
        id: 'fate.diff.localNote', label: 'Add or edit local note',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
        contextMenuGroupId: 'navigation',
        run: () => addNote(side),
      }));
    }
    return () => {
      requestRef.current = null;
      for (const binding of bindings) binding.dispose();
    };
  }, [requestRef, original, modified, path]);

  useEffect(() => {
    const models = editorRef.current?.getModel();
    if (!models) return;
    // A same-path refresh updates live models without replacing or disposing them.
    if (models.original.getValue() !== original) models.original.setValue(original);
    if (models.modified.getValue() !== modified) models.modified.setValue(modified);
    monaco.editor.setModelLanguage(models.original, language);
    monaco.editor.setModelLanguage(models.modified, language);
  }, [original, modified, language, path]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
    editorRef.current?.updateOptions({ fontFamily });
  }, [theme, fontFamily, path]);

  useEffect(() => {
    if (!requestRef) return;
    const editor = editorRef.current;
    editor?.updateOptions({ renderSideBySide: review?.split ?? false, useInlineViewWhenSpaceIsLimited: false, ignoreTrimWhitespace: false });
    editor?.getOriginalEditor().updateOptions({ ariaLabel: 'Before diff editor' });
    editor?.getModifiedEditor().updateOptions({ ariaLabel: 'After diff editor' });
  }, [path, requestRef, review?.split]);

  const mark = review?.mark;
  useEffect(() => {
    if (!mark) return;
    const editor = editorRef.current;
    const codeEditor = mark.side === 'original' ? editor?.getOriginalEditor() : editor?.getModifiedEditor();
    if (!codeEditor || mark.end > (codeEditor.getModel()?.getLineCount() ?? 0)) return;
    const decorations = codeEditor.createDecorationsCollection([{
      range: new monaco.Range(mark.start, 1, mark.end, 1),
      options: { isWholeLine: true, linesDecorationsClassName: 'diff-local-note-mark' },
    }]);
    if (review?.revealMark) codeEditor.revealLinesInCenterIfOutsideViewport(mark.start, mark.end);
    return () => decorations.clear();
  }, [mark, path, review?.revealMark, review?.split]);

  return <div ref={containerRef} style={{ height: '100%', width: '100%' }} />;
}
