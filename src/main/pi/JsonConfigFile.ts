import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { fateDataRoot } from './FateProviderStorage';

const MAX_CONFIG_BYTES = 256_000;

export class JsonConfigFile<Schema extends z.ZodTypeAny> {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(
    private readonly schema: Schema,
    filename: string,
    private readonly fallback: z.output<Schema>,
    private readonly root = fateDataRoot(),
  ) {
    this.file = path.join(root, filename);
  }

  async list(): Promise<z.output<Schema>> {
    await this.queue;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error(`${path.basename(this.file)} is not a valid regular file.`);
      return this.schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.fallback;
      throw error;
    }
  }

  async save(input: z.input<Schema>): Promise<z.output<Schema>> {
    const value = this.schema.parse(input);
    const work = this.queue.then(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    });
    this.queue = work.catch(() => undefined);
    await work;
    return value;
  }
}
