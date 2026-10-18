import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, AgentLibrary } from '../../../shared/contracts/agents';
import { SkinProvider } from '../../skins/SkinProvider';
import { useAgentsStore, emptyAgentLibrary } from '../../stores/agentsStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { SidebarAgents } from './SidebarAgents';

const agentId = 'a392d8b9-76cc-4158-a381-1151ccf818fb';
const agent: AgentDefinition = { schemaVersion: 1, id: agentId, name: 'Reviewer', scope: 'user', projectPath: null, description: 'Careful review', instructions: 'System persona', skillRefs: [], defaults: { model: null, permission: 'read-only', thinkingLevel: 'high', workspace: 'shared' }, enabled: true, deleted: false, revision: 1, createdAt: 1, updatedAt: 1 };
let library: AgentLibrary;
let api: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  library = { ...emptyAgentLibrary(), agents: [agent], revisions: { [`agent:${agentId}`]: { revision: 1, digest: 'a'.repeat(64) } } };
  useAgentsStore.setState({ library: emptyAgentLibrary(), busy: false, loading: false, error: null, editing: null });
  useUiStore.setState({ compactSessions: false, settingsOpen: false, settingsSectionRequest: null });
  useRuntimeStore.setState({ runtime: { ...useRuntimeStore.getState().runtime, status: 'ready', project: { path: '/project', name: 'project', trusted: true }, permissionLevel: 'edit', models: [] } });
  api = {
    getAgentLibrary: vi.fn(async () => structuredClone(library)),
    saveAgentDefinition: vi.fn(async (input) => ({ ...agent, ...input.value, revision: 2 })),
    deleteAgentLibraryItem: vi.fn(async () => { library = emptyAgentLibrary(); }),
    openAgentConversation: vi.fn(async () => ({ ...useRuntimeStore.getState().runtime, project: { path: '/agents/home', name: 'Reviewer', trusted: true, agentId }, sessionId: 'home' })),
  };
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: api });
});
const mount = (skin = 'default') => { document.documentElement.dataset.skin = skin; return render(<SkinProvider><SidebarAgents /></SkinProvider>); };

describe('Agents sidebar', () => {
  it.each(['default', 'dreamcore', 'm3-expressive'])('uses the Sessions toolbar and rows under %s', async (skin) => {
    const { container } = mount(skin);
    const row = (await screen.findByRole('button', { name: /^Reviewer/u })).closest('.session-row');
    expect(row).not.toBeNull();
    expect(container.querySelector('.sidebar-tab-toolbar .sidebar-search')).toContainElement(screen.getByRole('searchbox', { name: 'Search agents' }));
    expect(container.querySelector('.sidebar-toolbar-action--primary')).toContainElement(screen.getByRole('button', { name: 'New agent' }));
    expect(row).toHaveTextContent('Read only');
    expect(container.querySelector('[class*="agent-library"]')).toBeNull();
  });

  it('opens the single Agent chat and keeps the Agents tab selected', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Reviewer/u }));
    await waitFor(() => expect(api.openAgentConversation).toHaveBeenCalledWith({ agentId }));
    await waitFor(() => expect(useRuntimeStore.getState().runtime.project?.agentId).toBe(agentId));
    expect(useUiStore.getState().sidebarTab).toBe('agents');
    expect((await screen.findByRole('button', { name: /^Reviewer/u })).closest('.session-row')).toHaveClass('session-row--current');
  });

  it('edits in Settings and turns an Agent off from its row', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    expect(useAgentsStore.getState().editing).toBe('new');
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsSectionRequest: 'agent' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit agent: Reviewer' }));
    expect(useAgentsStore.getState().editing).toBe(agentId);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off: Reviewer' }));
    await waitFor(() => expect(api.saveAgentDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: agentId, expected: { revision: 1, digest: 'a'.repeat(64) }, value: expect.objectContaining({ enabled: false }) })));
  });

  it('confirms before deleting and shows the empty state afterwards', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete agent: Reviewer' }));
    expect(api.deleteAgentLibraryItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteAgentLibraryItem).toHaveBeenCalledWith({ kind: 'agent', id: agentId, expected: { revision: 1, digest: 'a'.repeat(64) } }));
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
  });

  it('uses the compact row and menu when compact sessions are on', async () => {
    useUiStore.setState({ compactSessions: true });
    mount();
    expect((await screen.findByRole('button', { name: /^Reviewer/u })).closest('.session-row')).toHaveClass('session-row--compact');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Reviewer' }));
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Edit agent: Reviewer' })).toBeInTheDocument();
  });
});
