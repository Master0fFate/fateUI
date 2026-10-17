import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getDesktopApiOptional } from '../../platform/api';

export function RecoveryReviewNotice({ projectPath, sessionId }: { projectPath: string | null; sessionId: string | null }) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReasons([]);
    setError(null);
    const api = getDesktopApiOptional();
    if (!projectPath || !sessionId || typeof api?.getRecoveryReview !== 'function') return undefined;
    let current = true;
    api.getRecoveryReview().then((review) => { if (current) setReasons(review.reasons); }, () => undefined);
    return () => { current = false; };
  }, [projectPath, sessionId]);

  if (!reasons.length) return null;

  const acknowledge = async () => {
    const api = getDesktopApiOptional();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      setReasons((await api.acknowledgeRecovery()).reasons);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The review could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <p className="composer-error" role="alert">
      Unfinished before restart: {reasons.join(' · ')}{' '}
      <button type="button" className="activity-refresh" disabled={busy} onClick={() => void acknowledge()}>
        <ShieldCheck size={10} />Continue
      </button>
      {error ? ` ${error}` : null}
    </p>
  );
}
