import type { ProjectState } from '../../src/shared/contracts/ipc';
import type { AgentsHost, AgentWorkspace } from '../../src/main/agents/AgentsService';
import type { FakePiRuntimeService } from './FakePiRuntimeService';

export function agentHostFixture(runtime: FakePiRuntimeService, project: ProjectState, sessionsRoot: string): AgentsHost {
  const workspace: AgentWorkspace = {
    startAgentRun: async (target) => ({
      sessionId: target.sessionId,
      settled: Promise.resolve({ failed: false, summary: 'Deterministic Agent result; no provider was called.', error: null }),
      abort: async () => undefined,
    }),
    deliverAgentMessage: async () => undefined,
    refreshAgentSession: async () => undefined,
  };
  return {
    workspace: async () => workspace,
    liveWorkspace: () => workspace,
    trustedProjects: async () => [project.path],
    currentModel: () => {
      const model = runtime.getState().model;
      return model ? { provider: model.provider, id: model.id } : null;
    },
    currentProjectPath: () => {
      const current = runtime.getState().project;
      return current?.trusted && !current.agentId ? current.path : null;
    },
    sessionsRoot,
  };
}
