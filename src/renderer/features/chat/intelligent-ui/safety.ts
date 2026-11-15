import { autoClose, parseExpression, split, tokenize, type ActionPlan, type ASTNode } from '@openuidev/lang-core';

export const MAX_PROGRAM_LENGTH = 48_000;
const MAX_WORK = 12_000;
const MAX_LIST = 512;
const scalarFunctions = new Set(['Count', 'Sum', 'Avg', 'Min', 'Max', 'Round', 'Floor', 'Ceil', 'Abs', 'Pow', 'Sqrt', 'Random', 'Clamp', 'Percent', 'Lerp', 'Payment', 'Format', 'Join', 'Plural', 'Pad', 'Upper', 'Lower', 'Trim', 'Capitalize', 'Replace', 'Duration', 'Default', 'Includes', 'IndexOf', 'Now', 'Today', 'FormatDate', 'AddDays', 'AddMonths', 'DaysBetween', 'MonthsBetween', 'StartOf', 'Change', 'Stats']);
const builtinFunctions = ['Each', 'Filter', 'Sort', 'First', 'Last', 'Count', 'Sum', 'Avg', 'Min', 'Max', 'Round', 'Floor', 'Ceil', 'Abs'];
const localActions = ['Set', 'Reset', 'ToAssistant'];
export const INTERNAL_ACTION_FUNCTION = 'BoundedAction';
const trustedActionSteps = new WeakSet<object>();
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const stateIdentifier = /^\$[A-Za-z_][A-Za-z0-9_]*$/u;
const runtimeDataMarkers = new Map<string, ReadonlySet<string>>([
  ['k', new Set(['Comp', 'Str', 'Num', 'Bool', 'Null', 'Arr', 'Obj', 'Ref', 'Ph', 'StateRef', 'RuntimeRef', 'BinOp', 'UnaryOp', 'Ternary', 'Member', 'Index', 'Assign'])],
  ['__reactive', new Set(['assign'])],
  ['type', new Set(['element'])],
]);

export function isRuntimeData(value: object): boolean {
  for (const [key, markers] of runtimeDataMarkers) {
    const marker = (value as Record<string, unknown>)[key];
    if (typeof marker === 'string' && markers.has(marker)) return true;
  }
  return false;
}

function requireIdentifier(name: string, state = false): string {
  if (!(state ? stateIdentifier : identifier).test(name) || name.length > 128) throw new Error('This answer contains an unsupported identifier.');
  return name;
}

function freezeActionData(value: unknown, depth = 0, budget = { left: 48_000, text: 96_000 }): void {
  if (--budget.left < 0 || depth > 96) throw new Error('This action is too complex.');
  if (typeof value === 'string' && (value.length > 16_000 || (budget.text -= value.length) < 0)) throw new Error('This action is too large.');
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  if (Array.isArray(value) && value.length > MAX_LIST) throw new Error('This action has too many items.');
  Object.freeze(value);
  for (const item of Object.values(value)) freezeActionData(item, depth + 1, budget);
}

function inspectActionExpression(node: ASTNode, functions: ReadonlySet<string>, scope = new Set<string>(), depth = 0, budget = { left: MAX_WORK }): { work: number; size: number } {
  if (--budget.left < 0 || depth > 48) throw new Error('This action is too complex.');
  const inspect = (child: ASTNode, childScope = scope) => inspectActionExpression(child, functions, childScope, depth + 1, budget);
  let children: ASTNode[] = [];
  if (node.k === 'Str') {
    if (typeof node.v !== 'string' || node.v.length > 16_000) throw new Error('This action contains oversized text.');
  } else if (node.k === 'Num') {
    if (!Number.isFinite(node.v)) throw new Error('This action contains an invalid number.');
  } else if (node.k === 'Bool') {
    if (typeof node.v !== 'boolean') throw new Error('This action contains an invalid value.');
  } else if (node.k === 'StateRef') requireIdentifier(node.n, true);
  else if (node.k === 'Ref') {
    requireIdentifier(node.n);
    if (!scope.has(node.n)) throw new Error('This action contains an unresolved reference.');
  } else if (node.k === 'Arr') {
    if (node.els.length > MAX_LIST) throw new Error('This action has too many items.');
    children = node.els;
  } else if (node.k === 'Obj') {
    if (node.entries.length > 64 || node.entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('This action contains an unsupported object.');
    children = node.entries.map(([, value]) => value);
  } else if (node.k === 'Comp') {
    if (node.name === INTERNAL_ACTION_FUNCTION || !functions.has(node.name) && !builtinFunctions.includes(node.name)) throw new Error('This action contains an unsupported function.');
    if (node.args.length > 64 || node.mappedProps && Object.keys(node.mappedProps).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('This action contains unsupported arguments.');
    if (node.name === 'Each') {
      const [list, variable, template] = node.args;
      const name = variable?.k === 'Str' ? variable.v : variable?.k === 'Ref' ? variable.n : null;
      if (!list || !template || !name) throw new Error('This action contains an invalid loop.');
      const nestedScope = new Set(scope);
      nestedScope.add(requireIdentifier(name));
      const input = inspect(list), body = inspect(template, nestedScope);
      const work = input.work + input.size * body.work + 1;
      if (work > MAX_WORK) throw new Error('This action generates too much local work.');
      return { work, size: input.size };
    }
    children = node.mappedProps ? Object.values(node.mappedProps) : node.args;
  } else if (node.k === 'BinOp') {
    if (!['-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(node.op)) throw new Error('This action contains an unbounded operation.');
    children = [node.left, node.right];
  } else if (node.k === 'UnaryOp') {
    if (node.op !== '-' && node.op !== '!') throw new Error('This action contains an unsupported operation.');
    children = [node.operand];
  } else if (node.k === 'Ternary') children = [node.cond, node.then, node.else];
  else if (node.k === 'Member') {
    if (typeof node.field !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(node.field)) throw new Error('This action contains an unsupported field.');
    children = [node.obj];
  } else if (node.k === 'Index') children = [node.obj, node.index];
  else if (node.k !== 'Null') throw new Error('This action contains an unsupported expression.');
  const results = children.map((child) => inspect(child));
  const work = 1 + results.reduce((total, result) => total + result.work, 0);
  if (work > MAX_WORK) throw new Error('This action generates too much local work.');
  const size = node.k === 'Arr' ? node.els.length : node.k === 'StateRef' || node.k === 'Ref' || node.k === 'Comp' && (!scalarFunctions.has(node.name) || ['Default', 'Round', 'Floor', 'Ceil', 'Abs'].includes(node.name)) ? MAX_LIST : node.k === 'Member' || node.k === 'Index' || node.k === 'Ternary' ? Math.max(1, ...results.map((result) => result.size)) : 1;
  return { work, size };
}

export function guardActionPlan(value: unknown, functions: ReadonlySet<string>): unknown {
  if (!value || typeof value !== 'object' || !('steps' in value) || !Array.isArray(value.steps) || value.steps.length !== 1) return null;
  const step = value.steps[0] as ActionPlan['steps'][number] | undefined;
  if (!step || typeof step !== 'object') return null;
  if (step.type === 'set') {
    requireIdentifier(step.target, true);
    if (step.valueAST?.k !== 'Comp' || step.valueAST.name !== 'BoundedValue' || step.valueAST.args.length !== 1) return null;
    inspectActionExpression(step.valueAST, functions);
  } else if (step.type === 'reset') {
    if (!Array.isArray(step.targets) || !step.targets.length || step.targets.length > 16) return null;
    for (const target of step.targets) requireIdentifier(target, true);
  } else if (step.type === 'continue_conversation') {
    if (typeof step.message !== 'string' || !step.message.trim() || step.message.length > 4000) return null;
    if (step.context !== undefined && (!safeState(step.context) || JSON.stringify(step.context).length > 8000)) return null;
  } else return null;
  freezeActionData(step);
  trustedActionSteps.add(step);
  return value;
}

export function isSafeActionPlan(value: unknown): value is ActionPlan {
  return Boolean(value && typeof value === 'object' && 'steps' in value && Array.isArray(value.steps)
    && value.steps.length > 0 && value.steps.length <= 16
    && value.steps.every((step: unknown) => step !== null && typeof step === 'object' && trustedActionSteps.has(step)));
}

export function programIssue(source: string, components: readonly string[], functions: readonly string[], isStreaming = false): string | null {
  if (source.length > MAX_PROGRAM_LENGTH) return 'This answer exceeds the 48,000-character limit.';
  if (!source.trim()) return null;
  if (source.split('\n', 514).length > 512) return 'This answer has too many lines.';
  let quoted = false, escaped = false, run = 0;
  const delimiters: string[] = [];
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; run = 0; }
    else if ('([{'.includes(character)) { delimiters.push(character); if (delimiters.length > 28) return 'This answer is nested too deeply.'; run = 0; }
    else if (')]}'.includes(character)) {
      const opening = delimiters.pop();
      if (!opening || '([{'.indexOf(opening) !== ')]}'.indexOf(character)) return 'This answer has unbalanced delimiters.';
      run = 0;
    }
    else if (character === '\n' || character === ',') run = 0;
    else if (++run > 1200) return 'This answer contains an oversized expression.';
  }
  try {
    const closed = autoClose(source);
    if (closed.wasIncomplete && !isStreaming) return 'This program is incomplete.';
    const tokens = tokenize(closed.text);
    if (tokens.length > 12_000) return 'This answer has too many expressions.';
    const statements = split(tokens);
    if (statements.length > 256) return 'This answer has too many statements.';
    const expressions = new Map(statements.map((statement) => [requireIdentifier(statement.id, statement.id.startsWith('$')), parseExpression(statement.tokens)]));
    const allowed = new Set([...components, ...functions, ...builtinFunctions, ...localActions, 'Action']);
    const cache = new Map<string, { work: number; size: number }>();
    const visiting = new Set<string>();
    let visited = 0;
    function inspect(node: ASTNode, level = 0): { work: number; size: number } {
      if (level > 48 || ++visited > 24_000) throw new Error('This answer is too complex.');
      if (node.k === 'Str' && node.v.length > 16_000) throw new Error('A text block is too long.');
      if (node.k === 'Num' && !Number.isFinite(node.v)) throw new Error('A number is not finite.');
      if (node.k === 'Ref') {
        requireIdentifier(node.n);
        if (visiting.has(node.n)) throw new Error('This answer contains a circular reference.');
        const existing = cache.get(node.n);
        if (existing) return existing;
        const expression = expressions.get(node.n);
        if (!expression) return { work: 1, size: MAX_LIST };
        visiting.add(node.n);
        const result = inspect(expression, level + 1);
        visiting.delete(node.n);
        cache.set(node.n, result);
        return result;
      }
      if (node.k === 'StateRef') {
        requireIdentifier(node.n, true);
        return { work: 1, size: MAX_LIST };
      }
      let children: ASTNode[] = [];
      if (node.k === 'Arr') {
        if (node.els.length > MAX_LIST) throw new Error('A list exceeds 512 items.');
        children = node.els;
      } else if (node.k === 'Obj') {
        if (node.entries.length > 64 || node.entries.some(([key, value]) => {
          const markers = runtimeDataMarkers.get(key);
          return ['__proto__', 'constructor', 'prototype'].includes(key)
            || markers && (!['Str', 'Num', 'Bool', 'Null'].includes(value.k) || value.k === 'Str' && markers.has(value.v));
        })) throw new Error('This answer contains an unsupported object.');
        children = node.entries.map(([, value]) => value);
      } else if (node.k === 'Comp') {
        if (node.name === INTERNAL_ACTION_FUNCTION || !allowed.has(node.name)) throw new Error(`Unsupported component or function: ${node.name}.`);
        children = node.args;
      } else if (node.k === 'BinOp') children = [node.left, node.right];
      else if (node.k === 'UnaryOp') children = [node.operand];
      else if (node.k === 'Ternary') children = [node.cond, node.then, node.else];
      else if (node.k === 'Member') {
        if (['__proto__', 'constructor', 'prototype'].includes(node.field)) throw new Error('This answer contains an unsupported field.');
        children = [node.obj];
      } else if (node.k === 'Index') children = [node.obj, node.index];
      else if (node.k === 'Assign') throw new Error('Use @Set for local actions.');
      else if (node.k === 'RuntimeRef') throw new Error('Network and tool calls are unavailable.');
      const results = children.map((child) => inspect(child, level + 1));
      let work = 1 + results.reduce((total, child) => total + child.work, 0);
      let size = node.k === 'Arr' ? node.els.length : node.k === 'Member' || node.k === 'Index' || node.k === 'Ternary' ? Math.max(1, ...results.map((result) => result.size)) : 1;
      if (node.k === 'Comp') {
        if (node.name === 'Each') {
          const count = results[0]?.size ?? MAX_LIST;
          work += count * (results[2]?.work ?? 1);
          size = count;
        } else if (node.name === 'Range') {
          const [start, end, step] = node.args;
          size = start?.k === 'Num' && end?.k === 'Num' && (!step || step.k === 'Num') ? Math.max(0, Math.ceil((end.v - start.v) / (step?.v ?? 1))) : MAX_LIST;
          if (!Number.isFinite(size) || size > MAX_LIST) throw new Error('A range exceeds 512 items.');
        } else if (functions.includes(node.name) && !scalarFunctions.has(node.name) || ['Filter', 'Sort', 'First', 'Last', 'Default', 'Round', 'Floor', 'Ceil', 'Abs'].includes(node.name)) size = MAX_LIST;
      }
      if (work > MAX_WORK) throw new Error('This answer generates too much local work.');
      return { work, size };
    }
    let totalWork = 0;
    for (const [name, expression] of expressions) {
      if (name.startsWith('$')) {
        const literal = (node: ASTNode): boolean => ['Str', 'Num', 'Bool', 'Null'].includes(node.k) || node.k === 'Arr' && node.els.every(literal) || node.k === 'Obj' && node.entries.every(([, value]) => literal(value)) || node.k === 'UnaryOp' && node.op === '-' && node.operand.k === 'Num';
        if (!literal(expression)) return 'State defaults must be literal values.';
      }
      totalWork += inspect(expression).work;
      if (totalWork > 24_000) return 'This program generates too much local work.';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'This answer could not be parsed.';
  }
}

export function normalizeProgram(source: string): string {
  function serialize(node: ASTNode): string {
    switch (node.k) {
      case 'Str': return JSON.stringify(node.v);
      case 'Num': return String(node.v);
      case 'Bool': return String(node.v);
      case 'Null': return 'null';
      case 'Ref':
      case 'Ph': return requireIdentifier(node.n);
      case 'StateRef': return requireIdentifier(node.n, true);
      case 'Arr': return `[${node.els.map(serialize).join(',')}]`;
      case 'Obj': return `{${node.entries.map(([key, value]) => `${JSON.stringify(key)}:${serialize(value)}`).join(',')}}`;
      case 'Comp': {
        requireIdentifier(node.name);
        if (node.name === INTERNAL_ACTION_FUNCTION) throw new Error('Unsupported function.');
        const args = node.args.map(serialize);
        if (node.name === 'Set' && args[1]) args[1] = `@BoundedValue(${args[1]})`;
        const call = `${node.fn || builtinFunctions.includes(node.name) || localActions.includes(node.name) ? '@' : ''}${node.name}(${args.join(',')})`;
        return localActions.includes(node.name) ? `@${INTERNAL_ACTION_FUNCTION}(${call})` : call;
      }
      case 'BinOp': return node.op === '+' ? `@BoundedAdd(${serialize(node.left)},${serialize(node.right)})` : `(${serialize(node.left)} ${node.op} ${serialize(node.right)})`;
      case 'UnaryOp': return `(${node.op}${serialize(node.operand)})`;
      case 'Ternary': return `(${serialize(node.cond)} ? ${serialize(node.then)} : ${serialize(node.else)})`;
      case 'Member': return `${serialize(node.obj)}.${JSON.stringify(node.field)}`;
      case 'Index': return `${serialize(node.obj)}[${serialize(node.index)}]`;
      case 'Assign':
      case 'RuntimeRef': throw new Error('Unsupported expression.');
    }
  }
  return split(tokenize(autoClose(source).text)).map((statement) => `${requireIdentifier(statement.id, statement.id.startsWith('$'))} = ${serialize(parseExpression(statement.tokens))}`).join('\n');
}

interface SavedState { value: Record<string, unknown>; size: number }
const savedStates = new Map<string, SavedState>();
const STORAGE_KEY = 'fate:intelligent-ui:state:v1';
let savedSize = 0;
let hydrated = false;
let persistenceTimer: ReturnType<typeof setTimeout> | undefined;

function safeState(value: unknown, omitUndefined = false, depth = 0, budget = { left: 12_000, text: 32_000 }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 16_000 && (budget.text -= value.length) >= 0;
  if (Array.isArray(value)) return value.length <= 512 && value.every((item) => safeState(item, omitUndefined, depth + 1, budget));
  return Boolean(value && typeof value === 'object' && !isRuntimeData(value) && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && (budget.text -= key.length) >= 0 && (omitUndefined && item === undefined || safeState(item, omitUndefined, depth + 1, budget))));
}

function trimState(): void {
  while (savedStates.size > 64 || savedSize > 512_000) {
    const first = savedStates.entries().next().value;
    if (!first) break;
    savedSize -= first[1].size;
    savedStates.delete(first[0]);
  }
}

function persistState(): void {
  if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...savedStates].map(([key, saved]) => [key, saved.value])));
  } catch {
    return;
  }
}

function hydrateState(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (serialized && serialized.length <= 550_000) {
      const entries: unknown = JSON.parse(serialized);
      if (Array.isArray(entries) && entries.length <= 64) for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length > 2048 || !entry[1] || Array.isArray(entry[1]) || typeof entry[1] !== 'object' || !safeState(entry[1])) continue;
        const size = JSON.stringify(entry[1]).length;
        if (size > 32_000) continue;
        const previous = savedStates.get(entry[0]);
        if (previous) savedSize -= previous.size;
        savedStates.set(entry[0], { value: entry[1] as Record<string, unknown>, size });
        savedSize += size;
      }
      trimState();
    }
  } catch {
    return;
  } finally {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (persistenceTimer !== undefined) persistState(); });
  }
}

export function restoreAnswerState(key: string | undefined): Record<string, unknown> | undefined {
  if (!key) return undefined;
  hydrateState();
  const saved = savedStates.get(key);
  if (!saved) return undefined;
  savedStates.delete(key);
  savedStates.set(key, saved);
  return saved.value;
}

export function saveAnswerState(key: string | undefined, value: Record<string, unknown>): void {
  if (!key || key.length > 2048 || !safeState(value, true)) return;
  hydrateState();
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 32_000) return;
    const normalized = JSON.parse(serialized) as Record<string, unknown>;
    if (!safeState(normalized)) return;
    const previous = savedStates.get(key);
    if (previous) savedSize -= previous.size;
    savedStates.delete(key);
    savedStates.set(key, { value: normalized, size: serialized.length });
    savedSize += serialized.length;
    trimState();
    if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(persistState, 180);
  } catch {
    return;
  }
}
