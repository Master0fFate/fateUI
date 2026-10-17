import type { ParentModel } from './SubagentProtocol';

export const CLAUDE_BRIDGE_PROVIDER = 'claude-bridge';
const ANTHROPIC_PROVIDER = 'anthropic';
const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

type ModelRef = Pick<ParentModel, 'provider' | 'id'>;
type AuthChecker = { checkAuth?(providerId: string): Promise<{ type: string } | undefined> };

const isClaudeProvider = (model: ModelRef) => model.provider === ANTHROPIC_PROVIDER || model.provider === CLAUDE_BRIDGE_PROVIDER;

export async function anthropicUsesSubscription(modelRuntime: AuthChecker): Promise<boolean> {
  const auth = await modelRuntime.checkAuth?.(ANTHROPIC_PROVIDER).catch(() => undefined);
  return auth?.type === 'oauth';
}

function preferred<T extends ModelRef>(candidates: readonly T[], subscription: boolean): T | undefined {
  const bridge = candidates.find((model) => model.provider === CLAUDE_BRIDGE_PROVIDER);
  const anthropic = candidates.find((model) => model.provider === ANTHROPIC_PROVIDER);
  return (subscription || !anthropic ? bridge : anthropic) ?? anthropic ?? bridge;
}

export function routeClaudeSelection<T extends ModelRef>(selection: ModelRef, enabled: readonly T[], subscription: boolean): ModelRef {
  if (selection.provider !== ANTHROPIC_PROVIDER) return selection;
  const bridge = enabled.find((model) => model.provider === CLAUDE_BRIDGE_PROVIDER && model.id === selection.id);
  if (!bridge) return selection;
  const anthropicReady = enabled.some((model) => model.provider === ANTHROPIC_PROVIDER && model.id === selection.id);
  return subscription || !anthropicReady ? bridge : selection;
}

export function routeClaudeReference<T extends ModelRef>(reference: string, enabled: readonly T[], subscription: boolean): string {
  const slash = reference.indexOf('/');
  if (slash < 0) return reference;
  const routed = routeClaudeSelection({ provider: reference.slice(0, slash), id: reference.slice(slash + 1) }, enabled, subscription);
  return `${routed.provider}/${routed.id}`;
}

export function resolveClaudeReference<T extends ModelRef>(reference: string, enabled: readonly T[], subscription: boolean): T | undefined {
  const bare = enabled.filter((model) => model.id === reference);
  if (bare.length > 1 && bare.every(isClaudeProvider)) return preferred(bare, subscription);
  const family = reference.toLowerCase();
  if (!CLAUDE_FAMILIES.has(family)) return undefined;
  const matches = enabled.filter((model) => isClaudeProvider(model) && model.id.startsWith(`claude-${family}-`));
  const newest = matches.map((model) => model.id).sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))[0];
  return newest ? preferred(matches.filter((model) => model.id === newest), subscription) : undefined;
}
