import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server({ name: 'fate-monitor-example', version: '1.0.0' }, {
  capabilities: { experimental: { 'fate.monitorWatch': { version: 1 } } },
});

let timer;
server.setRequestHandler(z.object({
  method: z.literal('fate/watch/subscribe'),
  params: z.object({ eventId: z.string(), revision: z.string() }).strict(),
}), async ({ params }) => {
  if (timer || params.eventId !== 'example-job' || params.revision !== 'demo-1') {
    throw new McpError(ErrorCode.InvalidParams, 'Expected one example-job / demo-1 subscription.');
  }
  timer = setTimeout(() => {
    void server.notification({ method: 'notifications/fate/watch', params: { ...params, result: 'success' } })
      .catch(() => { process.exitCode = 1; });
  }, 1_000);
  return {};
});

process.stdin.once('end', () => clearTimeout(timer));
await server.connect(new StdioServerTransport());
