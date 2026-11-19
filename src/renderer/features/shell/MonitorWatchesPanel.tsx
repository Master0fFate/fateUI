import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MONITOR_FOLLOW_UP_MAX, monitorWatchSourceSchema, type MonitorWatchRequest, type MonitorWatchSource, type MonitorWatchStatus, type MonitorWatchesSnapshot } from '../../../shared/contracts/monitorWatches';
import { getMonitorWatchesApiOptional } from '../../platform/api';
import { useRuntimeStore } from '../../stores/runtimeStore';

type Scope = Pick<MonitorWatchRequest, 'workspaceRoot' | 'sessionId'>;
type WatchesApi = NonNullable<ReturnType<typeof getMonitorWatchesApiOptional>>;

const stateLabels: Record<MonitorWatchStatus['state'], string> = {
  waiting: 'Waiting', backoff: 'Retrying', completed: 'Completed', stopped: 'Stopped',
  expired: 'Expired', failed: 'Watch failed',
};

export function MonitorWatchesPanel({ api, workspaceRoot, sessionId, refresh }: Scope & { api: WatchesApi; refresh: number }) {
  const [snapshot, setSnapshot] = useState<MonitorWatchesSnapshot | null>(null);
  const [readError, setReadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wake, setWake] = useState(false);
  const [kind, setKind] = useState<MonitorWatchSource['kind']>('github-actions');
  const request = useRef(0);
  const reading = useRef(false);
  const mutating = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => {
    const { source, runtime } = useRuntimeStore.getState();
    return mounted.current && source === 'desktop' && runtime.project?.trusted && runtime.project.path === workspaceRoot
      && runtime.sessionId === sessionId && getMonitorWatchesApiOptional() === api;
  }, [api, workspaceRoot, sessionId]);
  const read = useCallback(async () => {
    if (reading.current || mutating.current || !current()) return;
    const id = ++request.current;
    reading.current = true;
    try {
      const next = await api.getMonitorWatches({ workspaceRoot, sessionId });
      if (id !== request.current || !current()) return;
      setSnapshot(next);
      setReadError(false);
    } catch {
      if (id !== request.current || !current()) return;
      setReadError(true);
    } finally {
      if (id === request.current) reading.current = false;
    }
  }, [api, workspaceRoot, sessionId, current]);
  useEffect(() => {
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 5_000);
    return () => { ++request.current; reading.current = false; clearInterval(timer); };
  }, [read, refresh]);

  const mutate = async (action: () => Promise<void>, name: 'start' | 'stop') => {
    if (mutating.current || !current()) return;
    ++request.current;
    reading.current = false;
    mutating.current = true;
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch {
      if (current()) setActionError(name === 'start' ? 'Could not confirm the watch started. Check the source details and list.' : 'Could not confirm the watch stopped. Check its status.');
    } finally {
      mutating.current = false;
      if (current()) { setBusy(false); void read(); }
    }
  };
  const start = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!snapshot || readError) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    const source: MonitorWatchSource = kind === 'github-actions'
      ? { kind, repo: field('repo'), runId: field('runId'), sha: field('sha') }
      : { kind, connector: field('connector'), eventId: field('eventId'), revision: field('revision') };
    const parsed = monitorWatchSourceSchema.safeParse(source);
    if (!parsed.success || (source.kind === 'mcp' && !snapshot.connectors.includes(source.connector))) {
      setActionError(source.kind === 'github-actions' ? 'Enter an owner/repo, numeric run ID, and full 40-character commit SHA.'
        : 'Select an enabled connector and enter a valid event ID and revision.');
      return;
    }
    const scope = { workspaceRoot, sessionId, source: parsed.data };
    const followUp = field('followUp');
    if (wake && !followUp) { setActionError('Enter an instruction for the automatic reply.'); return; }
    void mutate(() => api.startMonitorWatch(wake ? { ...scope, wake: true, followUp } : { ...scope, wake: false }), 'start');
  };

  return <section className="monitor-watches" aria-label="Completion watches">
    <form onSubmit={start}>
      <fieldset className="monitor-watch-fields" disabled={busy || !snapshot || readError}>
        <legend>Watch for completion</legend>
        <label>Source<select aria-label="Source" value={kind} onChange={(event) => { setKind(event.target.value === 'mcp' ? 'mcp' : 'github-actions'); setActionError(null); }}>
          <option value="github-actions">GitHub Actions</option>
          <option value="mcp" disabled={!snapshot?.connectors.length}>MCP connector</option>
        </select></label>
        {kind === 'github-actions' ? <>
          <label>Repository<input name="repo" placeholder="owner/repo" autoComplete="off" required maxLength={140} /></label>
          <label>Run ID<input name="runId" inputMode="numeric" autoComplete="off" required maxLength={20} /></label>
          <label>Commit SHA<input name="sha" autoComplete="off" required maxLength={40} /></label>
        </> : <>
          <label>Connector<select aria-label="Connector" name="connector" defaultValue="" required><option value="" disabled>Select a connector</option>
            {snapshot?.connectors.map((connector) => <option key={connector} value={connector}>{connector}</option>)}
          </select></label>
          <label>Event ID<input name="eventId" autoComplete="off" required maxLength={80} /></label>
          <label>Revision<input name="revision" autoComplete="off" required maxLength={80} /></label>
        </>}
        <label className="monitor-watch-opt-in"><input type="checkbox" checked={wake} onChange={(event) => setWake(event.target.checked)} /> Automatically reply in this chat when the watch completes</label>
        {wake ? <>
          <label>Follow-up instruction<input name="followUp" placeholder="Summarize the result and suggest a next step" required maxLength={MONITOR_FOLLOW_UP_MAX} /></label>
          <p className="monitor-watches-note">When this chat is idle, its model receives the completion facts and your instruction. The reply is saved here without switching chats or running tools.</p>
        </> : <p className="monitor-watches-note">Without an automatic reply, results stay in Monitor.</p>}
        <button type="submit" className="activity-refresh monitor-watch-start" disabled={kind === 'mcp' && !snapshot?.connectors.length}>Start watch</button>
      </fieldset>
    </form>
    {actionError ? <p role="alert" className="monitor-dashboard-error">{actionError}</p> : null}
    {readError ? <p role="alert" className="monitor-dashboard-error">Watch status unavailable. Refresh to retry.</p>
      : !snapshot ? <p role="status" className="monitor-watches-note">Loading watches…</p>
        : snapshot.watches.length === 0 ? <p className="monitor-watches-note">No watches for this session.</p>
          : <ul className="monitor-watch-list" aria-label="Session watches">
            {snapshot.watches.map(({ id, source, state, result, expiresAt, wakeStatus }) => {
              const canStop = state === 'waiting' || state === 'backoff' || wakeStatus === 'queued' || wakeStatus === 'answering';
              const reply = wakeStatus && { queued: 'Reply queued', answering: 'Preparing reply', reported: 'Reply saved in chat', failed: 'Reply not saved' }[wakeStatus];
              const label = source.kind === 'github-actions' ? `${source.repo} · Run ${source.runId}` : `${source.connector} · Event ${source.eventId}`;
              return <li key={id} className="monitor-watch-row">
                <div><strong>{label}</strong><small>{source.kind === 'github-actions' ? source.sha : `Revision ${source.revision}`}</small>
                  <span>{stateLabels[state]}{result ? ` · ${result}` : ''}{reply ? ` · ${reply}` : ''}</span>
                  {canStop ? <small>Expires <time dateTime={new Date(expiresAt).toISOString()}>{new Date(expiresAt).toLocaleString()}</time></small> : null}
                </div>
                {canStop ? <button type="button" className="activity-refresh" aria-label={`Stop watch: ${label}`} disabled={busy}
                  onClick={() => void mutate(() => api.stopMonitorWatch({ workspaceRoot, sessionId, id }), 'stop')}>Stop</button> : null}
              </li>;
            })}
          </ul>}
  </section>;
}
