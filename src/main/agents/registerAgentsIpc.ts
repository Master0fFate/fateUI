import { BrowserWindow } from 'electron';
import {
  agentChannels, agentsEmptyInputSchema, agentLibraryResultSchema, agentSaveSchema, agentDefinitionSchema, routineSaveSchema, routineDefinitionSchema,
  libraryItemSchema, agentOpenSchema, agentRunIdSchema, automationCopyInputSchema, agentChangedSchema, legacyImportListSchema,
  agentInboxChannels, agentInboxSchema, agentInboxReadSchema, agentNotificationsSchema,
} from '../../shared/contracts/agents';
import { runtimeStateSchema, type RuntimeState } from '../../shared/contracts/ipc';
import type { AgentHome, AgentsService } from './AgentsService';

type Register = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => void;
export interface AgentActivation {
  home(home: AgentHome, owner?: BrowserWindow): Promise<RuntimeState>;
  session(projectPath: string, sessionId: string, owner?: BrowserWindow): Promise<RuntimeState>;
}
export function registerAgentsIpc(handle: Register, agents: AgentsService | undefined, activate: AgentActivation): void {
  const service = () => { if (!agents) throw new Error('Agents service is unavailable.'); return agents; };
  const owner = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? undefined;
  agents?.setChangeSink((change) => {
    const event = agentChangedSchema.parse(change);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(agentChannels.agentsChanged, event);
  });
  handle(agentChannels.agentsList, async (_event, input) => { agentsEmptyInputSchema.parse(input); return agentLibraryResultSchema.parse(await service().list()); });
  handle(agentChannels.agentsSave, async (_event, input) => agentDefinitionSchema.parse(await service().saveAgent(agentSaveSchema.parse(input))));
  handle(agentChannels.agentsSaveRoutine, async (_event, input) => routineDefinitionSchema.parse(await service().saveRoutine(routineSaveSchema.parse(input))));
  handle(agentChannels.agentsDelete, async (_event, input) => { await service().remove(libraryItemSchema.parse(input)); });
  handle(agentChannels.agentsOpen, async (event, input) => runtimeStateSchema.parse(await activate.home(await service().open(agentOpenSchema.parse(input).agentId), owner(event))));
  handle(agentChannels.agentsCancel, async (_event, input) => { await service().cancel(agentRunIdSchema.parse(input).runId); });
  handle(agentChannels.agentsOpenRun, async (event, input) => {
    const target = await service().runSession(agentRunIdSchema.parse(input).runId);
    return runtimeStateSchema.parse(target.routine
      ? await activate.home(await service().open(target.agentId), owner(event))
      : await activate.session(target.projectPath, target.sessionId, owner(event)));
  });
  handle(agentInboxChannels.agentsInbox, async (_event, input) => { agentsEmptyInputSchema.parse(input); return agentInboxSchema.parse(await service().inbox.overview()); });
  handle(agentInboxChannels.agentsInboxRead, async (_event, input) => { const { agentId, itemIds } = agentInboxReadSchema.parse(input); await service().inbox.markRead(agentId, itemIds); });
  handle(agentInboxChannels.agentsNotifications, async (_event, input) => { const { agentId, notify } = agentNotificationsSchema.parse(input); await service().setNotifications(agentId, notify); });
  handle(agentChannels.agentsLegacyList, async (_event, input) => { agentsEmptyInputSchema.parse(input); return legacyImportListSchema.parse(await service().listLegacy()); });
  handle(agentChannels.agentsCopy, async (_event, input) => {
    const parsed = automationCopyInputSchema.parse(input);
    return routineDefinitionSchema.parse(await service().copyAutomation(parsed.automationId, parsed.sourceDigest, parsed.agentId));
  });
}
