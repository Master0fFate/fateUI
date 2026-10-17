import { z } from 'zod';

export const hookEvents = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'] as const;
export const HOOK_TIMEOUT_DEFAULT_SECONDS = 60;
export const HOOK_TIMEOUT_MAX_SECONDS = 600;

const hookNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const matcherSchema = z.string().trim().max(200).refine((value) => {
  try { new RegExp(value); return true; } catch { return false; }
}, 'The matcher must be a valid regular expression.');

export const hookDefinitionSchema = z.object({
  name: hookNameSchema,
  enabled: z.boolean(),
  event: z.enum(hookEvents),
  matcher: matcherSchema.optional(),
  command: z.string().trim().min(1).max(4_096),
  timeoutSeconds: z.number().int().min(1).max(HOOK_TIMEOUT_MAX_SECONDS).default(HOOK_TIMEOUT_DEFAULT_SECONDS),
}).strict();

export const hookListSchema = z.array(hookDefinitionSchema).max(64).refine(
  (hooks) => new Set(hooks.map((hook) => hook.name)).size === hooks.length,
  'Hook names must be unique.',
);

export type HookEvent = typeof hookEvents[number];
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;
export type HookDefinitionInput = z.input<typeof hookDefinitionSchema>;
