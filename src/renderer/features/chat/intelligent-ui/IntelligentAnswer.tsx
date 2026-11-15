import { Renderer, type ActionEvent, type OpenUIError, type ParseResult } from '@openuidev/react-lang';
import { Component, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnswerActionsContext, intelligentComponentNames, intelligentFunctionNames, intelligentLibrary } from './library';
import { MAX_PROGRAM_LENGTH, normalizeProgram, programIssue, restoreAnswerState, saveAnswerState } from './safety';
import './intelligent-ui.css';

export interface IntelligentAnswerProps {
  source: string;
  isStreaming?: boolean;
  stateKey?: string;
  onFollowUp?: (text: string) => void;
}

function Source({ source }: { source: string }) {
  return <details className="iui-source"><summary>View source</summary><pre><code>{source.slice(0, MAX_PROGRAM_LENGTH)}{source.length > MAX_PROGRAM_LENGTH ? '\n… source truncated …' : ''}</code></pre></details>;
}

function Failure({ source, reason }: { source: string; reason: string }) {
  return <div className="iui-error" role="alert"><p>Interactive answer unavailable</p><span>{reason.slice(0, 400)}</span><Source source={source} /></div>;
}

class AnswerBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean; source: string }> {
  override state = { failed: false, source: this.props.source };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
    return props.source === state.source ? null : { failed: false, source: props.source };
  }
  override render() {
    return this.state.failed ? <Failure source={this.props.source} reason="This answer could not be displayed. The source is still available." /> : this.props.children;
  }
}

function AnswerRuntime({ source, isStreaming = false, stateKey, onFollowUp }: IntelligentAnswerProps) {
  const program = useMemo(() => {
    const issue = programIssue(source, intelligentComponentNames, intelligentFunctionNames, isStreaming);
    return { issue, response: issue ? '' : normalizeProgram(source) };
  }, [source, isStreaming]);
  const issue = program.issue;
  const initialState = useMemo(() => restoreAnswerState(stateKey), [stateKey]);
  const [feedback, setFeedback] = useState('');
  const [runtimeIssue, setRuntimeIssue] = useState<{ source: string; message: string } | null>(null);
  const [parsed, setParsed] = useState<{ source: string; visible: boolean; unresolved: boolean } | null>(null);
  const lastAllowed = useRef('');
  const current = useRef({ source, isStreaming, onFollowUp, issue });
  current.current = { source, isStreaming, onFollowUp, issue };
  if (!issue) lastAllowed.current = program.response;
  const response = issue && isStreaming ? lastAllowed.current : program.response;
  const onError = useCallback((errors: OpenUIError[]) => {
    const error = errors.find((error) => error.severity !== 'warning');
    const message = error ? error.message : '';
    setRuntimeIssue((previous) => previous?.source === current.current.source && previous.message === message ? previous : { source: current.current.source, message });
  }, []);
  const onParseResult = useCallback((result: ParseResult | null) => {
    const next = { source: current.current.source, visible: Boolean(result?.root || result?.rootExpression), unresolved: Boolean(result?.meta.unresolved.length || result?.meta.incomplete) };
    setParsed((previous) => previous?.source === next.source && previous.visible === next.visible && previous.unresolved === next.unresolved ? previous : next);
  }, []);
  const onStateUpdate = useCallback((state: Record<string, unknown>) => {
    if (!current.current.isStreaming && !current.current.issue) saveAnswerState(stateKey, state);
  }, [stateKey]);
  const onAction = useCallback((event: ActionEvent) => {
    const { onFollowUp, isStreaming, issue } = current.current;
    if (isStreaming || issue || event.type !== 'continue_conversation' || !onFollowUp) return;
    const message = event.humanFriendlyMessage?.trim();
    if (!message || message.length > 4000) { setFeedback('Follow-up is too long.'); return; }
    let payload = message;
    const context = event.params.context;
    if (context !== undefined) {
      const serialized = typeof context === 'string' ? context : JSON.stringify(context);
      if (serialized && serialized.length <= 8000) payload += `\n\nAnswer context:\n${serialized}`;
    }
    if (event.formState && Object.keys(event.formState).length) {
      const serialized = JSON.stringify(event.formState);
      if (serialized.length > 16_000) { setFeedback('Form is too large. Reduce its contents.'); return; }
      payload += `\n\nForm values:\n${serialized}`;
    }
    try {
      onFollowUp(payload);
      setFeedback('Review composer');
    } catch {
      setFeedback('Follow-up failed. Try again.');
    }
  }, []);
  const actions = useMemo(() => ({ canFollowUp: Boolean(onFollowUp), busy: false, feedback: setFeedback }), [onFollowUp]);
  const error = !isStreaming ? issue || (runtimeIssue?.source === source ? runtimeIssue.message : '') || (parsed?.source === source && (!parsed.visible || parsed.unresolved) ? 'This program is incomplete or references missing content.' : '') : '';
  if (issue && !isStreaming) return <Failure source={source} reason={issue} />;
  return <AnswerActionsContext.Provider value={actions}>
    {error ? <Failure source={source} reason={error} /> : null}
    <div hidden={Boolean(error)}>
      <Renderer response={response} library={intelligentLibrary} isStreaming={isStreaming} {...(initialState ? { initialState } : {})} onAction={onAction} onStateUpdate={onStateUpdate} onParseResult={onParseResult} onError={onError} publishObservability={false} toolProvider={null} />
      {isStreaming && (!parsed?.visible || !response) ? <div className="iui-loading" role="status">Building answer…</div> : null}
      {isStreaming && parsed?.visible ? <span className="iui-streaming" role="status">Updating…</span> : null}
      {!isStreaming ? <div className="iui-answer-footer"><Source source={source} /><span className="iui-feedback" role="status" aria-live="polite">{feedback}</span></div> : null}
    </div>
  </AnswerActionsContext.Provider>;
}

export function IntelligentAnswer(props: IntelligentAnswerProps) {
  return <div className="intelligent-answer" aria-label="Interactive answer" aria-busy={props.isStreaming || undefined}><AnswerBoundary source={props.source}><AnswerRuntime key={props.stateKey ?? 'answer'} {...props} /></AnswerBoundary></div>;
}
