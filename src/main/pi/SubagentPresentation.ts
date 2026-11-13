import type { WorkflowResults } from './SubagentWorkflow';

export function workflowToolResult(workflows: readonly { id: string; nodes: readonly { runId?: string | undefined }[] }[], formatted: string) {
  const runIds = workflows.flatMap((workflow) => workflow.nodes.flatMap((node) => node.runId ? [node.runId] : []));
  return {
    content: [{ type: 'text' as const, text: formatted }],
    details: { kind: 'fate-subagent-workflow' as const, version: 1 as const, workflowIds: workflows.map((workflow) => workflow.id), runIds },
  };
}

export function workflowResultsToolResult(results: WorkflowResults) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(results) }],
    details: {
      kind: 'fate-subagent-workflow' as const,
      version: 1 as const,
      workflowIds: [results.workflowId],
      runIds: results.nodes.flatMap((node) => node.runId === null ? [] : [node.runId]),
    },
  };
}
