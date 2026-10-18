import { z } from 'zod';

export const googleAccessSchema = z.enum(['none', 'read', 'write']);
export const googleStatusSchema = z.object({
  secureStorage: z.boolean(),
  clientId: z.string().max(500).nullable(),
  account: z.string().max(320).nullable(),
  access: googleAccessSchema,
  connecting: z.boolean(),
}).strict();
export const googleClientInputSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(500),
}).strict();
export const googleConnectInputSchema = z.object({ access: z.enum(['read', 'write']) }).strict();

export type GoogleAccess = z.infer<typeof googleAccessSchema>;
export type GoogleStatus = z.infer<typeof googleStatusSchema>;
export type GoogleClientInput = z.infer<typeof googleClientInputSchema>;
export type GoogleConnectInput = z.infer<typeof googleConnectInputSchema>;
