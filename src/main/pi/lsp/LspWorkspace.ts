import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LspServerDefinition } from '../../../shared/contracts/lsp';
import { LspClient, type LspDiagnostic, type LspDocumentSymbol, type LspLocation, type LspLocationLink, type LspPosition, type LspSymbolInformation } from './LspClient';

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const SPAWN_FAILURE_MEMORY_MS = 5 * 60 * 1000;
const MAX_OPEN_DOCUMENTS = 64;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DIAGNOSTICS_WAIT_MS = 4_000;

interface OpenDocument { uri: string; version: number; server: string }

interface DiagnosticsState { version: number | undefined; diagnostics: LspDiagnostic[]; waiters: Array<{ minVersion: number; resolve: (diagnostics: LspDiagnostic[]) => void }> }

interface ServerSlot { client: LspClient | null; starting: Promise<LspClient> | null; failedAt: number; failure: string }

export interface DiagnosticsResult { diagnostics: LspDiagnostic[]; received: boolean }

export class LspUnavailableError extends Error {}

const workspaces = new Map<string, LspWorkspace>();

export function lspWorkspaceFor(rootPath: string, servers: readonly LspServerDefinition[]): LspWorkspace {
  const key = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  let workspace = workspaces.get(key);
  if (!workspace) {
    workspace = new LspWorkspace(rootPath);
    workspaces.set(key, workspace);
  }
  workspace.configure(servers);
  return workspace;
}

process.once('exit', () => { for (const workspace of workspaces.values()) workspace.killAll(); });

async function resolveCommand(command: string, rootPath: string): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) return command;
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  const directories = [path.join(rootPath, 'node_modules', '.bin'), ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export class LspWorkspace {
  private servers: readonly LspServerDefinition[] = [];
  private serversKey = '';
  private readonly slots = new Map<string, ServerSlot>();
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, DiagnosticsState>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly rootPath: string) {}

  configure(servers: readonly LspServerDefinition[]): void {
    const key = JSON.stringify(servers);
    if (key === this.serversKey) return;
    this.serversKey = key;
    this.servers = servers;
    void this.killAll();
  }

  serverFor(filePath: string): LspServerDefinition | null {
    const extension = path.extname(filePath).toLowerCase();
    return this.servers.find((server) => server.enabled && server.extensions.some((candidate) => candidate.toLowerCase() === extension)) ?? null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.killAll(); }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  async killAll(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const clients = [...this.slots.values()].flatMap((slot) => slot.client ? [slot.client] : []);
    this.slots.clear();
    this.documents.clear();
    this.diagnostics.clear();
    await Promise.all(clients.map((client) => client.dispose()));
  }

  private async client(server: LspServerDefinition): Promise<LspClient> {
    this.touch();
    let slot = this.slots.get(server.name);
    if (!slot) {
      slot = { client: null, starting: null, failedAt: 0, failure: '' };
      this.slots.set(server.name, slot);
    }
    if (slot.client) return slot.client;
    if (slot.starting) return slot.starting;
    if (Date.now() - slot.failedAt < SPAWN_FAILURE_MEMORY_MS) throw new LspUnavailableError(slot.failure);
    const current = slot;
    current.starting = (async () => {
      const command = await resolveCommand(server.command, this.rootPath);
      if (!command) throw new LspUnavailableError(`${server.command} was not found on PATH or in node_modules/.bin. Install it or change the ${server.name} server in Settings > Code Intelligence.`);
      const client = new LspClient({
        command,
        args: server.args,
        rootPath: this.rootPath,
        onDiagnostics: (uri, version, diagnostics) => this.publish(uri, version, diagnostics),
        onExit: () => {
          if (current.client === client) current.client = null;
          for (const [uri, document] of this.documents) if (document.server === server.name) this.documents.delete(uri);
        },
      });
      await client.ready;
      current.client = client;
      return client;
    })();
    try {
      return await current.starting;
    } catch (error) {
      current.failedAt = Date.now();
      current.failure = error instanceof Error ? error.message : String(error);
      throw error instanceof LspUnavailableError ? error : new LspUnavailableError(`The ${server.name} language server failed to start: ${current.failure}`);
    } finally {
      current.starting = null;
    }
  }

  private publish(uri: string, version: number | undefined, diagnostics: LspDiagnostic[]): void {
    const state = this.diagnostics.get(uri) ?? { version: undefined, diagnostics: [], waiters: [] };
    state.version = version;
    state.diagnostics = diagnostics;
    this.diagnostics.set(uri, state);
    const remaining: DiagnosticsState['waiters'] = [];
    for (const waiter of state.waiters) {
      if (version === undefined || version >= waiter.minVersion) waiter.resolve(diagnostics);
      else remaining.push(waiter);
    }
    state.waiters = remaining;
  }

  uriFor(filePath: string): string {
    return pathToFileURL(filePath).href;
  }

  pathFor(uri: string): string {
    try { return fileURLToPath(uri); } catch { return uri; }
  }

  async sync(filePath: string): Promise<{ client: LspClient; uri: string; version: number }> {
    const server = this.serverFor(filePath);
    if (!server) throw new LspUnavailableError(`No enabled language server handles ${path.extname(filePath) || 'files without an extension'}. Add one in Settings > Code Intelligence.`);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error('Language server tools read regular files up to 8 MiB.');
    const [client, text] = await Promise.all([this.client(server), fs.readFile(filePath, 'utf8')]);
    const uri = this.uriFor(filePath);
    const open = this.documents.get(uri);
    if (open) {
      open.version += 1;
      client.notify('textDocument/didChange', { textDocument: { uri, version: open.version }, contentChanges: [{ text }] });
      return { client, uri, version: open.version };
    }
    if (this.documents.size >= MAX_OPEN_DOCUMENTS) {
      const oldest = this.documents.keys().next().value;
      if (oldest) {
        const evicted = this.documents.get(oldest)!;
        this.documents.delete(oldest);
        this.diagnostics.delete(oldest);
        const owner = this.slots.get(evicted.server)?.client;
        owner?.notify('textDocument/didClose', { textDocument: { uri: oldest } });
      }
    }
    const document: OpenDocument = { uri, version: 1, server: server.name };
    this.documents.set(uri, document);
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: server.name, version: 1, text } });
    return { client, uri, version: 1 };
  }

  async diagnosticsFor(filePath: string, waitMs = DIAGNOSTICS_WAIT_MS): Promise<DiagnosticsResult> {
    const { uri, version } = await this.sync(filePath);
    const state = this.diagnostics.get(uri) ?? { version: undefined, diagnostics: [], waiters: [] };
    this.diagnostics.set(uri, state);
    const diagnostics = await new Promise<LspDiagnostic[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs);
      state.waiters.push({ minVersion: version, resolve: (value) => { clearTimeout(timer); resolve(value); } });
    });
    return diagnostics ? { diagnostics, received: true } : { diagnostics: state.diagnostics, received: false };
  }

  async definition(filePath: string, position: LspPosition): Promise<LspLocation[]> {
    const { client, uri } = await this.sync(filePath);
    return normalizeLocations(await client.request('textDocument/definition', { textDocument: { uri }, position }));
  }

  async references(filePath: string, position: LspPosition, includeDeclaration: boolean): Promise<LspLocation[]> {
    const { client, uri } = await this.sync(filePath);
    return normalizeLocations(await client.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration } }));
  }

  async documentSymbols(filePath: string): Promise<Array<LspDocumentSymbol | LspSymbolInformation>> {
    const { client, uri } = await this.sync(filePath);
    const result = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    return Array.isArray(result) ? result as Array<LspDocumentSymbol | LspSymbolInformation> : [];
  }

  async workspaceSymbols(query: string): Promise<LspSymbolInformation[]> {
    const enabled = this.servers.filter((server) => server.enabled);
    const results = await Promise.all(enabled.map(async (server) => {
      try {
        const client = await this.client(server);
        const result = await client.request('workspace/symbol', { query });
        return Array.isArray(result) ? result as LspSymbolInformation[] : [];
      } catch {
        return [];
      }
    }));
    return results.flat();
  }
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.flatMap((item) => {
    const link = item as Partial<LspLocationLink>;
    if (link.targetUri && link.targetSelectionRange) return [{ uri: link.targetUri, range: link.targetSelectionRange }];
    const location = item as Partial<LspLocation>;
    return location.uri && location.range ? [{ uri: location.uri, range: location.range }] : [];
  });
}
