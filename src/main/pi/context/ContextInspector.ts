import type { InlineExtension } from '@earendil-works/pi-coding-agent';

const WIDGET_KEY = 'context';
const TOP_RESULTS = 3;

const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
const compact = (tokens: number): string => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const part of content as Array<{ type?: string; text?: string; data?: string }>) {
    if (part.type === 'text' && part.text) bytes += Buffer.byteLength(part.text, 'utf8');
    else if (part.type === 'image' && part.data) bytes += Buffer.byteLength(part.data, 'utf8');
  }
  return Math.ceil(bytes / 4);
}

export function createContextInspectorExtension(): InlineExtension {
  return {
    name: 'fate-context',
    hidden: true,
    factory(pi) {
      pi.on('context_with_system', (event, ctx) => {
        const buckets = { system: 0, user: 0, assistant: 0, toolResults: 0, other: 0 };
        const counts = { user: 0, assistant: 0, toolResults: 0 };
        const results: Array<{ name: string; tokens: number }> = [];
        for (const message of event.messages) {
          const role = (message as { role: string }).role;
          const tokens = contentTokens((message as { content?: unknown }).content);
          if (role === 'system') buckets.system += tokens;
          else if (role === 'user') { buckets.user += tokens; counts.user += 1; }
          else if (role === 'assistant') { buckets.assistant += tokens; counts.assistant += 1; }
          else if (role === 'toolResult') {
            buckets.toolResults += tokens;
            counts.toolResults += 1;
            results.push({ name: (message as { toolName?: string }).toolName ?? 'tool', tokens });
          } else buckets.other += tokens;
        }
        const active = new Set(pi.getActiveTools());
        const toolTokens = pi.getAllTools().filter((tool) => active.has(tool.name)).reduce((sum, tool) => sum + estimateTokens(JSON.stringify(tool)), 0);
        const usage = ctx.getContextUsage();
        const total = buckets.system + buckets.user + buckets.assistant + buckets.toolResults + buckets.other + toolTokens;
        const lines = [
          usage?.tokens !== null && usage?.tokens !== undefined
            ? `Context ${compact(usage.tokens)} / ${compact(usage.contextWindow)} (${usage.percent?.toFixed(0) ?? '?'}%) · estimate below ${compact(total)}`
            : `Context estimate ${compact(total)} tokens${usage ? ` of ${compact(usage.contextWindow)} window` : ''}`,
          `System prompt ${compact(buckets.system)} · tool schemas ${compact(toolTokens)} (${active.size} tools)`,
          `User ${compact(buckets.user)} (${counts.user}) · assistant ${compact(buckets.assistant)} (${counts.assistant}) · tool results ${compact(buckets.toolResults)} (${counts.toolResults})`,
          ...(buckets.other ? [`Other messages ${compact(buckets.other)}`] : []),
          ...results.sort((left, right) => right.tokens - left.tokens).slice(0, TOP_RESULTS).map((result) => `Largest result: ${result.name} ${compact(result.tokens)}`),
        ];
        ctx.ui.setWidget(WIDGET_KEY, lines);
        return undefined;
      });
    },
  };
}
