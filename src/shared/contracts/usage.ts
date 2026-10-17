import { z } from 'zod';

export const USAGE_QUERY_DAYS_MAX = 365;
export const USAGE_TOP_ROWS = 10;

const tokens = z.number().int().nonnegative();
const usd = z.number().nonnegative().finite();

export const usageRecordSchema = z.object({
  at: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(500),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(500),
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: tokens,
  costUsd: usd,
}).strict();

const usageTotalsSchema = z.object({ turns: tokens, input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, costUsd: usd }).strict();

export const usageQueryInputSchema = z.object({
  days: z.number().int().min(1).max(USAGE_QUERY_DAYS_MAX).default(30),
}).strict();

export const usageQueryResultSchema = z.object({
  today: usageTotalsSchema,
  window: usageTotalsSchema,
  days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), costUsd: usd, turns: tokens }).strict()).max(USAGE_QUERY_DAYS_MAX),
  models: z.array(usageTotalsSchema.extend({ model: z.string().max(700) })).max(USAGE_TOP_ROWS),
  sessions: z.array(usageTotalsSchema.extend({ sessionId: z.string().max(500) })).max(USAGE_TOP_ROWS),
  dailyBudgetUsd: usd.nullable(),
}).strict();

export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageQueryInput = z.input<typeof usageQueryInputSchema>;
export type UsageQueryResult = z.infer<typeof usageQueryResultSchema>;
