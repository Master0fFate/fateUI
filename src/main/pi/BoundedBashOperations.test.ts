import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BashOperations, createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASH_SETTLE_GRACE_MS, createBoundedBashOperations, DEFAULT_BASH_TIMEOUT_SECONDS } from './BoundedBashOperations';
import { createProjectConfinedTools } from './PiToolPolicy';

type ExecOptions = Parameters<BashOperations['exec']>[2];

function fakeBase(run: (options: ExecOptions) => Promise<{ exitCode: number | null }>) {
  const calls: ExecOptions[] = [];
  const base: BashOperations = { exec: (_command, _cwd, options) => { calls.push(options); return run(options); } };
  return { base, calls };
}
const hang = () => new Promise<never>(() => {});

afterEach(() => { vi.useRealTimers(); });

describe('createBoundedBashOperations', () => {
  it('applies the default timeout when the model omits one and keeps an explicit one', async () => {
    const { base, calls } = fakeBase(async () => ({ exitCode: 0 }));
    const ops = createBoundedBashOperations(base);
    await expect(ops.exec('true', '.', { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
    await ops.exec('true', '.', { onData: () => {}, timeout: 900 });
    expect(calls.map((call) => call.timeout)).toEqual([DEFAULT_BASH_TIMEOUT_SECONDS, 900]);
  });

  it('releases a call whose process survives the deadline kill', async () => {
    vi.useFakeTimers();
    const ops = createBoundedBashOperations(fakeBase(hang).base);
    const result = ops.exec('server', '.', { onData: () => {}, timeout: 2 });
    const outcome = expect(result).rejects.toThrow('timeout:2');
    await vi.advanceTimersByTimeAsync(2000 + BASH_SETTLE_GRACE_MS);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases an aborted call whose process survives the abort kill', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ops = createBoundedBashOperations(fakeBase(hang).base);
    const result = ops.exec('server', '.', { onData: () => {}, signal: controller.signal });
    const outcome = expect(result).rejects.toThrow('aborted');
    controller.abort();
    await vi.advanceTimersByTimeAsync(BASH_SETTLE_GRACE_MS);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the real result when the SDK settles inside the grace window', async () => {
    vi.useFakeTimers();
    const { base } = fakeBase(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout:1')), 1500)));
    const result = createBoundedBashOperations(base).exec('slow', '.', { onData: () => {}, timeout: 1 });
    const outcome = expect(result).rejects.toThrow('timeout:1');
    await vi.advanceTimersByTimeAsync(1500);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Fate bash tool', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it('tells the model the default timeout and ends a long command with a retry hint', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'fate-bounded-bash-'));
    roots.push(project);
    const bash = (await createProjectConfinedTools(project)).find((tool) => tool.name === 'bash') as ReturnType<typeof createBashToolDefinition>;
    expect(JSON.stringify(bash.parameters)).toContain(`default ${DEFAULT_BASH_TIMEOUT_SECONDS}`);
    expect(bash.description).not.toMatch(/optionally provide a timeout/i);
    expect(bash.promptGuidelines?.join('\n')).toMatch(/time out after 300 seconds/);

    await expect(bash.execute('slow', { command: 'sleep 10', timeout: 1 }, undefined, undefined, undefined as never))
      .rejects.toThrow(/Command timed out after 1 seconds\nIf the command needs more time/);
  }, 20_000);
});
