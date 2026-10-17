import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspLocationLink { targetUri: string; targetRange: LspRange; targetSelectionRange: LspRange }
export interface LspDiagnostic { range: LspRange; severity?: number; code?: string | number; source?: string; message: string }
export interface LspDocumentSymbol { name: string; kind: number; range: LspRange; selectionRange: LspRange; children?: LspDocumentSymbol[] }
export interface LspSymbolInformation { name: string; kind: number; location: LspLocation; containerName?: string }

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

interface Message { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

export interface LspClientOptions {
  command: string;
  args: readonly string[];
  rootPath: string;
  onDiagnostics: (uri: string, version: number | undefined, diagnostics: LspDiagnostic[]) => void;
  onExit: () => void;
}

export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private exited = false;
  readonly ready: Promise<void>;
  capabilities: Record<string, unknown> = {};

  constructor(private readonly options: LspClientOptions) {
    this.child = spawn(options.command, options.args, { cwd: options.rootPath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => undefined);
    this.child.stdin.on('error', () => undefined);
    const spawned = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.child.on('exit', () => this.handleExit());
    this.child.on('error', () => this.handleExit());
    const rootUri = pathToFileURL(options.rootPath).href;
    this.ready = spawned.then(async () => {
      const result = await this.request('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: options.rootPath,
        workspaceFolders: [{ uri: rootUri, name: options.rootPath.split(/[\\/]/).pop() ?? 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, willSave: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { workspaceFolders: true, symbol: {}, configuration: true, didChangeConfiguration: { dynamicRegistration: false } },
        },
      }) as { capabilities?: Record<string, unknown> };
      this.capabilities = result.capabilities ?? {};
      this.notify('initialized', {});
      this.notify('workspace/didChangeConfiguration', { settings: {} });
    });
    this.ready.catch(() => this.dispose());
  }

  private handleExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The language server exited.'));
    }
    this.pending.clear();
    this.options.onExit();
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.dispose(); return; }
      const length = Number(match[1]);
      if (length > MAX_FRAME_BYTES) { this.dispose(); return; }
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message: Message;
      try { message = JSON.parse(body) as Message; } catch { continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: Message): void {
    if (message.method !== undefined && message.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: message.id, ...this.answer(message.method, message.params) });
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
      this.options.onDiagnostics(params.uri, params.version, params.diagnostics);
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }

  private answer(method: string, params: unknown): { result: unknown } | { error: { code: number; message: string } } {
    switch (method) {
      case 'workspace/configuration': return { result: ((params as { items?: unknown[] }).items ?? []).map(() => null) };
      case 'workspace/workspaceFolders': return { result: [{ uri: pathToFileURL(this.options.rootPath).href, name: this.options.rootPath }] };
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/diagnostic/refresh':
      case 'workspace/codeLens/refresh':
        return { result: null };
      default: return { error: { code: -32601, message: 'Unsupported request.' } };
    }
  }

  private send(payload: object): void {
    if (this.exited) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('The language server exited.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async dispose(): Promise<void> {
    if (this.exited) return;
    const exit = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    try {
      await this.request('shutdown', null, SHUTDOWN_GRACE_MS);
      this.notify('exit', null);
    } catch {
      this.child.kill();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), SHUTDOWN_GRACE_MS);
    await exit;
    clearTimeout(timer);
    this.handleExit();
  }
}
