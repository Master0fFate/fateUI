import { z } from 'zod';

const connectorName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
const repo = z.string().max(140).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u);
export const monitorWatchSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-actions'), repo, runId: z.string().regex(/^[1-9][0-9]{0,19}$/u), sha: z.string().regex(/^[a-fA-F0-9]{40}$/u) }).strict(),
  z.object({ kind: z.literal('mcp'), connector: connectorName, eventId: identifier, revision: identifier }).strict(),
]);
export type MonitorWatchSource = z.infer<typeof monitorWatchSourceSchema>;
export const monitorWatchResultSchema = z.enum(['success', 'failure', 'cancelled', 'other']);
export type MonitorWatchResult = z.infer<typeof monitorWatchResultSchema>;
export const monitorWatchScopeSchema = z.object({ workspaceRoot: z.string().min(1).max(4096), sessionId: identifier }).strict();
export const MONITOR_FOLLOW_UP_MAX = 2_000;
export const monitorWatchRequestSchema = z.discriminatedUnion('wake', [
  monitorWatchScopeSchema.extend({ source: monitorWatchSourceSchema, wake: z.literal(false) }).strict(),
  monitorWatchScopeSchema.extend({ source: monitorWatchSourceSchema, wake: z.literal(true), followUp: z.string().trim().min(1).max(MONITOR_FOLLOW_UP_MAX) }).strict(),
]);
export const monitorWakeStatusSchema = z.enum(['queued', 'answering', 'reported', 'failed']);
export const monitorWatchStopSchema = monitorWatchScopeSchema.extend({ id: z.string().uuid() }).strict();
export type MonitorWatchRequest = z.infer<typeof monitorWatchRequestSchema>;
export type MonitorWatchStatus = {
  id: string;
  source: MonitorWatchSource;
  state: 'waiting' | 'backoff' | 'completed' | 'stopped' | 'expired' | 'failed';
  result?: MonitorWatchResult;
  wake: boolean;
  wakeStatus?: z.infer<typeof monitorWakeStatusSchema>;
  expiresAt: number;
};
export type MonitorWatchesSnapshot = { connectors: string[]; watches: MonitorWatchStatus[]; wakeAvailable: boolean };
