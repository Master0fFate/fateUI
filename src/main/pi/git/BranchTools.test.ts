// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { GitBranchRef, GitStatus, PermissionLevel } from '../../../shared/contracts/ipc';
import { createBranchTools } from './BranchTools';

const status = (branch: string): GitStatus => ({ repository: true, branch, upstream: null, pushTarget: null, ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false });
const branches: GitBranchRef[] = [
  { name: 'main', kind: 'local', current: true, worktreePath: null, upstream: 'origin/main' },
  { name: 'second', kind: 'local', current: false, worktreePath: 'C:/worktrees/second', upstream: null },
  { name: 'remote-only', kind: 'remote', current: false, worktreePath: null, upstream: 'origin/remote-only' },
];

function setup(level: PermissionLevel) {
  const git = { listBranches: vi.fn(async () => branches), switchBranch: vi.fn(async (input: { name: string }) => status(input.name)), renameBranch: vi.fn(async (input: { to: string }) => status(input.to)) };
  const [tool] = createBranchTools(git, () => level);
  const run = (params: Record<string, unknown>) => tool!.execute('call', params as never, undefined, undefined, {} as never);
  return { git, run };
}

describe('git_branch tool', () => {
  it('lists branches at read-only and refuses to switch or create', async () => {
    const { git, run } = setup('read-only');
    const listed = await run({ action: 'list' });
    expect((listed.content[0] as { text: string }).text).toBe('* main\n  second (worktree: C:/worktrees/second)\n  remote-only (remote)');
    await expect(run({ action: 'switch', name: 'second' })).rejects.toThrow('Edit files or Full access');
    await expect(run({ action: 'create', name: 'topic' })).rejects.toThrow('Edit files or Full access');
    expect(git.switchBranch).not.toHaveBeenCalled();
  });

  it('delegates switch and create to the git service at edit access', async () => {
    const { git, run } = setup('edit');
    expect((await run({ action: 'switch', name: 'second' })).content[0]).toMatchObject({ text: 'Switched to second.' });
    expect(git.switchBranch).toHaveBeenLastCalledWith({ name: 'second' });
    expect((await run({ action: 'create', name: 'topic', base: 'main' })).content[0]).toMatchObject({ text: 'Created and switched to topic from main.' });
    expect(git.switchBranch).toHaveBeenLastCalledWith({ name: 'topic', create: true, base: 'main' });
    await expect(run({ action: 'switch' })).rejects.toThrow('requires a branch name');
  });
});
