import { getFateApi, getWebApiOptional } from '../../platform/api';
import type { InputOf } from '../../../shared/protocol/methods';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, GitBranch, GitMerge, GitPullRequest, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentTeam, AgentTeamNode } from '../../../shared/contracts/multiAgent';
import { AppTooltip } from '../../components/AppTooltip';
import { InlineConfirm } from '../../components/InlineConfirm';
import { SelectControl } from '../../components/SelectControl';
import { useSkinComponents } from '../../skins/SkinProvider';
import { canMutateNetwork, selectSessionView, useRuntimeStore, type NetworkTeam, type NetworkTeamNode } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { draftScopeKey, useScopedDraft } from '../goalmaxxing/scopedDraft';
const checkpointDrafts = new Map<string, string>();

function useWorkspaceControl() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const control = async (input: InputOf<'agent.workspace'>): Promise<boolean> => {
    if (pendingRef.current) return false;
    const web = getWebApiOptional();
    if (web) return useRuntimeStore.getState().runNetworkMutation(web, 'agent.control', (scope) => web.agentWorkspace(scope, input));
    const origin = useRuntimeStore.getState().runtime;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const state = await getFateApi().controlAgentTeam({ action: 'workspace', ...input, operationId: crypto.randomUUID() });
      const current = useRuntimeStore.getState().runtime;
      if (current.sessionId !== origin.sessionId || current.project?.path !== origin.project?.path) return false;
      useRuntimeStore.getState().setRuntime(state);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace action failed. Your files have been retained.');
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { control, pending, error };
}

type Confirmation = 'checkpoint' | 'integrate' | 'cleanup' | null;

export function AgentWorkspaceDetails({ team, node }: { team: AgentTeam | NetworkTeam; node: AgentTeamNode | NetworkTeamNode }) {
  const { ActionContent } = useSkinComponents();
  const compactMode = useUiStore((state) => state.compactMode);
  const web = getWebApiOptional();
  const networkBusy = useRuntimeStore((state) => state.networkBusy);
  const displayName = 'displayName' in node ? node.displayName : node.handle || node.path;
  const workspace = node.workspace;
  const parentPath = workspace && 'parentPath' in workspace && typeof workspace.parentPath === 'string' ? workspace.parentPath : 'parent checkout on host';
  const checkoutLabel = workspace && 'path' in workspace && typeof workspace.path === 'string' ? workspace.path
    : 'projectPath' in team && typeof team.projectPath === 'string' ? team.projectPath : 'Host-scoped checkout; path withheld';
  const { control, pending, error } = useWorkspaceControl();
  const rootStreaming = useRuntimeStore((state) => web ? selectSessionView(state).activeSessionRunning : state.runtime.streaming);
  const permission = useRuntimeStore((state) => selectSessionView(state).permissionLevel);
  const checkpointKey = `${draftScopeKey(web)}:team:${team.id}:workspace:${node.id}`;
  const [message, setMessage] = useScopedDraft(checkpointDrafts, checkpointKey, () => '');
  const [strategy, setStrategy] = useState<'ff-only' | 'cherry-pick'>('ff-only');
  const [commits, setCommits] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = workspace?.review;
  const reviewLabel = review ? 'Refresh review' : 'Review changes';
  useEffect(() => { setCommits([]); setConfirmation(null); }, [review?.sourceHead, review?.targetHead, review?.reviewedAt]);
  const owned = workspace?.mode === 'worktree';
  const removed = workspace?.state === 'removed';
  const active = node.status === 'active' || node.status === 'creating' || node.status === 'closing';
  const readOnly = (permission ?? team.nodes.find((candidate) => candidate.id === team.rootNodeId)?.permissionLevel) === 'read-only';
  const unavailable = pending || networkBusy || Boolean(web && !canMutateNetwork(web, 'agent.control'));
  const cannotMutate = unavailable || active || rootStreaming === true || web !== null && rootStreaming === null || readOnly || removed;
  const targetNode = team.nodes.find((candidate) => candidate.id === node.parentNodeId);
  const parentLabel = targetNode ? 'displayName' in targetNode && typeof targetNode.displayName === 'string' ? targetNode.displayName : targetNode.handle : 'Parent';
  const directChild = node.parentNodeId === team.rootNodeId;
  const canIntegrate = directChild && !cannotMutate && Boolean(review?.targetBranch && !review.dirty && !review.targetDirty && !review.truncated && review.commits.length > 0 && (strategy === 'ff-only' || commits.length > 0));
  const act = async (operation: 'review' | 'checkpoint' | 'integrate' | 'cleanup') => {
    if (web && checkpointKey !== `${draftScopeKey(web)}:team:${team.id}:workspace:${node.id}`) return;
    setNotice(null);
    const ok = await control({
      teamId: team.id, target: node.id, operation,
      ...(operation === 'checkpoint' ? { message: message.trim() } : {}),
      ...(operation === 'integrate' && review ? {
        strategy, expectedSourceHead: review.sourceHead, expectedTargetHead: review.targetHead,
        ...(strategy === 'cherry-pick' ? { commits } : {}),
      } : {}),
    });
    if (ok) {
      setConfirmation(null);
      if (operation === 'checkpoint') { setMessage(''); setNotice('Checkpoint committed. Review again before integrating.'); }
      if (operation === 'integrate') setNotice('Integrated. Worktree kept.');
      if (operation === 'cleanup') setNotice('Worktree removed. Branch kept.');
    }
  };
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="agent-workspace-trigger" aria-label={`Workspace for ${displayName}`}>
          <GitBranch size={12} /><span>{owned ? removed ? 'Removed worktree' : 'Isolated worktree' : 'Shared workspace'}</span>
          {owned && workspace.branch ? <small title={workspace.branch}>{workspace.branch}</small> : null}
          <ArrowUpRight size={11} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="agent-workspace-overlay" />
        <Dialog.Content className="agent-workspace-dialog" aria-describedby={undefined}>
          <header className="agent-workspace-dialog-header">
            <div><Dialog.Title>{displayName} workspace</Dialog.Title><span>{owned ? removed ? 'Removed worktree' : 'Isolated Git worktree' : 'Shared checkout'} · {node.status}</span></div>
            <Dialog.Close aria-label="Close workspace"><ActionContent text="close"><X size={16} /></ActionContent></Dialog.Close>
          </header>
      <div className="agent-workspace-body" role="region" aria-label={`${displayName} workspace`}>
        <dl className="agent-workspace-facts">
          <dt>Checkout</dt><dd><code>{checkoutLabel}</code></dd>
          {owned ? <><dt>Branch</dt><dd><code>{workspace.branch}</code></dd>
            {'baseCommit' in workspace ? <><dt>Base</dt><dd><code title={workspace.baseCommit}>{workspace.baseRef ?? 'HEAD'} · {workspace.baseCommit?.slice(0, 12)}</code></dd></> : null}
            <dt>Integrate into</dt><dd><code>{parentPath}</code> · {parentLabel}</dd></> : null}
        </dl>
        <p>{owned ? 'Separate checkout, not a security sandbox. Full access reaches the host.' : 'Shares files with its parent.'}</p>
        {owned && !removed ? <>
          <div className="agent-workspace-actions">
            <button type="button" disabled={unavailable || active} aria-label={reviewLabel} onClick={() => void act('review')}><RefreshCw size={12} className={pending ? 'tool-spinner' : undefined} /><ActionContent text={reviewLabel.toLowerCase()}>{reviewLabel}</ActionContent></button>
            <AppTooltip content="Close the agent first. Dirty worktrees stay." wrapTrigger><button type="button" disabled={cannotMutate || (node.status !== 'closed' && node.status !== 'released')} aria-label="Remove worktree" onClick={() => setConfirmation('cleanup')}><Trash2 size={12} /><ActionContent text="remove worktree">Remove worktree</ActionContent></button></AppTooltip>
          </div>
          {active ? <p>Stop agents using this checkout.</p> : null}
          {rootStreaming ? <p>Parent running. Integrate and remove paused.</p> : null}
          {!directChild ? <p>Only the direct parent can checkpoint or integrate.</p> : null}
          {review ? <div className="agent-workspace-review">
            <strong>{review.truncated ? 'Incomplete review' : review.dirty ? 'Uncommitted work' : `${review.commits.length} commit${review.commits.length === 1 ? '' : 's'} to review`}</strong>
            <dl className="agent-workspace-facts"><dt>Source HEAD</dt><dd><code>{review.sourceHead.slice(0, 12)}</code></dd><dt>Parent HEAD</dt><dd><code>{review.targetBranch ?? 'Detached HEAD'} · {review.targetHead.slice(0, 12)}</code></dd></dl>
            {review.targetDirty ? <p className="agent-workspace-warning">Parent has uncommitted changes. Commit or stash first.</p> : null}
            {review.truncated ? <p className="agent-workspace-warning">Review incomplete. Integration off.</p> : null}
            <pre aria-label="Workspace diff" tabIndex={0}>{review.diff || 'No text diff.'}</pre>
            {review.dirty ? <>
              <label>Checkpoint message<input value={message} maxLength={500} placeholder="Describe the agent’s changes" disabled={cannotMutate} onChange={(event) => setMessage(event.target.value)} /></label>
              <p>Commits locally. Parent untouched.</p>
              <div className="agent-workspace-actions"><button type="button" disabled={cannotMutate || !directChild || !message.trim()} aria-label="Commit checkpoint" onClick={() => setConfirmation('checkpoint')}><Save size={12} /><ActionContent text="commit checkpoint">Commit checkpoint</ActionContent></button></div>
            </> : null}
            {review.commits.length ? <>
              <div className="settings-select-field"><span>Integration</span><SelectControl compact={compactMode} label="Integration method" value={strategy} disabled={cannotMutate} options={[{ value: 'ff-only', label: 'Fast-forward' }, { value: 'cherry-pick', label: 'Cherry-pick' }]} onValueChange={(value) => { setStrategy(value as 'ff-only' | 'cherry-pick'); setConfirmation(null); }} /></div>
              <div className="agent-workspace-commits" aria-label="Workspace commits">{review.commits.map((commit) => <label key={commit.hash}>
                {strategy === 'cherry-pick' ? <input type="checkbox" aria-label={`Select commit ${commit.hash.slice(0, 12)}`} checked={commits.includes(commit.hash)} disabled={cannotMutate} onChange={(event) => setCommits((current) => event.target.checked ? [...current, commit.hash] : current.filter((hash) => hash !== commit.hash))} /> : <GitPullRequest size={12} />}
                <span><code>{commit.hash.slice(0, 8)}</code> {commit.subject}</span>
              </label>)}</div>
              <p>{strategy === 'ff-only' ? 'Parent must not have diverged.' : 'Applies selected commits in order.'} HEADs are rechecked first.</p>
              <div className="agent-workspace-actions"><button type="button" className="agent-workspace-primary" disabled={!canIntegrate} aria-label="Integrate changes" onClick={() => setConfirmation('integrate')}><GitMerge size={12} /><ActionContent text="integrate changes">Integrate changes</ActionContent></button></div>
            </> : null}
          </div> : null}
        </> : null}
        {notice ? <p role="status" className="agent-workspace-success">{notice}</p> : null}
        {error ? <p className="agent-workspace-error" role="alert">{error}</p> : null}
        {confirmation ? <InlineConfirm
          title={confirmation === 'cleanup' ? `Remove ${displayName} worktree?` : confirmation === 'checkpoint' ? 'Commit agent changes?' : `Integrate into ${parentLabel}?`}
          message={confirmation === 'cleanup' ? 'Removes only this clean, inactive checkout. The branch and agent history stay available. This cannot be undone.' : confirmation === 'checkpoint' ? 'Commits all worktree changes locally. Parent untouched.' : `Applies the reviewed ${strategy === 'ff-only' ? 'branch' : `${commits.length} commit(s)`} to ${parentPath}. Stale reviews and dirty checkouts are refused.`}
          confirmLabel={confirmation === 'cleanup' ? 'Remove worktree' : confirmation === 'checkpoint' ? 'Commit checkpoint' : 'Integrate'}
          busy={pending || (confirmation === 'integrate' ? !canIntegrate : cannotMutate)}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void act(confirmation)}
        /> : null}
      </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
