import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorWatchRequest, MonitorWatchSource, MonitorWatchStatus, MonitorWatchesSnapshot } from '../../../shared/contracts/monitorWatches';
import { getMonitorWatchesApiOptional } from '../../platform/api';
import { useRuntimeStore } from '../../stores/runtimeStore';

type Scope = Pick<MonitorWatchRequest, 'workspaceRoot' | 'sessionId'>;
type WatchesApi = NonNullable<ReturnType<typeof getMonitorWatchesApiOptional>>;

const stateLabels: Record<MonitorWatchStatus['state'], string> = {
  waiting: 'Waiting', backoff: 'Retrying', completed: 'Completed', stopped: 'Stopped',
  expired: 'Expired', failed: 'Watch failed',
};

function describeSource(source: MonitorWatchSource) {
  switch (source.kind) {
    case 'github-pr': return { label: `${source.repo} · PR #${source.prNumber}`, revision: source.sha };
    case 'github-actions': return { label: `${source.repo} · Run ${source.runId}`, revision: source.sha };
    case 'mcp': return { label: `${source.connector} · Event ${source.eventId}`, revision: `Revision ${source.revision}` };
  }
}

export function MonitorWatchesPanel({ api, workspaceRoot, sessionId, refresh }: Scope & { api: WatchesApi; refresh: number }) {
  const [snapshot, setSnapshot] = useState<MonitorWatchesSnapshot | null>(null);
  const [readError, setReadError] = useState(false);
  const [stopError, setStopError] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const reading = useRef(false);
  const stopping = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => {
    const { source, runtime } = useRuntimeStore.getState();
    return mounted.current && source === 'desktop' && runtime.project?.trusted && runtime.project.path === workspaceRoot
      && runtime.sessionId === sessionId && getMonitorWatchesApiOptional() === api;
  }, [api, workspaceRoot, sessionId]);
  const read = useCallback(async () => {
    if (reading.current || stopping.current || !current()) return;
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

  const stop = async (id: string) => {
    if (stopping.current || !current()) return;
    ++request.current;
    reading.current = false;
    stopping.current = true;
    setBusy(true);
    setStopError(false);
    try { await api.stopMonitorWatch({ workspaceRoot, sessionId, id }); }
    catch {
      if (current()) setStopError(true);
    } finally {
      stopping.current = false;
      if (current()) { setBusy(false); void read(); }
    }
  };

  return <section className="monitor-watches" aria-label="Completion watches">
    {stopError ? <p role="alert" className="monitor-dashboard-error">Could not confirm the watch stopped. Check its status.</p> : null}
    {readError ? <p role="alert" className="monitor-dashboard-error">Watch status unavailable. Refresh to retry.</p>
      : !snapshot ? <p role="status" className="monitor-watches-note">Loading watches…</p>
        : snapshot.watches.length === 0 ? <div className="monitor-watches-empty">
            <strong>No watches</strong>
            <p className="monitor-watches-note">Ask in chat: “Watch this PR’s CI and tell me when it finishes.”</p>
          </div>
          : <ul className="monitor-watch-list" aria-label="Session watches">
            {snapshot.watches.map(({ id, source, state, result, expiresAt, wakeStatus }) => {
              const canStop = state === 'waiting' || state === 'backoff' || wakeStatus === 'queued' || wakeStatus === 'answering';
              const reply = wakeStatus && { queued: 'Reply queued', answering: 'Preparing reply', reported: 'Reply saved in chat', failed: 'Reply not saved' }[wakeStatus];
              const { label, revision } = describeSource(source);
              return <li key={id} className="monitor-watch-row">
                <div><strong>{label}</strong><small>{revision}</small>
                  <span>{stateLabels[state]}{result ? ` · ${result}` : ''}{reply ? ` · ${reply}` : ''}</span>
                  {canStop ? <small>Expires <time dateTime={new Date(expiresAt).toISOString()}>{new Date(expiresAt).toLocaleString()}</time></small> : null}
                </div>
                {canStop ? <button type="button" className="activity-refresh" aria-label={`Stop watch: ${label}`} disabled={busy}
                  onClick={() => void stop(id)}>Stop</button> : null}
              </li>;
            })}
          </ul>}
  </section>;
}
