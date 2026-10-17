import type { SubagentWorkflow } from './SubagentWorkflow';

export function workflowToolResult(workflows: readonly SubagentWorkflow[], formatted: string) {
  const runIds = workflows.flatMap((workflow) => workflow.nodes.flatMap((node) => node.runId ? [node.runId] : []));
  return {
    content: [{ type: 'text' as const, text: formatted }],
    details: { kind: 'fate-subagent-workflow' as const, version: 1 as const, workflowIds: workflows.map((workflow) => workflow.id), runIds },
  };
}
