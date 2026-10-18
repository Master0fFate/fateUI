import { z } from 'zod';
import type { RuntimeState } from './ipc';

const id = z.string().uuid();
const time = z.number().int().safe().nonnegative();
const revision = z.number().int().positive().safe();
const name = z.string().trim().min(1).max(80).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Names cannot contain control characters.');
export const agentPermissionSchema = z.enum(['read-only', 'edit', 'full-access']);
export const agentModelSchema = z.object({ provider: z.string().min(1).max(200), id: z.string().min(1).max(500) }).strict();
export const agentDefaultsSchema = z.object({
  model: agentModelSchema.nullable(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  permission: agentPermissionSchema,
  workspace: z.enum(['shared', 'worktree']),
}).strict();
export const agentDraftSchema = z.object({
  name, description: z.string().max(1000), instructions: z.string().max(65_536),
  skillRefs: z.array(z.string().min(1).max(200)).max(50), defaults: agentDefaultsSchema, enabled: z.boolean(),
}).strict();
export const agentDefinitionSchema = agentDraftSchema.extend({
  schemaVersion: z.literal(1), id, scope: z.enum(['user', 'project']), projectPath: z.string().nullable(),
  revision, createdAt: time, updatedAt: time, deleted: z.boolean(),
}).passthrough();
export const routineDraftSchema = z.object({
  name, agentId: id, message: z.string().trim().min(1).max(200_000), intervalMinutes: z.number().int().min(1).max(10_080),
  timeZone: z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid IANA timezone.'),
  enabled: z.boolean(), notify: z.boolean(), osNotify: z.boolean(),
}).strict();
export const routineDefinitionSchema = routineDraftSchema.extend({
  schemaVersion: z.literal(2), id, revision, createdAt: time, updatedAt: time, deleted: z.boolean(), automationSourceId: id.nullable(),
}).passthrough();
export const agentStateSchema = z.object({
  schemaVersion: z.literal(1), agentId: id, revision, homeSessionId: z.string().nullable(), homeProjectPath: z.string().nullable(),
  appliedRevision: z.number().int().nonnegative(), lastOpenedAt: time.nullable(), lastRunAt: time.nullable(),
}).strict().refine((state) => state.homeSessionId === null ? state.homeProjectPath === null && state.appliedRevision === 0 : state.homeProjectPath !== null && state.appliedRevision > 0, 'Home ownership and applied revision must be complete.');
export const agentRunSchema = z.object({
  schemaVersion: z.literal(2), id: z.string().min(1).max(200), agentId: id, agentRevision: revision, routineId: id.nullable(),
  projectPath: z.string().min(1), request: z.string().max(200_000), mode: z.enum(['turn', 'goal']),
  scheduledFor: time, startedAt: time.nullable(), finishedAt: time.nullable(),
  status: z.enum(['queued', 'running', 'needs-attention', 'succeeded', 'failed', 'skipped']),
  sessionId: z.string().nullable(), resultSummary: z.string().max(4000), error: z.string().max(8000).nullable(), permission: agentPermissionSchema,
}).strict();
export const savedAgentSessionSchema = z.object({
  schemaVersion: z.literal(1), agentId: id, revision, name, instructions: z.string().max(65_536),
  skillRefs: z.array(z.string().min(1).max(200)).max(50), defaults: agentDefaultsSchema,
  background: z.boolean(), runId: z.string().nullable(), projectPath: z.string().min(1),
}).strict();
export const agentLibrarySchema = z.object({
  agents: z.array(agentDefinitionSchema).max(500), routines: z.array(routineDefinitionSchema).max(500),
  runs: z.array(agentRunSchema).max(1000), states: z.array(agentStateSchema).max(500), diagnostics: z.array(z.string()).max(500),
  nextDue: z.record(z.number().nullable()),
}).strict();
const expected = z.object({ revision, digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const agentSaveSchema = z.object({ id: id.optional(), expected: expected.nullable(), value: agentDraftSchema }).strict();
export const routineSaveSchema = z.object({ id: id.optional(), expected: expected.nullable(), value: routineDraftSchema }).strict();
export const libraryItemSchema = z.object({ kind: z.enum(['agent', 'routine']), id, expected }).strict();
export const agentOpenSchema = z.object({ agentId: id }).strict();
export const automationCopyInputSchema = z.object({ automationId: id, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), agentId: id }).strict();
export const legacyImportItemSchema = z.object({
  sourceId: id, sourceDigest: z.string(), name: z.string(), prompt: z.string(), existingRoutineId: id.nullable(), error: z.string().max(8_000).optional(),
}).strict();
export const legacyImportListSchema = z.array(legacyImportItemSchema).max(500);
export const agentsEmptyInputSchema = z.object({}).strict();
export type LegacyImportItem = z.infer<typeof legacyImportItemSchema>;
export const agentRevisionsSchema = z.record(expected);
export const agentLibraryResultSchema = agentLibrarySchema.extend({ revisions: agentRevisionsSchema }).strict();

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDraft = z.infer<typeof agentDraftSchema>;
export type AgentPermission = z.infer<typeof agentPermissionSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export type RoutineDraft = z.infer<typeof routineDraftSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type SavedAgentSession = z.infer<typeof savedAgentSessionSchema>;
export type AgentLibrary = z.infer<typeof agentLibraryResultSchema>;
export type AgentSave = z.infer<typeof agentSaveSchema>;
export type RoutineSave = z.infer<typeof routineSaveSchema>;

export const agentChannels = {
  agentsList: 'agents:list', agentsSave: 'agents:save', agentsSaveRoutine: 'agents:save-routine', agentsDelete: 'agents:delete',
  agentsOpen: 'agents:open', agentsCancel: 'agents:cancel', agentsOpenRun: 'agents:open-run',
  agentsLegacyList: 'agents:legacy-list', agentsCopy: 'agents:copy', agentsChanged: 'agents:changed',
} as const;
export const agentRunIdSchema = z.object({ runId: z.string().min(1).max(200) }).strict();
export const agentChangedSchema = z.object({ agentId: id.optional(), runId: z.string().optional(), status: agentRunSchema.shape.status.optional(), message: z.string().max(8000).optional(), focus: z.boolean().optional() }).strict();
export type AgentChange = z.infer<typeof agentChangedSchema>;
export interface AgentsApi {
  getAgentLibrary(): Promise<AgentLibrary>;
  saveAgentDefinition(input: AgentSave): Promise<AgentDefinition>;
  saveRoutineDefinition(input: RoutineSave): Promise<RoutineDefinition>;
  deleteAgentLibraryItem(input: z.infer<typeof libraryItemSchema>): Promise<void>;
  openAgentConversation(input: z.infer<typeof agentOpenSchema>): Promise<RuntimeState>;
  cancelAgentRun(input: z.infer<typeof agentRunIdSchema>): Promise<void>;
  openAgentRunSession(input: z.infer<typeof agentRunIdSchema>): Promise<RuntimeState>;
  listLegacyAutomations(): Promise<LegacyImportItem[]>;
  copyAutomationToRoutine(input: z.infer<typeof automationCopyInputSchema>): Promise<RoutineDefinition>;
  onAgentLibraryChanged(listener: (event: AgentChange) => void): () => void;
}
