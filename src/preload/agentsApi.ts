import { agentChannels, agentInboxChannels, agentInboxSchema, agentInboxReadSchema, agentNotificationsSchema, agentsEmptyInputSchema, agentLibraryResultSchema, agentSaveSchema, agentDefinitionSchema, routineSaveSchema, routineDefinitionSchema, watchSaveSchema, watchDefinitionSchema, libraryItemSchema, agentOpenSchema, agentRunIdSchema, automationCopyInputSchema, agentChangedSchema, legacyImportListSchema, type AgentsApi } from '../shared/contracts/agents';
import { runtimeStateSchema } from '../shared/contracts/ipc';
import { invoke, subscribe, ignoreResult } from './transport';

export const agentsApi: AgentsApi = {
  getAgentLibrary: () => invoke(agentChannels.agentsList, agentsEmptyInputSchema, agentLibraryResultSchema, {}),
  saveAgentDefinition: (input) => invoke(agentChannels.agentsSave, agentSaveSchema, agentDefinitionSchema, input),
  saveRoutineDefinition: (input) => invoke(agentChannels.agentsSaveRoutine, routineSaveSchema, routineDefinitionSchema, input),
  saveWatchDefinition: (input) => invoke(agentChannels.agentsSaveWatch, watchSaveSchema, watchDefinitionSchema, input),
  deleteAgentLibraryItem: (input) => invoke(agentChannels.agentsDelete, libraryItemSchema, ignoreResult, input),
  openAgentConversation: (input) => invoke(agentChannels.agentsOpen, agentOpenSchema, runtimeStateSchema, input),
  cancelAgentRun: (input) => invoke(agentChannels.agentsCancel, agentRunIdSchema, ignoreResult, input),
  openAgentRunSession: (input) => invoke(agentChannels.agentsOpenRun, agentRunIdSchema, runtimeStateSchema, input),
  listLegacyAutomations: () => invoke(agentChannels.agentsLegacyList, agentsEmptyInputSchema, legacyImportListSchema, {}),
  copyAutomationToRoutine: (input) => invoke(agentChannels.agentsCopy, automationCopyInputSchema, routineDefinitionSchema, input),
  onAgentLibraryChanged: (listener) => subscribe(agentChannels.agentsChanged, agentChangedSchema, listener, () => undefined),
  getAgentInbox: () => invoke(agentInboxChannels.agentsInbox, agentsEmptyInputSchema, agentInboxSchema, {}),
  markAgentInboxRead: (input) => invoke(agentInboxChannels.agentsInboxRead, agentInboxReadSchema, ignoreResult, input),
  setAgentNotifications: (input) => invoke(agentInboxChannels.agentsNotifications, agentNotificationsSchema, ignoreResult, input),
};
