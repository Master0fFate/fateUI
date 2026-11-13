import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { PiEvent, SubagentAgentSource, SubagentNotification, SubagentParentLivenessReport, SubagentRun, SubagentUsage, SubagentWorkflowLivenessReport } from '../../shared/contracts/ipc';
import { assertContextTransfer, isContextWindowError } from './SubagentContext';
import { emptyUsage, addUsage } from './SubagentSessionFactory';
import { scheduleLongTimeout, type CancelableTimer } from './SubagentTimer';
import { workflowResultsToolResult, workflowToolResult } from './SubagentPresentation';
import { normalizeWorkflowStart, workflowParameters, type ModelSelection, type WorkflowNodeRequest } from './SubagentProtocol';
import type { NativeWorkflowSchedulerFactory } from './durable/NativeWorkflowScheduler';
import { SubagentWorkflowEngine, type SubagentWorkflow, type SubagentWorkflowExecutionBinding, type SubagentWorkflowNode, type SubagentWorkflowRun, type SubagentWorkflowSnapshot, type WorkflowNotificationDeliveryError } from './SubagentWorkflow';
import type { AgentTeamCoordinator } from './multi-agent/AgentTeamCoordinator';
import type { AgentTaskOutcome } from './multi-agent/AgentTeamTypes';
import { NativeEffectNotStartedError, NativeExecutionUnknownError } from './durable/NativeExecutionFence';

const WORKFLOW_SNAPSHOT_CUSTOM_TYPE = 'fate-subagent-workflow';
const TASK_SETTLEMENT_POLL_MS = 5 * 60_000;

type ParentContext = { projectPath: string; session: AgentSession; agentStrategy?: 'auto' | 'off' | 'read-only'; hyp3rc0d3?: boolean };

type WorkflowToolDetails = {
  kind: 'fate-subagent-workflow';
  version: 1;
  workflowIds: string[];
  runIds: string[];
};

interface WorkflowInput {
  action: 'start' | 'list' | 'status' | 'results' | 'cancel' | 'resume' | 'finalize';
  workflowId?: string;
  nodeIds?: string[];
  textOffset?: number;
  textLength?: number;
  reason?: string;
  notifyParent?: SubagentNotification;
}

export interface AgentWorkflowCoordinatorHost {
  resolveParent(parentSessionId: string): ParentContext | null;
  emit(parentSessionId: string, event: PiEvent): void;
  persist(parentSessionId: string, workflow: SubagentWorkflow): void;
  notifyParent?(
    parentSessionId: string,
    mode: SubagentNotification,
    text: string,
    runIds: string[],
    workflowId?: string,
    livenessReport?: SubagentParentLivenessReport,
  ): Promise<void>;
  settled?(parentSessionId: string): void;
}

type Attempt = {
  attemptNumber: number;
  nodeId: string;
  model: SubagentRun['model'];
  permissionLevel: SubagentRun['permissionLevel'];
  enabledTools: SubagentRun['enabledTools'];
  thinkingLevel: SubagentRun['thinkingLevel'];
  usage: SubagentUsage;
  status: SubagentRun['status'];
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number;
  resultTransportFailed?: boolean;
  notificationDeliveryError?: string;
  executionUnknown?: boolean;
};

type TeamAttempt = { nodeId: string; taskId?: string; outcome?: AgentTaskOutcome };

function sourceForAgent(agent: string | undefined): SubagentAgentSource {
  if (agent?.startsWith('project/')) return 'project';
  if (agent?.startsWith('user/')) return 'user';
  return 'direct';
}

function modelForAttempt(request: WorkflowNodeRequest, attempt: number): ModelSelection | undefined {
  if (attempt <= 1) return request.model;
  if (!request.routing.fallbackModels.length) return request.model;
  return request.routing.fallbackModels[Math.min(attempt - 2, request.routing.fallbackModels.length - 1)];
}

function routingFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableRoutingFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || error instanceof NativeExecutionUnknownError || (error instanceof Error && error.name === 'AbortError') || isContextWindowError(error)) return false;
  const message = routingFailureMessage(error);
  if (/permission|authority|workspace|policy|writer lease|capacity|node limit|message limit|goal agent strategy|caller|unknown (?:pi )?agent profile|disabled|not currently authenticated|context window|context transfer|tool.+not granted/iu.test(message)) return false;
  return /model|provider|network|api|rate.?limit|overload|timeout|temporar|unavailable|failed|error/iu.test(message);
}

function retryableAdmissionFailure(error: unknown, signal: AbortSignal): boolean {
  return error instanceof NativeEffectNotStartedError && retryableRoutingFailure(error.cause ?? error, signal);
}

function assertRepresentableWorkflowDurations(rawNodes: unknown): void {
  if (!Array.isArray(rawNodes)) return;
  const durationKeys = ['timeoutSeconds', 'idleTimeoutSeconds', 'mailboxTtlSeconds'] as const;
  for (const [index, rawNode] of rawNodes.entries()) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
    const node = rawNode as Record<string, unknown>;
    for (const key of durationKeys) {
      const seconds = node[key];
      if (seconds === undefined) continue;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 1_000) {
        throw new Error(`Agent workflow node ${String(node.id ?? index)} has invalid ${key}; durations must be finite non-negative seconds representable as safe integer milliseconds. Nothing was started.`);
      }
    }
  }
}

export class AgentWorkflowCoordinator {
  private readonly workflows: SubagentWorkflowEngine;
  /** Logical workflow run id -> currently executing Team node id. */
  private readonly activeTeamNodeByRun = new Map<string, string>();
  private readonly livenessTimers = new Map<string, CancelableTimer[]>();

  constructor(
    private readonly teams: AgentTeamCoordinator,
    private readonly host: AgentWorkflowCoordinatorHost,
    nativeWorkflowSchedulerFactory?: NativeWorkflowSchedulerFactory,
  ) {
    this.workflows = new SubagentWorkflowEngine({
      ...(nativeWorkflowSchedulerFactory ? { createScheduler: async (workflow: SubagentWorkflow, models: ModelRuntime) => {
        const parent = this.host.resolveParent(workflow.parentSessionId);
        if (!parent) throw new Error('Native workflow owner is unavailable. No legacy fallback was used.');
        return nativeWorkflowSchedulerFactory({ id: workflow.id, parentSessionId: workflow.parentSessionId, cwd: parent.projectPath, models });
      } } : {}),
      launchNode: (workflow, node, request, modelRuntime, signal) => this.launchNode(workflow, node, request, modelRuntime, signal),
      cancelRuns: async (parentSessionId, runIds, reason) => {
        const teams = this.teams.getTeams(parentSessionId);
        const outcomes = await Promise.allSettled(runIds.map(async (runId) => {
          const activeNodeId = this.activeTeamNodeByRun.get(runId) ?? runId;
          const team = teams.find((candidate) => candidate.nodes.some((node) => node.id === activeNodeId));
          const root = team?.rootNodeId ?? this.teams.rootNodeId(parentSessionId);
          const target = team?.nodes.find((node) => node.id === activeNodeId);
          const subtree = target ? team!.nodes.filter((node) => node.id === target.id || node.path.startsWith(`${target.path}/`)).map((node) => node.id) : [activeNodeId];
          const failures: unknown[] = [];
          try { await this.teams.interrupt(root, activeNodeId, reason); } catch (error) { failures.push(error); }
          try { await this.teams.release(root, activeNodeId, true); } catch (error) { failures.push(error); }
          const settlement = await Promise.allSettled(subtree.map((nodeId) => this.awaitNativePhysicalSettlement(root, nodeId)));
          failures.push(...settlement.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
          if (settlement.every((result) => result.status === 'fulfilled')) this.activeTeamNodeByRun.delete(runId);
          if (failures.length) throw new AggregateError(failures, `Agent workflow child ${activeNodeId} cancellation cleanup failed.`);
        }));
        const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Agent workflow cancellation cleanup failed.');
      },
      executionConcurrency: (workflow) => workflow.maxConcurrency,
      usedHandles: (parentSessionId) => this.teams.getTeams(parentSessionId).flatMap((team) => team.nodes.map((node) => node.handle)),
      runIdentity: (parentSessionId, runId) => {
        const node = this.teams.getTeams(parentSessionId).flatMap((team) => team.nodes).find((candidate) => candidate.id === runId);
        return node ? { handle: node.handle, displayName: node.displayName } : undefined;
      },
      persist: (workflow) => this.host.persist(workflow.parentSessionId, workflow),
      changed: (workflow) => this.host.emit(workflow.parentSessionId, { type: 'subagent.workflow.updated', workflow, timestamp: workflow.updatedAt }),
      notify: (parentSessionId, mode, text, runIds, workflowId) => this.host.notifyParent?.(parentSessionId, mode, text, runIds, workflowId) ?? Promise.resolve(),
      liveness: (parentSessionId, workflowId, report) => this.host.emit(parentSessionId, { type: 'subagent.workflow.liveness', workflowId, report, timestamp: report.timing.detectedAt }),
      settled: (parentSessionId) => this.host.settled?.(parentSessionId),
    });
  }

  createTool(modelRuntime: ModelRuntime): ToolDefinition {
    return defineTool<typeof workflowParameters, WorkflowToolDetails>({
      name: 'agent_workflow',
      label: 'Agent workflow',
      description: 'Run or manage a persisted dependency graph through Agent Teams. finalize checks root-wide readiness without a workflowId. list/status return summaries; results retrieves retained node output and errors as JSON, optionally selected by nodeIds and sliced with textOffset/textLength. Omitted textLength returns the full remainder.',
      promptSnippet: 'Run and manage an Agent Team dependency graph',
      promptGuidelines: [
        'Node IDs and dependencies define the graph. includeDependencyResults is the only automatic result transfer and is opt-in per node.',
        'Requested permissions, models, thinking, tools, skills, instructions, routing attempts, and workspace are passed to Agent Team admission. Workspace and permission safety policies remain enforced; no arbitrary team-size ceiling is imposed.',
        'dependencyFailure controls whether a node skips or runs after a failed dependency. Fallback models are used only when explicitly configured. maxAttempts defaults to 1; explicitly requesting more attempts permits whole-task retries after confirmed failures, so edits and other effects may repeat.',
        'Use results with workflowId for full retained output; notifications are previews. result/error null means absent, while an empty string means present but empty. Offsets count UTF-16 characters. If context transfer is too large, request nodeIds and textLength slices.',
        'agent_workflow defaults an omitted graph-level notifyParent to immediate in Hyp3rc0d3 mode; explicit never and next-turn are preserved.',
        'Budget thresholds are advisory telemetry. Native workflow tasks never replay after interruption; review retained child sessions and start a reviewed new graph. Legacy graphs require explicit resume.',
        'After delegation, call finalize immediately before the root final report. Collect and synthesize all required results, wait for ready, and recheck after further work. Use bounded wait_agent with stateOnly:true, not tight status polling; yield progress only for a blocked writer. Delayed notifications warrant user updates only for material changes.',
      ],
      parameters: workflowParameters,
      executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const parent = this.requireParent(ctx.sessionManager.getSessionId(), ctx.cwd);
        const input = params as WorkflowInput;
        const deliver = (workflows: Parameters<SubagentWorkflowEngine['format']>[0]) => this.deliver(parent, workflows);
        if (input.action === 'start') {
          if (parent.agentStrategy === 'off') throw new Error('Goal agent strategy is off; complete this turn with the root agent.');
          assertRepresentableWorkflowDurations((params as { nodes?: unknown }).nodes);
          const request = normalizeWorkflowStart(params);
          if (!request) throw new Error('Invalid workflow graph. Node IDs must be unique, dependencies must exist, and cycles are not allowed.');
          const start = {
            ...request,
            notification: parent.hyp3rc0d3 === true && input.notifyParent === undefined ? 'immediate' as const : request.notification,
          };
          const execution = this.preflight(parent.session.sessionId, start.nodes, start.maxConcurrency);
          const workflow = this.workflows.start(parent.session.sessionId, toolCallId, start, modelRuntime, signal, execution);
          return deliver([this.workflows.getWorkflowSummary(parent.session.sessionId, workflow.id)]);
        }
        if (input.action === 'list') return deliver(this.workflows.getWorkflowSummaries(parent.session.sessionId));
        if (input.action === 'finalize') {
          const root = parent.session.sessionId;
          const teams = this.teams.finalizationSnapshot(root);
          const workflows = this.workflows.getWorkflowSummaries(root).map((workflow) => ({
            workflowId: workflow.id,
            status: workflow.status,
            error: workflow.error,
            notificationDeliveryErrors: workflow.notificationDeliveryErrors,
            nodes: workflow.nodes.map((node) => ({ nodeId: node.id, status: node.status, runId: node.runId, error: node.error, results: `agent_workflow action=results workflowId=${workflow.id} nodeIds=["${node.id}"]` })),
          }));
          const schedulerActive = this.workflows.hasActive(root);
          const attention = teams.some((team) => team.needsAttention) || workflows.some((workflow) => workflow.status === 'paused' || workflow.nodes.some((node) => node.status === 'interrupted' || (node.status === 'pending' && workflow.status !== 'running')));
          const active = schedulerActive || teams.some((team) => team.active.length > 0) || workflows.some((workflow) => workflow.status === 'running' || workflow.nodes.some((node) => node.status === 'running' || node.status === 'pending'));
          const status = attention ? 'needs_attention' : teams.some((team) => team.blockedByCaller.length > 0) ? 'yield' : active ? 'wait' : 'ready';
          const instructions = status === 'needs_attention'
            ? 'Review unresolved work. For interrupted agents, explicitly use followup_task or close_agent/release_agent after review; for paused workflows, explicitly resume or cancel as appropriate. Do not replay automatically.'
            : status === 'yield'
              ? 'Yield a brief progress-only turn, not a final report, to release the shared writer lease; continue on automatic join.'
              : status === 'wait'
                ? 'Use bounded wait_agent with stateOnly:true on relevant direct children by teamId; do not tight-loop status. Wait for scheduler and notification delivery to settle.'
                : 'Collect and synthesize required task and workflow results, including full ranges where needed. Recheck finalize immediately before reporting if further work was spawned.';
          const snapshot = { ready: status === 'ready', status, instructions, schedulerActive, teams, workflows };
          return { content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }], details: { kind: 'fate-subagent-workflow' as const, version: 1 as const, workflowIds: workflows.map((workflow) => workflow.workflowId), runIds: workflows.flatMap((workflow) => workflow.nodes.flatMap((node) => node.runId ? [node.runId] : [])) } };
        }
        if (!input.workflowId) throw new Error(`${input.action} requires workflowId.`);
        if (input.action === 'status') return deliver([this.workflows.getWorkflowSummary(parent.session.sessionId, input.workflowId)]);
        if (input.action === 'results') {
          const result = workflowResultsToolResult(this.workflows.results(parent.session.sessionId, input.workflowId, input.nodeIds, input.textOffset, input.textLength));
          return result;
        }
        if (input.action === 'cancel') {
          await this.workflows.cancel(parent.session.sessionId, input.workflowId, input.reason);
          return deliver([this.workflows.getWorkflowSummary(parent.session.sessionId, input.workflowId)]);
        }
        if (input.action === 'resume') {
          if (parent.agentStrategy === 'off') throw new Error('Goal agent strategy is off; recovered workflows cannot resume.');
          const workflow = this.workflows.getWorkflow(parent.session.sessionId, input.workflowId);
          if (!workflow) throw new Error(`Unknown agent workflow ${input.workflowId}.`);
          const execution = this.preflight(parent.session.sessionId, workflow.nodes.map((node) => node.request), workflow.maxConcurrency, workflow.execution);
          await this.workflows.resume(parent.session.sessionId, input.workflowId, modelRuntime, execution);
          return deliver([this.workflows.getWorkflowSummary(parent.session.sessionId, input.workflowId)]);
        }
        throw new Error('Unknown agent_workflow action.');
      },
    });
  }

  getWorkflowViews(parentSessionId: string): import('../../shared/contracts/ipc').SubagentWorkflow[] {
    return this.workflows.getWorkflowViews(parentSessionId);
  }

  hasActive(parentSessionId: string): boolean { return this.workflows.hasActive(parentSessionId); }
  hasAnyActive(): boolean { return this.workflows.hasAnyActive(); }

  async cancelParent(parentSessionId: string): Promise<void> { await this.workflows.cancelParent(parentSessionId); }

  async cancelAll(): Promise<void> {
    const outcomes = await Promise.allSettled(this.workflows.parentIds().map((parentSessionId) => this.cancelParent(parentSessionId)));
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Agent workflow cancellation cleanup failed.');
  }

  releaseParent(parentSessionId: string): void {
    const runIds = this.workflows.getWorkflows(parentSessionId).flatMap((workflow) => workflow.nodes.flatMap((node) => node.runId ? [node.runId] : []));
    this.workflows.releaseParent(parentSessionId);
    for (const runId of runIds) this.cancelLivenessTimers(runId);
  }

  reset(): void {
    this.workflows.reset();
    for (const timers of this.livenessTimers.values()) for (const timer of timers) timer.cancel();
    this.livenessTimers.clear();
    this.activeTeamNodeByRun.clear();
  }

  restoreParent(session: AgentSession): void {
    if (this.workflows.hasActive(session.sessionId)) return;
    const candidates: SubagentWorkflow[] = [];
    for (const entry of session.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== 'custom' || entry.customType !== WORKFLOW_SNAPSHOT_CUSTOM_TYPE) continue;
      const snapshot = entry.data as Partial<SubagentWorkflowSnapshot>;
      if (snapshot?.kind === 'fate-subagent-workflow-snapshot' && snapshot.version === 1 && snapshot.workflow?.id) candidates.push(snapshot.workflow);
    }
    this.workflows.restore(session.sessionId, candidates);
  }

  private preflight(parentSessionId: string, nodes: readonly WorkflowNodeRequest[], _maxConcurrency: number, persisted?: SubagentWorkflowExecutionBinding): SubagentWorkflowExecutionBinding {
    const availableTeams = this.teams.getTeams(parentSessionId);
    const persistedTeam = persisted
      ? availableTeams.find((candidate) => candidate.id === persisted.teamId && candidate.rootNodeId === persisted.rootNodeId)
      : undefined;
    if (persisted && !persistedTeam) throw new Error(`Agent workflow is bound to unavailable Team ${persisted.teamId}; select another workflow or restore that Team. It will not migrate to the currently selected Team.`);
    const root = persisted?.rootNodeId ?? this.teams.rootNodeId(parentSessionId);
    const inspected = this.teams.inspectNode(root, root);
    const team = persistedTeam ?? this.teams.getTeams(parentSessionId).find((candidate) => candidate.id === inspected.teamId)!;
    const oversizedTask = nodes.find((node) => Buffer.byteLength(node.task, 'utf8') > team.limits.maxMessageBytes);
    if (oversizedTask) {
      throw new Error(`Agent workflow node ${oversizedTask.id} requires a ${Buffer.byteLength(oversizedTask.task, 'utf8')}-byte input envelope, above the Team ${team.limits.maxMessageBytes}-byte limit. Nothing was started.`);
    }
    return { kind: 'agent-team', teamId: team.id, rootNodeId: root };
  }

  private async launchNode(
    workflow: SubagentWorkflow,
    node: SubagentWorkflowNode,
    request: WorkflowNodeRequest,
    modelRuntime: ModelRuntime,
    signal: AbortSignal,
  ): Promise<{ runId: string; completion: Promise<SubagentWorkflowRun> }> {
    const execution = workflow.execution;
    if (!execution) throw new Error(`Agent workflow ${workflow.id} has no immutable Team binding.`);
    const root = execution.rootNodeId;
    let first: TeamAttempt | undefined;
    let firstAttempt = 0;
    let lastAdmissionError: unknown;
    for (let attempt = 1; attempt <= request.routing.maxAttempts; attempt += 1) {
      if (signal.aborted) throw Object.assign(new Error(String(signal.reason || 'Workflow cancelled.')), { name: 'AbortError' });
      try {
        first = await this.spawnAttempt(root, workflow, node, request, modelRuntime, signal, attempt);
        firstAttempt = attempt;
        break;
      } catch (error) {
        lastAdmissionError = error;
        if (!retryableAdmissionFailure(error, signal)) throw error;
      }
    }
    if (!first) throw lastAdmissionError ?? new Error(`No routing attempt could admit workflow node ${node.id}.`);
    const logicalRunId = first.nodeId;
    this.activeTeamNodeByRun.set(logicalRunId, first.nodeId);
    return {
      runId: logicalRunId,
      completion: this.completeAttempts(root, logicalRunId, first, firstAttempt, workflow, node, request, modelRuntime, signal),
    };
  }

  private async completeAttempts(
    root: string,
    logicalRunId: string,
    initial: TeamAttempt,
    initialAttempt: number,
    workflow: SubagentWorkflow,
    node: SubagentWorkflowNode,
    request: WorkflowNodeRequest,
    modelRuntime: ModelRuntime,
    signal: AbortSignal,
  ): Promise<SubagentWorkflowRun> {
    const attempts: Attempt[] = [];
    let current = initial;
    let lastAdmissionError: unknown;
    try {
      for (let attempt = initialAttempt; attempt <= request.routing.maxAttempts; attempt += 1) {
        this.activeTeamNodeByRun.set(logicalRunId, current.nodeId);
        const previousUsage = attempts.reduce((sum, previous) => addUsage(sum, previous.usage), emptyUsage());
        let settled: Attempt;
        try { settled = await this.awaitAttempt(root, current, workflow, node, request, signal, attempt, previousUsage); }
        finally {
          // A logical Team 'interrupted' receipt or cancelled wait does not prove
          // its SDK prompt stopped. Native task evidence must retain the actual lease.
          if (workflow.scheduler?.kind === 'native-pi-durable') await this.awaitNativePhysicalSettlement(root, current.nodeId);
        }
        attempts.push(settled);
        if (settled.status !== 'completed' || request.mailboxTtlMs === 0) {
          // Team settlement is authoritative. Cleanup races with an accepted follow-up
          // must not downgrade successful work or manufacture a model retry.
          await this.teams.release(root, current.nodeId).catch(() => undefined);
        }
        const mayRoute = settled.status === 'error' && !settled.resultTransportFailed && !settled.executionUnknown;
        if (!mayRoute || signal.aborted || attempt >= request.routing.maxAttempts) break;
        let next: TeamAttempt | undefined;
        for (let nextAttempt = attempt + 1; nextAttempt <= request.routing.maxAttempts; nextAttempt += 1) {
          try {
            next = await this.spawnAttempt(root, workflow, node, request, modelRuntime, signal, nextAttempt);
            attempt = nextAttempt - 1;
            break;
          } catch (error) {
            lastAdmissionError = error;
            if (!retryableAdmissionFailure(error, signal)) throw error;
          }
        }
        if (!next) break;
        current = next;
      }
      if (!attempts.length) throw lastAdmissionError ?? new Error(`No routing attempt completed for workflow node ${node.id}.`);
      const final = attempts[attempts.length - 1]!;
      const usage = attempts.reduce((sum, attempt) => addUsage(sum, attempt.usage), emptyUsage());
      const admissionError = lastAdmissionError instanceof Error ? lastAdmissionError.message : lastAdmissionError ? String(lastAdmissionError) : undefined;
      const errors = [final.error, admissionError].filter((error): error is string => error !== undefined);
      const error = final.status === 'completed' ? undefined : errors.length ? errors.join('\n') : 'All configured routing attempts failed.';
      this.reportNodeBudget(workflow, node, final.nodeId, usage);
      const notificationDeliveryErrors: WorkflowNotificationDeliveryError[] = attempts.flatMap((attempt) => attempt.notificationDeliveryError === undefined ? [] : [{ nodeId: node.id, phase: 'team-result' as const, error: attempt.notificationDeliveryError, timestamp: attempt.endedAt }]);
      const run: SubagentWorkflowRun = {
        retainedOutcome: { ...(final.result === undefined ? {} : { result: final.result }), ...(error === undefined ? {} : { error }) },
        notificationDeliveryErrors,
        id: final.nodeId,
        parentSessionId: workflow.parentSessionId,
        parentToolCallId: workflow.parentToolCallId,
        task: node.request.task,
        role: request.role ?? 'agent',
        ...(node.handle ? { handle: node.handle } : {}),
        ...(node.displayName ? { displayName: node.displayName } : {}),
        agentName: request.agent ?? 'direct',
        agentSource: sourceForAgent(request.agent),
        permissionLevel: final.permissionLevel,
        enabledTools: final.enabledTools,
        skills: request.skills,
        skillMode: request.skillMode,
        preloadedSkills: request.preloadSkills ? request.skills : [],
        status: final.status,
        model: final.model,
        routingModels: attempts.map((attempt) => attempt.model),
        thinkingLevel: final.thinkingLevel,
        executionMode: 'workflow',
        controlCount: 0,
        attempt: final.attemptNumber,
        maxAttempts: request.routing.maxAttempts,
        mailbox: final.status === 'completed' && request.mailboxTtlMs > 0
          ? { state: 'available', ttlMs: request.mailboxTtlMs, expiresAt: final.endedAt + request.mailboxTtlMs, followUpCount: 0 }
          : { state: 'disabled', ttlMs: 0, followUpCount: 0 },
        notification: request.notification,
        ...(request.budget ? { budget: request.budget } : {}),
        workflowId: workflow.id,
        workflowNodeId: node.id,
        dependsOn: [...node.dependsOn],
        createdAt: attempts[0]!.startedAt,
        updatedAt: final.endedAt,
        startedAt: attempts[0]!.startedAt,
        endedAt: final.endedAt,
        ...(request.idleTimeoutMs ? { idleTimeoutMs: request.idleTimeoutMs } : {}),
        messages: [],
        tools: [],
        ...(final.result === undefined ? {} : { result: final.result }),
        ...(error === undefined ? {} : { error: error.slice(0, 4_000) }),
        omittedActivity: 0,
        transcriptTruncated: false,
        usage,
      };
      if (request.notification !== 'never' && !this.workflows.notificationsSuppressed(workflow.parentSessionId, workflow.id)) {
        const output = final.result ?? error ?? '(no text output)';
        const preview = output.length > 6_000 ? `${output.slice(0, 6_000)}\n[preview; ${output.length - 6_000} more characters]` : output;
        await Promise.resolve().then(() => this.host.notifyParent?.(
          workflow.parentSessionId,
          request.notification,
          `Agent workflow node ${node.displayName ?? node.id} settled as ${run.status}. Retrieve retained output with agent_workflow action=results workflowId=${workflow.id} nodeIds=["${node.id}"]; notification text is only a preview.\n${preview}`,
          [run.id],
          workflow.id,
        )).catch((error: unknown) => {
          notificationDeliveryErrors.push({ nodeId: node.id, phase: 'node-notification', error: error instanceof Error ? error.message : String(error), timestamp: Date.now() });
        });
      }
      return run;
    } finally {
      // Cancellation asks the engine host to interrupt by the logical run id after
      // aborting the completion wait. Keep the alias until that interrupt resolves.
      if (!signal.aborted) this.activeTeamNodeByRun.delete(logicalRunId);
    }
  }

  private async awaitNativePhysicalSettlement(root: string, nodeId: string): Promise<void> {
    const stillOwned = (): boolean => {
      const resources = this.teams.inspectNode(root, nodeId).resources;
      if (!resources) throw new Error('Actual SDK child settlement cannot be verified.');
      return resources.turnActive || resources.leaseHeld || resources.streaming;
    };
    if (!stillOwned()) return;
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const check = () => {
        try { if (stillOwned()) return; unsubscribe(); resolve(); }
        catch (error) { unsubscribe(); reject(error); }
      };
      unsubscribe = this.teams.subscribeNodeActivity(root, nodeId, check);
      check();
    });
  }

  private async spawnAttempt(
    root: string,
    workflow: SubagentWorkflow,
    node: SubagentWorkflowNode,
    request: WorkflowNodeRequest,
    modelRuntime: ModelRuntime,
    signal: AbortSignal,
    attempt: number,
  ): Promise<TeamAttempt> {
    const retained: TeamAttempt = { nodeId: '' };
    const model = modelForAttempt(request, attempt);
    const receipt = await this.teams.spawn(root, {
      task: request.task,
      name: `${node.handle ?? node.id}-a${attempt}`.slice(0, 64),
      ...(request.role ? { role: request.role } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.permissionLevel === undefined ? {} : { permission: request.permissionLevel }),
      ...(model ? { model } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}),
      skills: request.skills,
      skillMode: request.skillMode,
      preloadSkills: request.preloadSkills,
      ...(request.workspace ? { workspace: request.workspace } : {}),
    }, `agent-workflow:${workflow.id}:${node.id}:${attempt}:${randomUUID()}`, modelRuntime, signal, {
      onInitialTaskOutcome: (outcome) => { retained.outcome = outcome; },
      deliverFinalAnswer: false,
      ...(request.mailboxTtlMs > 0 ? { idleReleaseMs: request.mailboxTtlMs } : {}),
    });
    retained.nodeId = receipt.nodeId;
    if (receipt.taskId !== undefined) retained.taskId = receipt.taskId;
    return retained;
  }

  private async awaitAttempt(
    root: string,
    attempt: TeamAttempt,
    workflow: SubagentWorkflow,
    workflowNode: SubagentWorkflowNode,
    request: WorkflowNodeRequest,
    signal: AbortSignal,
    attemptNumber: number,
    previousUsage: SubagentUsage,
  ): Promise<Attempt> {
    const nodeId = attempt.nodeId;
    let unsubscribeUsage: (() => void) | undefined;
    try {
      this.armLivenessTimers(root, nodeId, workflow, workflowNode, request, signal);
      if (request.budget) {
        const observeUsage = () => {
          if (signal.aborted || workflow.status !== 'running' || workflowNode.status !== 'running') return;
          try {
            const current = this.teams.inspectNode(root, nodeId).node;
            this.reportNodeBudget(workflow, workflowNode, nodeId, addUsage(previousUsage, current.usage));
          } catch { /* Settlement or disposal may remove the node between activity and inspection. */ }
        };
        unsubscribeUsage = this.teams.subscribeNodeActivity(root, nodeId, observeUsage);
        observeUsage();
      }
      while (true) {
        const settled = await this.teams.waitForTaskSettlement(root, nodeId, TASK_SETTLEMENT_POLL_MS, signal, attempt.taskId);
        if (!settled) continue;
        const inspected = this.teams.inspectNode(root, nodeId);
        const task = settled.task as typeof settled.task & { resultTransportError?: string };
        const resultTransportError = task.status === 'completed'
          ? task.resultTransportError ?? (!settled.envelope ? 'The completed task has no persisted result envelope.' : undefined)
          : undefined;
        const outcome = attempt.outcome;
        const executionError = (outcome ?? task).error;
        const taskStatus = outcome?.status ?? task.status;
        const status: SubagentRun['status'] = taskStatus === 'completed' && (!resultTransportError || outcome !== undefined)
          ? 'completed'
          : taskStatus === 'cancelled' || taskStatus === 'interrupted'
            ? 'cancelled'
            : 'error';
        return {
          attemptNumber,
          nodeId,
          model: inspected.node.model,
          permissionLevel: inspected.node.permissionLevel,
          enabledTools: inspected.node.enabledTools,
          thinkingLevel: inspected.node.thinkingLevel,
          usage: inspected.node.usage,
          status,
          ...(outcome === undefined
            ? !resultTransportError && settled.envelope ? { result: settled.envelope.content } : {}
            : outcome.result === undefined ? {} : { result: outcome.result }),
          ...(outcome === undefined && resultTransportError
            ? { error: `Agent Team execution succeeded, but its result is unavailable: ${resultTransportError} The workflow will not rerun this side-effectful task.` }
            : executionError === undefined ? {} : { error: executionError }),
          ...(outcome?.executionUnknown ? { executionUnknown: true } : {}),
          ...(resultTransportError === undefined ? {} : { resultTransportFailed: true, notificationDeliveryError: resultTransportError }),
          startedAt: settled.task.startedAt ?? inspected.node.createdAt,
          endedAt: settled.task.endedAt ?? Date.now(),
        };
      }
    } finally {
      unsubscribeUsage?.();
      this.cancelLivenessTimers(nodeId);
    }
  }

  private armLivenessTimers(
    root: string,
    nodeId: string,
    workflow: SubagentWorkflow,
    workflowNode: SubagentWorkflowNode,
    request: WorkflowNodeRequest,
    signal: AbortSignal,
  ): void {
    this.cancelLivenessTimers(nodeId);
    const timers: CancelableTimer[] = [];
    this.livenessTimers.set(nodeId, timers);
    const inspected = this.teams.inspectNode(root, nodeId);
    const startedAt = workflowNode.startedAt ?? inspected.node.createdAt;
    const active = () => !signal.aborted && this.livenessTimers.get(nodeId) === timers;
    const inspectActiveNode = () => {
      try {
        const current = this.teams.inspectNode(root, nodeId).node;
        return current.status === 'active' || current.status === 'creating' ? current : undefined;
      } catch {
        return undefined;
      }
    };
    const reported = (trigger: 'runtime-limit' | 'idle') => workflow.livenessReports?.some((report) => report.trigger === trigger && report.node?.id === workflowNode.id) ?? false;
    if (request.timeoutMs > 0 && !reported('runtime-limit')) {
      timers.push(scheduleLongTimeout(() => {
        if (!active() || reported('runtime-limit')) return;
        const current = inspectActiveNode();
        if (!current) return;
        this.reportNodeTiming(workflow, workflowNode, nodeId, 'runtime-limit', startedAt, current.updatedAt, request.timeoutMs);
      }, Math.max(0, startedAt + request.timeoutMs - Date.now())));
    }
    if (request.idleTimeoutMs !== undefined && request.idleTimeoutMs > 0) {
      const armIdle = (lastObservedAt: number) => {
        const timer = scheduleLongTimeout(() => {
          if (!active()) return;
          const current = inspectActiveNode();
          if (!current || reported('idle')) return;
          if (current.updatedAt > lastObservedAt) {
            armIdle(current.updatedAt);
            return;
          }
          this.reportNodeTiming(workflow, workflowNode, nodeId, 'idle', startedAt, current.updatedAt, request.idleTimeoutMs!);
        }, Math.max(0, lastObservedAt + request.idleTimeoutMs! - Date.now()));
        timers.push(timer);
      };
      armIdle(inspected.node.updatedAt);
    }
    if (!timers.length) this.livenessTimers.delete(nodeId);
  }

  private cancelLivenessTimers(nodeId: string): void {
    const timers = this.livenessTimers.get(nodeId);
    if (!timers) return;
    this.livenessTimers.delete(nodeId);
    for (const timer of timers) timer.cancel();
  }

  private reportNodeTiming(
    workflow: SubagentWorkflow,
    node: SubagentWorkflowNode,
    runId: string,
    trigger: 'runtime-limit' | 'idle',
    startedAt: number,
    lastObservableTeamUpdateAt: number,
    thresholdMs: number,
  ): void {
    if (workflow.status !== 'running' || node.status !== 'running') return;
    const detectedAt = Date.now();
    const idle = trigger === 'idle';
    const report: SubagentWorkflowLivenessReport = {
      id: `${workflow.id}:${trigger}:${node.id}:${detectedAt}`.slice(0, 160),
      trigger,
      reason: idle
        ? `Workflow node ${node.id} crossed its advisory ${thresholdMs}ms interval without an observable Agent Team update. Execution continues.`
        : `Workflow node ${node.id} crossed its advisory ${thresholdMs}ms runtime checkpoint. Execution continues.`,
      evidence: [{
        signal: idle ? 'idle-duration' : 'runtime-duration',
        detail: idle
          ? `The last observable Agent Team node update was at ${lastObservableTeamUpdateAt}; this is not a claim about model progress or token streaming.`
          : `The Team node has remained active for at least ${thresholdMs}ms; the checkpoint does not abort, retry, or skip it.`,
        count: idle ? Math.max(0, detectedAt - lastObservableTeamUpdateAt) : Math.max(0, detectedAt - startedAt),
      }],
      recentProgress: [],
      counters: {
        turns: workflow.usage.turns,
        completedNodes: workflow.nodes.filter((candidate) => candidate.status === 'completed').length,
        runningNodes: workflow.nodes.filter((candidate) => candidate.status === 'running').length,
        pendingNodes: workflow.nodes.filter((candidate) => candidate.status === 'pending').length,
        totalNodes: workflow.nodes.length,
        softTurnThreshold: Math.max(1, workflow.budget?.maxTurns ?? workflow.usage.turns + 32),
      },
      timing: { detectedAt, startedAt, updatedAt: lastObservableTeamUpdateAt, lastObservableTeamUpdateAt },
      workflow: { id: workflow.id },
      node: { id: node.id, runId },
      checkpointSummary: `Node ${node.id} remains active. This advisory did not pause, cancel, retry, or otherwise change Team execution.`,
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    };
    workflow.livenessReports = [...(workflow.livenessReports ?? []), report].slice(-20);
    workflow.updatedAt = detectedAt;
    this.host.persist(workflow.parentSessionId, workflow);
    this.host.emit(workflow.parentSessionId, { type: 'subagent.workflow.liveness', workflowId: workflow.id, report, timestamp: detectedAt });
  }

  private reportNodeBudget(workflow: SubagentWorkflow, node: SubagentWorkflowNode, runId: string, usage: SubagentUsage): void {
    const budget = node.request.budget;
    if (!budget || workflow.status !== 'running' || node.status !== 'running') return;
    const reportedSignals = new Set((workflow.livenessReports ?? [])
      .filter((report) => report.node?.id === node.id && (report.trigger === 'adaptive-limit' || report.trigger === 'resource-limit'))
      .flatMap((report) => report.evidence.map((item) => item.signal)));
    const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const candidates: SubagentWorkflowLivenessReport['evidence'] = [
      ...(budget.maxTurns !== undefined && usage.turns > budget.maxTurns ? [{ signal: 'turn-threshold' as const, detail: `Workflow node ${node.id} turns ${usage.turns} crossed its advisory ${budget.maxTurns} threshold.`, count: usage.turns }] : []),
      ...(budget.maxCostUsd !== undefined && usage.cost > budget.maxCostUsd ? [{ signal: 'cost-threshold' as const, detail: `Workflow node ${node.id} cost $${usage.cost.toFixed(6)} crossed its advisory $${budget.maxCostUsd.toFixed(6)} threshold.` }] : []),
      ...(budget.maxInputTokens !== undefined && usage.input > budget.maxInputTokens ? [{ signal: 'input-token-threshold' as const, detail: `Workflow node ${node.id} input tokens ${usage.input} crossed its advisory ${budget.maxInputTokens} threshold.`, count: usage.input }] : []),
      ...(budget.maxOutputTokens !== undefined && usage.output > budget.maxOutputTokens ? [{ signal: 'output-token-threshold' as const, detail: `Workflow node ${node.id} output tokens ${usage.output} crossed its advisory ${budget.maxOutputTokens} threshold.`, count: usage.output }] : []),
      ...(budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens ? [{ signal: 'total-token-threshold' as const, detail: `Workflow node ${node.id} total tokens ${totalTokens} crossed its advisory ${budget.maxTotalTokens} threshold.`, count: totalTokens }] : []),
    ];
    const evidence = candidates.filter((candidate) => !reportedSignals.has(candidate.signal));
    if (!evidence.length) return;
    const turnCrossed = evidence.some((candidate) => candidate.signal === 'turn-threshold');
    const detectedAt = Date.now();
    const completedNodes = workflow.nodes.filter((candidate) => candidate.status === 'completed').length;
    const report: SubagentWorkflowLivenessReport = {
      id: `${workflow.id}:node-budget:${node.id}:${detectedAt}`.slice(0, 160),
      trigger: turnCrossed ? 'adaptive-limit' : 'resource-limit',
      reason: `Workflow node ${node.id} crossed an advisory budget threshold. Execution continues; Agent Team admission and authority are unchanged.`,
      evidence,
      recentProgress: [],
      counters: {
        turns: workflow.usage.turns + usage.turns,
        completedNodes,
        runningNodes: workflow.nodes.filter((candidate) => candidate.status === 'running').length,
        pendingNodes: workflow.nodes.filter((candidate) => candidate.status === 'pending').length,
        totalNodes: workflow.nodes.length,
        softTurnThreshold: Math.max(1, budget.maxTurns ?? workflow.usage.turns + usage.turns + 32),
      },
      timing: { detectedAt, startedAt: workflow.createdAt, updatedAt: detectedAt },
      workflow: { id: workflow.id },
      node: { id: node.id, runId },
      checkpointSummary: `Node ${node.id} crossed an advisory budget; the workflow was not paused, skipped, or terminated.`,
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    };
    workflow.livenessReports = [...(workflow.livenessReports ?? []), report].slice(-20);
    workflow.updatedAt = detectedAt;
    this.host.persist(workflow.parentSessionId, workflow);
    this.host.emit(workflow.parentSessionId, { type: 'subagent.workflow.liveness', workflowId: workflow.id, report, timestamp: detectedAt });
  }

  private requireParent(parentSessionId: string, cwd: string): ParentContext {
    const parent = this.host.resolveParent(parentSessionId);
    if (!parent || !cwd || path.resolve(parent.projectPath) !== path.resolve(cwd)) throw new Error('The parent Pi session is no longer active in this Fate project.');
    if (!parent.session.model) throw new Error('The parent session has no authenticated model for Agent workflow nodes.');
    return parent;
  }

  private deliver(parent: ParentContext, workflows: Parameters<SubagentWorkflowEngine['format']>[0]) {
    const result = workflowToolResult(workflows, this.workflows.format(workflows));
    const text = result.content.map((part) => part.text).join('\n');
    try {
      assertContextTransfer('orchestrator-to-parent workflow result', parent.session.model!, text, parent.session);
      return result;
    } catch (error) {
      if (!isContextWindowError(error)) throw error;
      return {
        ...result,
        content: [{ type: 'text' as const, text: `${error.message}\n\nThe complete workflow remains available in Fate's Agents inspector; no oversized result was inserted into parent context.` }],
      };
    }
  }
}
