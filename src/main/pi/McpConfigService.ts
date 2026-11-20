import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpServerListSchema, type McpServerDefinition } from '../../shared/contracts/ipc';

export class McpConfigService {
  private static readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly root = process.env.FATE_GUI_DATA_DIR?.trim()
    ? path.resolve(process.env.FATE_GUI_DATA_DIR.trim())
    : path.join(os.homedir(), '.pi', 'fateGUI')) {}

  private file(): string { return path.resolve(this.root, 'mcp-servers.json'); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const file = this.file();
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    const queues = McpConfigService.queues;
    const work = (queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = work.then(() => undefined, () => undefined);
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return work;
  }

  private async read(): Promise<McpServerDefinition[]> {
    try {
      const stat = await fs.lstat(this.file());
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('MCP config is not a valid regular file.');
      return mcpServerListSchema.parse(JSON.parse(await fs.readFile(this.file(), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  withCurrent<T>(use: (servers: McpServerDefinition[]) => T): Promise<T> {
    return this.serialize(async () => use(await this.read()));
  }

  list(): Promise<McpServerDefinition[]> {
    return this.withCurrent((servers) => servers);
  }

  update(
    prepare: (current: McpServerDefinition[]) => Promise<readonly McpServerDefinition[] | null> | readonly McpServerDefinition[] | null,
    beforeCommit?: () => void,
  ): Promise<McpServerDefinition[]> {
    return this.serialize(async () => {
      const current = await this.read();
      const next = await prepare(current);
      return next === null ? current : this.write(mcpServerListSchema.parse(next), beforeCommit);
    });
  }

  async save(input: readonly McpServerDefinition[]): Promise<McpServerDefinition[]> {
    const servers = mcpServerListSchema.parse(input);
    return this.serialize(() => this.write(servers));
  }

  private async write(servers: McpServerDefinition[], beforeCommit?: () => void): Promise<McpServerDefinition[]> {
    const contents = `${JSON.stringify(servers, null, 2)}\n`;
    if (Buffer.byteLength(contents) > 256_000) throw new Error('MCP config is too large.');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.file()}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
      beforeCommit?.();
      await fs.rename(temp, this.file());
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    return servers;
  }
}
