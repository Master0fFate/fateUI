import { useRef, useState } from 'react';
import { getDesktopApiOptional, getWebApiOptional } from '../../platform/api';
import { isReviewHead } from './diffNoteModel';

export function getLocalPullRequestReader() {
  if (getWebApiOptional()) return undefined;
  const desktop = getDesktopApiOptional();
  return typeof desktop?.getPullRequestStatus === 'function' ? desktop.getPullRequestStatus : undefined;
}

type Reader = NonNullable<ReturnType<typeof getLocalPullRequestReader>>;
type Status = Awaited<ReturnType<Reader>>;
type Lookup = { head: string; branch: string; phase: 'loading' | 'error' | 'stale' } | { head: string; branch: string; phase: 'result'; status: Status };
const recentResults = new Map<string, Lookup>();

function rememberResult(project: string, result: Lookup) {
  recentResults.delete(project);
  recentResults.set(project, result);
  if (recentResults.size > 24) recentResults.delete(recentResults.keys().next().value!);
}

const unavailableCopy = {
  'no-pr': 'No PR for this HEAD',
  'not-github': 'No GitHub remote',
  'not-published': 'HEAD not published to origin',
  ambiguous: 'No unique PR match',
  busy: 'PR lookup busy · Try again',
  'gh-missing': 'GitHub CLI not installed',
  'head-changed': 'Stale · Refresh Git status',
  'auth-or-network': 'GitHub sign-in or connection failed',
} as const;

function checkSummary(status: Extract<Status, { kind: 'available' }>) {
  const counts = { passed: 0, failed: 0, pending: 0, other: 0 };
  for (const check of status.checks) counts[check.state] += 1;
  const labels = (['failed', 'pending', 'passed', 'other'] as const)
    .flatMap((state) => counts[state] ? [`${counts[state]} ${state}`] : []);
  if (status.checksTruncated) labels.push('partial');
  return labels.length ? labels.join(' · ') : 'No checks';
}

export function PullRequestStatus({ project, head, branch, busy }: { project: string; head: string | null; branch: string; busy: boolean }) {
  const [lookup, setLookup] = useState<Lookup | null>(() => recentResults.get(project) ?? null);
  const inFlight = useRef(false);
  const requestStatus = async () => {
    const read = getLocalPullRequestReader();
    if (!read || !isReviewHead(head) || busy || inFlight.current) return;
    inFlight.current = true;
    setLookup({ head, branch, phase: 'loading' });
    try {
      const status = await read(project, head, branch);
      const result: Lookup = status.head === head ? { head, branch, phase: 'result', status } : { head, branch, phase: 'stale' };
      rememberResult(project, result);
      setLookup(result);
    } catch {
      setLookup({ head, branch, phase: 'error' });
    } finally {
      inFlight.current = false;
    }
  };
  const stale = Boolean(lookup && (lookup.head !== head || lookup.branch !== branch || lookup.phase === 'stale'
    || (lookup.phase === 'result' && lookup.status.kind === 'unavailable' && lookup.status.reason === 'head-changed')));
  const result = !stale && lookup?.phase === 'result' ? lookup.status : null;
  const loading = !stale && lookup?.phase === 'loading';
  const summary = stale ? (lookup?.head !== head ? 'Stale · HEAD changed' : lookup.branch !== branch ? 'Stale · Branch changed' : 'Stale · Refresh Git status')
    : loading ? 'Checking GitHub…'
      : lookup?.phase === 'error' ? 'Could not check GitHub'
        : result?.kind === 'unavailable' ? unavailableCopy[result.reason]
          : head ? 'Not checked' : 'No confirmed HEAD';
  const statusText = result?.kind === 'available'
    ? `${result.state === 'OPEN' ? result.draft ? 'Draft' : 'Open' : result.state === 'MERGED' ? 'Merged' : 'Closed'} · ${checkSummary(result)}`
    : '';
  const checkedAt = result?.kind === 'available' ? new Date(result.checkedAt) : null;
  const blocked = !head || !branch || busy || lookup?.phase === 'loading';
  return (
    <div className="diff-pr-status" role="group" aria-label="GitHub pull request status">
      <div className="diff-pr-status-copy" role="status" data-stale={stale || undefined} data-result={result?.kind === 'available' || undefined}>
        <span className="diff-pr-status-primary" title={result?.kind === 'available' ? result.title : undefined}>
          <strong>{result?.kind === 'available' ? `PR #${result.number}` : 'PR status'}</strong>
          {result?.kind === 'available' && <span className="diff-pr-title">{result.title}</span>}
        </span>
        <span title={checkedAt ? `Checked ${checkedAt.toLocaleString()}` : undefined}>{statusText || ` · ${summary}`}{checkedAt && <> · <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></>}</span>
      </div>
      <button className="diff-review-button" type="button" aria-disabled={blocked} aria-label="Check pull request status" title={head ? `Check GitHub for ${head}` : 'A committed HEAD is required'} onClick={() => void requestStatus()}>Check PR</button>
    </div>
  );
}
