import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRepository } from './AgentRepository';
import { agentDraftSchema, routineDraftSchema, type AgentDraft } from '../../shared/contracts/agents';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
export const agentDraft: AgentDraft = { name: 'Reviewer', description: 'Review carefully', instructions: 'Be precise.', skillRefs: [], defaults: { model: null, thinkingLevel: 'high', permission: 'read-only', workspace: 'shared' }, enabled: true };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-repository-')));
  roots.push(root);
  const repository = new AgentRepository(path.join(root, 'data'));
  return { root, repository };
}

describe('Agent Library contracts and repositories', () => {
  it('validates boundaries and keeps Routine messages bounded', () => {
    expect(agentDraftSchema.parse(agentDraft)).toEqual(agentDraft);
    expect(agentDraftSchema.parse({ ...agentDraft, defaults: { ...agentDraft.defaults, permission: 'full-access' } }).defaults.permission).toBe('full-access');
    expect(() => agentDraftSchema.parse({ ...agentDraft, defaults: { ...agentDraft.defaults, permission: 'admin' } })).toThrow();
    expect(() => agentDraftSchema.parse({ ...agentDraft, scope: 'project' })).toThrow();
    expect(() => agentDraftSchema.parse({ ...agentDraft, name: 'bad\nname' })).toThrow();
    expect(() => agentDraftSchema.parse({ ...agentDraft, instructions: 'x'.repeat(65_537) })).toThrow();
    const routine = { name: 'Daily', agentId: 'a392d8b9-76cc-4158-a381-1151ccf818fb', message: 'x'.repeat(200_000), intervalMinutes: 60, timeZone: 'UTC', enabled: true, notify: true, osNotify: false };
    expect(routineDraftSchema.parse(routine).message).toHaveLength(200_000);
    expect(() => routineDraftSchema.parse({ ...routine, message: 'x'.repeat(200_001) })).toThrow();
    expect(() => routineDraftSchema.parse({ name: 'Schedule', agentId: 'not-an-id', timeZone: 'bad', intervalMinutes: 0 })).toThrow();
  });

  it('lists Agents globally with legacy project Agents, persists rename and rejects stale writes', async () => {
    const { root, repository } = await fixture();
    const created = await repository.saveAgent({ expected: null, value: agentDraft });
    const projectPath = path.join(root, 'project');
    const legacy = repository['journal'](createHash('sha256').update(projectPath).digest('hex'), 'agent');
    await legacy.save('b392d8b9-76cc-4158-a381-1151ccf818fb', null, { metadata: { ...agentDraft, instructions: undefined, schemaVersion: 1, id: 'b392d8b9-76cc-4158-a381-1151ccf818fb', scope: 'project', projectPath, name: 'Legacy', revision: 1, createdAt: 1, updatedAt: 1, deleted: false }, body: 'Old.' });
    const first = await repository.list();
    expect(first.agents.map((agent) => agent.name).sort()).toEqual(['Legacy', 'Reviewer']);
    const expected = first.revisions[`agent:${created.id}`]!;
    await repository.saveAgent({ id: created.id, expected, value: { ...agentDraft, name: 'Renamed' } });
    await expect(repository.saveAgent({ id: created.id, expected, value: agentDraft })).rejects.toThrow(/conflict/);
    const restarted = new AgentRepository(path.join(root, 'data'));
    expect((await restarted.getAgent(created.id)).item).toMatchObject({ name: 'Renamed', scope: 'user', projectPath: null });
    const renamedLegacy = await restarted.getAgent('b392d8b9-76cc-4158-a381-1151ccf818fb');
    await restarted.saveAgent({ id: renamedLegacy.item.id, expected: { revision: renamedLegacy.snapshot.revision, digest: renamedLegacy.snapshot.digest }, value: { ...agentDraft, name: 'Kept in place' } });
    expect((await restarted.getAgent(renamedLegacy.item.id)).item).toMatchObject({ name: 'Kept in place', scope: 'project', projectPath });
    expect((await restarted.list()).diagnostics).toEqual([]);
  });

  it('preserves unknown frontmatter and refuses duplicate names', async () => {
    const { repository } = await fixture();
    const created = await repository.saveAgent({ expected: null, value: agentDraft });
    const { journal, snapshot: original } = await repository.getAgent(created.id);
    const externallyEdited = await journal.save(created.id, original, { metadata: { ...original.metadata, revision: 2, vendor: { nested: ['kept'] } }, body: original.body });
    await repository.saveAgent({ id: created.id, expected: { revision: externallyEdited.revision, digest: externallyEdited.digest }, value: { ...agentDraft, name: 'Renamed' } });
    expect((await repository.getAgent(created.id)).item.vendor).toEqual({ nested: ['kept'] });
    await expect(repository.saveAgent({ expected: null, value: { ...agentDraft, name: 'renamed' } })).rejects.toThrow(/already exists/);
  });

  it('retains independent state and home ownership on definition deletion', async () => {
    const { root, repository } = await fixture();
    const agent = await repository.saveAgent({ expected: null, value: agentDraft });
    const before = (await repository.getAgent(agent.id)).snapshot;
    await repository.updateState(agent.id, (state) => ({ ...state, homeSessionId: 'home', homeProjectPath: path.join(root, 'home'), appliedRevision: 1 }));
    expect((await repository.getAgent(agent.id)).snapshot).toEqual(before);
    await repository.remove('agent', agent.id, before);
    expect((await repository.list()).agents).toEqual([]);
    expect(await repository.state(agent.id)).toMatchObject({ homeSessionId: 'home', appliedRevision: 1 });
    await expect(repository.getAgent(agent.id)).rejects.toThrow(/deleted/);
  });

  it('fails closed for corrupt storage and linked directories', async () => {
    const { root, repository } = await fixture();
    const agent = await repository.saveAgent({ expected: null, value: agentDraft });
    const { journal, snapshot: original } = await repository.getAgent(agent.id);
    await journal.save(agent.id, original, { metadata: { ...original.metadata, schemaVersion: 99, revision: 2 }, body: original.body });
    expect((await repository.list()).diagnostics).toHaveLength(1);
    await expect(repository.saveAgent({ expected: null, value: { ...agentDraft, name: 'Another' } })).rejects.toThrow(/diagnostics/);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const linked = path.join(root, 'linked');
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const unsafe = new AgentRepository(linked);
    await expect(unsafe.saveAgent({ expected: null, value: agentDraft })).rejects.toThrow(/Linked/);
  });

  it('serializes competing repository catalog writers rather than admitting duplicate names', async () => {
    const { root, repository } = await fixture();
    const other = new AgentRepository(path.join(root, 'data'));
    const results = await Promise.allSettled([repository.saveAgent({ expected: null, value: agentDraft }), other.saveAgent({ expected: null, value: agentDraft })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.list()).agents).toHaveLength(1);
  });

  it('recovers a dead home ownership lock without stealing unknown or live locks', async () => {
    const { root, repository } = await fixture();
    const id = 'a392d8b9-76cc-4158-a381-1151ccf818fb';
    const lockDirectory = path.join(root, 'data', 'home-locks', id);
    await fs.mkdir(lockDirectory, { recursive: true });
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    await fs.writeFile(path.join(lockDirectory, 'writer.lock'), JSON.stringify({ token: 'dead', pid: deadPid, host: os.hostname() }));
    await expect(repository.withHomeLock(id, async () => 'opened')).resolves.toBe('opened');
    await fs.writeFile(path.join(lockDirectory, 'writer.lock'), JSON.stringify({ token: 'live', pid: process.pid, host: os.hostname() }));
    await expect(repository.withHomeLock(id, async () => 'blocked')).rejects.toThrow();
  });
});
