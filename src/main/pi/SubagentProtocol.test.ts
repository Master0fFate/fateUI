import { describe, expect, it } from 'vitest';
import { workflowParameters } from './SubagentProtocol';

describe('SubagentProtocol tool schemas', () => {
  it('uses object-root schemas that OpenAI-compatible providers can accept', () => {
    expect(workflowParameters).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['start', 'list', 'status', 'cancel', 'resume'] } },
      additionalProperties: false,
    });
    expect(workflowParameters).not.toHaveProperty('anyOf');
  });
});
