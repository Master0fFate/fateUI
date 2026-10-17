import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { hookListSchema } from '../../shared/contracts/hooks';
import type { PermissionLevel } from '../../shared/contracts/ipc';
import { defaultLspServers, lspServerListSchema } from '../../shared/contracts/lsp';
import { createFateHooksExtension } from './hooks/FateHooks';
import { JsonConfigFile } from './JsonConfigFile';
import { createLspDiagnosticsExtension, createLspTools } from './lsp/LspTools';
import { lspWorkspaceFor } from './lsp/LspWorkspace';
import { createContextInspectorExtension } from './context/ContextInspector';
import { createSkillPromptExtension } from './context/SkillPromptTrim';
import { createFateUsageExtension, usageLedgerFor } from './usage/UsageLedger';
import { fateDataRoot } from './FateProviderStorage';

export const HOOKS_CONFIG_FILE = 'hooks.json';
export const LSP_CONFIG_FILE = 'lsp-servers.json';

export const hooksConfigFile = (dataRoot?: string) => new JsonConfigFile(hookListSchema, HOOKS_CONFIG_FILE, [], dataRoot);
export const lspConfigFile = (dataRoot?: string) => new JsonConfigFile(lspServerListSchema, LSP_CONFIG_FILE, [...defaultLspServers], dataRoot);

export interface FateSessionExtensionsInput {
  dataRoot?: string | undefined;
  projectRoot: string;
  resolvePermissionLevel: () => PermissionLevel | null;
  dailyBudgetUsd?: (() => number | null) | undefined;
}

export interface FateSessionExtensions {
  extensions: InlineExtension[];
  lspTools: ToolDefinition[];
}

export async function loadFateSessionExtensions(input: FateSessionExtensionsInput): Promise<FateSessionExtensions> {
  const [hooks, servers] = await Promise.all([
    hooksConfigFile(input.dataRoot).list().catch(() => []),
    lspConfigFile(input.dataRoot).list().catch(() => [...defaultLspServers]),
  ]);
  const workspace = servers.some((server) => server.enabled) ? lspWorkspaceFor(input.projectRoot, servers) : null;
  const hooksExtension = createFateHooksExtension({ hooks, projectRoot: input.projectRoot, resolvePermissionLevel: input.resolvePermissionLevel });
  const usage = createFateUsageExtension({ ledger: usageLedgerFor(input.dataRoot ?? fateDataRoot()), projectRoot: input.projectRoot, ...(input.dailyBudgetUsd ? { dailyBudgetUsd: input.dailyBudgetUsd } : {}) });
  return {
    extensions: [...(hooksExtension ? [hooksExtension] : []), ...(workspace ? [createLspDiagnosticsExtension(workspace)] : []), createContextInspectorExtension(), createSkillPromptExtension(), usage],
    lspTools: workspace ? createLspTools(workspace) : [],
  };
}
