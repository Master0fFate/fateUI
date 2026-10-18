import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ supported: vi.fn(() => true), show: vi.fn(), on: vi.fn(), focus: vi.fn(), reveal: vi.fn(), send: vi.fn(), options: vi.fn() }));
vi.mock('electron', () => ({
  Notification: class {
    static isSupported = native.supported;
    constructor(options: unknown) { native.options(options); }
    on = native.on;
    show = native.show;
  },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, show: native.reveal, focus: native.focus, webContents: { send: native.send } }] },
}));
import { notifyAgentRun } from './AgentNotifications';
import { agentChannels } from '../../shared/contracts/agents';
beforeEach(() => { vi.clearAllMocks(); native.supported.mockReturnValue(true); });
describe('Agent OS notifications', () => {
  it('respects disabled and unavailable OS notifications', () => {
    expect(notifyAgentRun({ agentId: '00000000-0000-4000-8000-000000000001' }, false)).toBe(false);
    native.supported.mockReturnValue(false);
    expect(notifyAgentRun({ agentId: '00000000-0000-4000-8000-000000000001' }, true)).toBe(false);
    expect(native.show).not.toHaveBeenCalled();
  });
  it('links an immutable notification to its exact Agent and run', () => {
    const change = { agentId: '00000000-0000-4000-8000-000000000001', runId: 'routine:run', status: 'needs-attention' as const, message: 'Review action.' };
    expect(notifyAgentRun(change, true)).toBe(true);
    change.runId = 'changed';
    native.on.mock.calls[0]![1]();
    expect(native.focus).toHaveBeenCalledOnce();
    expect(native.send).toHaveBeenCalledWith(agentChannels.agentsChanged, { ...change, runId: 'routine:run', focus: true });
    expect(native.show).toHaveBeenCalledOnce();
  });
  it('does not turn an OS notification error into execution failure', () => {
    native.show.mockImplementationOnce(() => { throw new Error('OS declined'); });
    expect(notifyAgentRun({ runId: 'run' }, true)).toBe(false);
  });
});
