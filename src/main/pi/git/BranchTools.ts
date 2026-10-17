import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { GitService } from '../../git/GitService';

type BranchGitService = Pick<GitService, 'listBranches' | 'switchBranch' | 'renameBranch'>;

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }], details: {} };
}

export function createBranchTools(git: BranchGitService, permissionLevel: () => PermissionLevel): ToolDefinition[] {
  return [
    defineTool({
      name: 'git_branch',
      label: 'Git branch',
      description: 'List, create, switch, or rename git branches in the project checkout. Use this instead of bash for any branch request.',
      promptSnippet: 'List, create, switch, or rename git branches in the project checkout',
      promptGuidelines: [
        'When the user asks to create, switch, rename, or list branches, call git_branch. Never run git checkout/switch/branch through bash.',
        'You choose branch names: short kebab-case names that say what the work is, such as fix/composer-branch-chip. Use the name the user gives when they give one.',
        'Creating, switching, or renaming a branch requires Edit files or Full access.',
      ],
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('switch'), Type.Literal('create'), Type.Literal('rename')]),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 250, description: 'Branch name for switch and create; the new name for rename.' })),
        base: Type.Optional(Type.String({ minLength: 1, maxLength: 250, description: 'Start point for create. Defaults to HEAD.' })),
        from: Type.Optional(Type.String({ minLength: 1, maxLength: 250, description: 'Branch to rename. Defaults to the current branch.' })),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_id, params) {
        if (params.action === 'list') {
          const branches = await git.listBranches();
          return text(branches.map((branch) => `${branch.current ? '* ' : '  '}${branch.name}${branch.kind === 'remote' ? ' (remote)' : ''}${branch.worktreePath ? ` (worktree: ${branch.worktreePath})` : ''}`).join('\n') || 'No branches.');
        }
        if (permissionLevel() === 'read-only') throw new Error('Switching branches requires Edit files or Full access.');
        if (!params.name) throw new Error(`git_branch ${params.action} requires a branch name.`);
        if (params.action === 'rename') {
          const status = await git.renameBranch({ to: params.name, ...(params.from ? { from: params.from } : {}) });
          return text(`Renamed ${params.from ?? 'the current branch'} to ${status.branch ?? params.name}.`);
        }
        if (params.action === 'create') {
          const status = await git.switchBranch({ name: params.name, create: true, ...(params.base ? { base: params.base } : {}) });
          return text(`Created and switched to ${status.branch} from ${params.base ?? 'HEAD'}.`);
        }
        const status = await git.switchBranch({ name: params.name });
        return text(`Switched to ${status.branch}.`);
      },
    }),
  ];
}
