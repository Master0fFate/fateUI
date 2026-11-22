import { useEffect, useState } from 'react';
import type { RecoveryReview as Review, RecoveryScope } from '../../../shared/contracts/ipc';
import { getDesktopApiOptional, getWebApiOptional } from '../../platform/api';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

const hideNotice = (id: string) => useUiStore.setState(({ dismissedRecoveryNotices }) => ({
  dismissedRecoveryNotices: [...dismissedRecoveryNotices.filter((key) => key !== id).slice(-127), id],
}));

export function RecoveryReview({ details = false }: { details?: boolean }) {
  const projectPath = useRuntimeStore(({ runtime }) => runtime.project?.trusted ? runtime.project.path : null);
  const sessionId = useRuntimeStore(({ runtime }) => runtime.sessionId);
  if (!projectPath || !sessionId || getWebApiOptional() || !getDesktopApiOptional()?.getRecoveryReview) return null;
  return <SessionRecovery key={JSON.stringify([projectPath, sessionId])} projectPath={projectPath} sessionId={sessionId} details={details} />;
}

function SessionRecovery({ projectPath, sessionId, details }: RecoveryScope & { details: boolean }) {
  const [{ reasons, noticeId }, setReview] = useState<Review>({ reasons: [], noticeId: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const running = useRuntimeStore(({ runtime }) => details && Boolean(runtime.streaming || runtime.activeSessionRunning || runtime.sessionOperation));
  const hidden = useUiStore((state) => noticeId !== null && state.dismissedRecoveryNotices.includes(noticeId));

  useEffect(() => {
    let current = true;
    const api = getDesktopApiOptional();
    setError(null);
    api?.getRecoveryReview({ projectPath, sessionId }).then(
      (review) => { if (current) setReview(review); },
      () => { if (current) setError('Could not load the recovery review.'); },
    );
    return () => { current = false; };
  }, [projectPath, sessionId, attempt]);

  if (!details) return !noticeId || hidden ? null : (
    <div className="recovery-notice">
      <span role="status">Past work may be incomplete.</span>
      <button type="button" onClick={() => useUiStore.getState().openSettingsSection('workspace')}>Review</button>
      <button type="button" onClick={() => hideNotice(noticeId)}>Dismiss</button>
    </div>
  );

  const acknowledge = async () => {
    const api = getDesktopApiOptional();
    if (!api || running || busy) return;
    setBusy(true);
    setError(null);
    try {
      const review = await api.acknowledgeRecovery({ projectPath, sessionId });
      setReview(review);
      if (!review.reasons.length && noticeId) hideNotice(noticeId);
    } catch {
      setError('Could not confirm acknowledgment. Wait until work is idle, then retry.');
    } finally {
      setBusy(false);
    }
  };

  if (!reasons.length && !error) return null;
  return (
    <section aria-label="Session recovery">
      <div className="settings-title"><div><h3>Session recovery</h3></div></div>
      {reasons.length > 0 && <>
        <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <p>Acknowledging records your review. It does not verify or resume past work.</p>
        {running && <p role="status">Wait for work to finish before acknowledging.</p>}
        <button type="button" className="settings-inline-action" disabled={running || busy} onClick={() => void acknowledge()}>{busy ? 'Saving…' : 'Acknowledge recovery'}</button>
      </>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      {error && !reasons.length && <button type="button" className="settings-inline-action" onClick={() => setAttempt((n) => n + 1)}>Retry</button>}
    </section>
  );
}
