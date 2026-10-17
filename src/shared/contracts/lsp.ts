import { z } from 'zod';

const lspServerNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const fileExtensionSchema = z.string().regex(/^\.[a-z0-9]{1,15}$/i);

export const lspServerSchema = z.object({
  name: lspServerNameSchema,
  enabled: z.boolean(),
  extensions: z.array(fileExtensionSchema).min(1).max(32),
  command: z.string().trim().min(1).max(2_048),
  args: z.array(z.string().max(2_048)).max(32),
}).strict();

export const lspServerListSchema = z.array(lspServerSchema).max(32).refine(
  (servers) => new Set(servers.map((server) => server.name)).size === servers.length,
  'Language server names must be unique.',
);

export type LspServerDefinition = z.infer<typeof lspServerSchema>;

export const defaultLspServers: readonly LspServerDefinition[] = Object.freeze([
  { name: 'typescript', enabled: false, extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], command: 'typescript-language-server', args: ['--stdio'] },
  { name: 'python', enabled: false, extensions: ['.py', '.pyi'], command: 'pyright-langserver', args: ['--stdio'] },
  { name: 'rust', enabled: false, extensions: ['.rs'], command: 'rust-analyzer', args: [] },
  { name: 'go', enabled: false, extensions: ['.go'], command: 'gopls', args: [] },
  { name: 'clang', enabled: false, extensions: ['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx'], command: 'clangd', args: [] },
]);
