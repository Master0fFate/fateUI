import * as Popover from '@radix-ui/react-popover';
import { Check, GitBranch, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GitBranchRef, RuntimeState } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { getDesktopApiOptional, getFateApi } from '../../platform/api';
import { useSkinComponents } from '../../skins/SkinProvider';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { messageOf, useWorkspaceStore } from '../../stores/workspaceStore';

const BRANCH_NAME = /^[^\s~^:?*[\\]+$/u;

export function BranchChip({ locked }: { locked: boolean }) {
  const { Symbol } = useSkinComponents();
  const { git, branches, branchesLoading } = useWorkspaceStore(useShallow((state) => ({ git: state.git, branches: state.branches, branchesLoading: state.branchesLoading })));
  const loadBranches = useWorkspaceStore((state) => state.loadBranches);
  const refreshGit = useWorkspaceStore((state) => state.refreshGit);
  const switchBranch = useWorkspaceStore((state) => state.switchBranch);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const showToast = useUiStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  if (!git?.repository) return null;
  const branch = git.branch || 'HEAD';
  const filter = query.trim();
  const dirty = git.changes.length > 0;
  const visible = branches.filter((ref) => !filter || ref.name.includes(filter));
  const exact = branches.some((ref) => ref.name === filter);
  const validName = BRANCH_NAME.test(filter) && !filter.startsWith('-') && !filter.includes('@{');
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      const message = await work();
      setOpen(false);
      showToast({ kind: 'success', title: 'Branch changed', message });
    } catch (error) {
      showToast({ kind: 'error', title: 'Branch change failed', message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };
  const openWorktree = async (open: () => Promise<RuntimeState>, opened: string) => {
    const previousProject = useRuntimeStore.getState().runtime.project?.path;
    const next = await open();
    setRuntime(next);
    return next.project?.path === previousProject ? 'Worktree unchanged' : opened;
  };
  const pick = (ref: GitBranchRef) => run(async () => {
    if (ref.worktreePath) return openWorktree(() => getFateApi().switchGitWorktree(ref.worktreePath!), `Opened the ${ref.name} worktree`);
    if (dirty) {
      const desktop = getDesktopApiOptional();
      if (!desktop?.openBranchWorktree) throw new Error('Branch worktrees are unavailable.');
      return openWorktree(() => desktop.openBranchWorktree(ref.name), `Opened ${ref.name} in a new worktree · changes stay on ${branch}`);
    }
    return `Switched to ${(await switchBranch({ name: ref.name })).branch || 'HEAD'}`;
  });
  const create = () => run(async () => `Created ${(await switchBranch({ name: filter, create: true })).branch}`);
  const remove = async (ref: GitBranchRef) => {
    const desktop = getDesktopApiOptional();
    if (!desktop?.deleteGitBranch) return;
    setBusy(true);
    try {
      const previousProject = useRuntimeStore.getState().runtime.project?.path;
      const next = await desktop.deleteGitBranch(ref.name);
      setRuntime(next);
      setConfirmingDelete(null);
      const projectChanged = next.project?.path !== previousProject;
      if (ref.current && !projectChanged) {
        showToast({ kind: 'info', title: 'Branch kept', message: 'The worktree change was cancelled.' });
        return;
      }
      if (projectChanged) setOpen(false);
      else {
        await refreshGit();
        await loadBranches();
      }
      showToast({ kind: 'success', title: 'Branch deleted', message: ref.worktreePath || ref.current ? `Deleted ${ref.name} and its worktree` : `Deleted ${ref.name}` });
    } catch (error) {
      showToast({ kind: 'error', title: 'Branch delete failed', message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(''); setConfirmingDelete(null); void loadBranches(); } }}>
      <AppTooltip content={locked ? 'Branch fixed · ask Pi to switch' : 'Switch branch'}>
        <Popover.Trigger asChild>
          <button className="composer-branch" type="button" aria-label={`Branch: ${branch}`} aria-haspopup="dialog" data-locked={locked || undefined}>
            <Symbol text="@"><GitBranch size={14} aria-hidden="true" /></Symbol>
            <span className="icon-label">{branch}</span>
          </button>
        </Popover.Trigger>
      </AppTooltip>
      <Popover.Portal>
        <Popover.Content className="branch-popover" role="dialog" aria-label="Branch" side="top" align="start" sideOffset={9} collisionPadding={12}>
          <div className="branch-popover-search"><input aria-label="Filter branches" placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          {branchesLoading && branches.length === 0 && <div className="branch-popover-loading"><LoaderCircle className="tool-spinner" size={13} /><span className="icon-label">Reading branches…</span></div>}
          {visible.map((ref) => confirmingDelete === ref.name ? (
            <div className="branch-delete-confirm" key={`${ref.kind}:${ref.name}`}>
              <span>Delete {ref.name}{ref.worktreePath || ref.current ? ' and its worktree' : ''}?</span>
              <button type="button" data-danger="true" disabled={busy} onClick={() => void remove(ref)}>Delete</button>
              <button type="button" disabled={busy} onClick={() => setConfirmingDelete(null)}>Cancel</button>
            </div>
          ) : (
            <div className="branch-option" key={`${ref.kind}:${ref.name}`}>
              <button className="branch-pick" type="button" data-active={ref.current} disabled={locked || busy || ref.current} onClick={() => void pick(ref)}>
                <GitBranch size={13} aria-hidden="true" />
                <span><strong>{ref.name}{ref.kind === 'remote' && <em>remote</em>}{ref.worktreePath && <em>worktree</em>}</strong><small>{ref.worktreePath ?? ref.upstream ?? ''}</small></span>
                {ref.current && <Check size={12} aria-hidden="true" />}
              </button>
              {ref.kind === 'local' && !locked && (
                <button className="branch-delete" type="button" aria-label={`Delete ${ref.name}`} disabled={busy} onClick={() => setConfirmingDelete(ref.name)}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
          {!locked && filter && !exact && (
            <button className="branch-pick" type="button" disabled={busy || !validName} onClick={() => void create()}>
              <Plus size={13} aria-hidden="true" />
              <span><strong>Create "{filter}"</strong>{!validName && <small>Invalid name</small>}</span>
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
