import * as Popover from '@radix-ui/react-popover';
import { Check, GitBranch, LoaderCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GitBranchRef } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { useSkinComponents } from '../../skins/SkinProvider';
import { useUiStore } from '../../stores/uiStore';
import { messageOf, useWorkspaceStore } from '../../stores/workspaceStore';

const BRANCH_NAME = /^[^\s~^:?*[\\]+$/u;

export function BranchChip({ locked }: { locked: boolean }) {
  const { Symbol } = useSkinComponents();
  const { git, branches, branchesLoading } = useWorkspaceStore(useShallow((state) => ({ git: state.git, branches: state.branches, branchesLoading: state.branchesLoading })));
  const loadBranches = useWorkspaceStore((state) => state.loadBranches);
  const switchBranch = useWorkspaceStore((state) => state.switchBranch);
  const showToast = useUiStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  if (!git?.repository) return null;
  const branch = git.branch || 'HEAD';
  const filter = query.trim();
  const visible = branches.filter((ref) => !ref.worktreePath && (!filter || ref.name.includes(filter)));
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
  const pick = (ref: GitBranchRef) => run(async () => `Switched to ${(await switchBranch({ name: ref.name })).branch || 'HEAD'}`);
  const create = () => run(async () => `Created ${(await switchBranch({ name: filter, create: true })).branch}`);
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(''); void loadBranches(); } }}>
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
          {visible.map((ref) => (
            <button key={`${ref.kind}:${ref.name}`} type="button" data-active={ref.current} disabled={locked || busy || ref.current} onClick={() => void pick(ref)}>
              <GitBranch size={13} aria-hidden="true" />
              <span><strong>{ref.name}{ref.kind === 'remote' && <em>remote</em>}</strong><small>{ref.upstream ?? ''}</small></span>
              {ref.current && <Check size={12} aria-hidden="true" />}
            </button>
          ))}
          {!locked && filter && !exact && (
            <button type="button" disabled={busy || !validName} onClick={() => void create()}>
              <Plus size={13} aria-hidden="true" />
              <span><strong>Create "{filter}"</strong>{!validName && <small>Invalid name</small>}</span>
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
