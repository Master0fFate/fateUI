import { spawn } from 'node:child_process';
import type { ExtensionContext, InlineExtension, ToolCallEventResult, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import type { HookDefinition, HookEvent } from '../../../shared/contracts/hooks';
import type { PermissionLevel } from '../../../shared/contracts/ipc';

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STOP_CONTINUATIONS = 5;
const MAX_LAST_MESSAGE_CHARS = 8_000;
const BLOCK_EXIT_CODE = 2;
const KILL_GRACE_MS = 2_000;

export interface HookPayload {
  event: HookEvent;
  sessionId: string | null;
  projectDir: string;
  permissionLevel: PermissionLevel | null;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolResult?: string;
  toolIsError?: boolean;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
}

export interface HookOutcome {
  hook: HookDefinition;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function collect(limit: number): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk) {
      if (bytes >= limit) return;
      const slice = chunk.subarray(0, limit - bytes);
      chunks.push(slice);
      bytes += slice.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8').trim(),
  };
}

export function runHook(hook: HookDefinition, payload: HookPayload, cwd: string): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FATE_PROJECT_DIR: cwd, FATE_HOOK_EVENT: payload.event, ...(payload.toolName ? { FATE_TOOL_NAME: payload.toolName } : {}) },
    });
    const stdout = collect(MAX_OUTPUT_BYTES);
    const stderr = collect(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hook, code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    };
    const kill = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      else {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, hook.timeoutSeconds * 1000);
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    child.on('error', (error) => { stderr.push(Buffer.from(error.message)); finish(null); });
    child.on('close', finish);
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

export interface FateHooksExtensionDeps {
  hooks: readonly HookDefinition[];
  projectRoot: string;
  resolvePermissionLevel: () => PermissionLevel | null;
}

function matches(hook: HookDefinition, toolName: string): boolean {
  return !hook.matcher || new RegExp(hook.matcher).test(toolName);
}

function describe(outcome: HookOutcome): string {
  const output = outcome.stderr || outcome.stdout;
  return outcome.timedOut ? `${outcome.hook.name} timed out after ${outcome.hook.timeoutSeconds}s` : `${outcome.hook.name}: ${output || `exit code ${outcome.code}`}`;
}

export function createFateHooksExtension(deps: FateHooksExtensionDeps): InlineExtension | null {
  const byEvent = new Map<HookEvent, HookDefinition[]>();
  for (const hook of deps.hooks) {
    if (!hook.enabled) continue;
    const list = byEvent.get(hook.event);
    if (list) list.push(hook);
    else byEvent.set(hook.event, [hook]);
  }
  if (byEvent.size === 0) return null;
  return {
    name: 'fate-hooks',
    hidden: true,
    factory(pi) {
      let continuations = 0;
      let sessionContext: string | null = null;
      const base = (sessionId: string | null, event: HookEvent): HookPayload => ({ event, sessionId, projectDir: deps.projectRoot, permissionLevel: deps.resolvePermissionLevel() });
      const run = (hooks: readonly HookDefinition[], payload: HookPayload) => Promise.all(hooks.map((hook) => runHook(hook, payload, deps.projectRoot)));
      const report = (outcomes: readonly HookOutcome[], ctx: ExtensionContext) => {
        for (const outcome of outcomes) {
          if (outcome.code !== 0 && outcome.code !== BLOCK_EXIT_CODE) ctx.ui.notify(`Hook ${describe(outcome)}`, 'warning');
        }
      };
      const sessionStart = byEvent.get('SessionStart');
      if (sessionStart) {
        pi.on('session_start', async (_event, ctx) => {
          const outcomes = await run(sessionStart, base(ctx.sessionManager.getSessionId(), 'SessionStart'));
          report(outcomes, ctx);
          const context = outcomes.filter((outcome) => outcome.code === 0 && outcome.stdout).map((outcome) => outcome.stdout).join('\n\n');
          sessionContext = context || null;
        });
        pi.on('before_agent_start', () => {
          if (!sessionContext) return undefined;
          const content = sessionContext;
          sessionContext = null;
          return { message: { customType: 'fate-hook-context', content, display: true } };
        });
      }
      const preToolUse = byEvent.get('PreToolUse');
      if (preToolUse) {
        pi.on('tool_call', async (event, ctx): Promise<ToolCallEventResult | undefined> => {
          const hooks = preToolUse.filter((hook) => matches(hook, event.toolName));
          if (hooks.length === 0) return undefined;
          const outcomes = await run(hooks, { ...base(ctx.sessionManager.getSessionId(), 'PreToolUse'), toolName: event.toolName, toolCallId: event.toolCallId, toolInput: event.input });
          report(outcomes, ctx);
          const blocked = outcomes.find((outcome) => outcome.code === BLOCK_EXIT_CODE);
          return blocked ? { block: true, reason: `Hook ${describe(blocked)}` } : undefined;
        });
      }
      const postToolUse = byEvent.get('PostToolUse');
      if (postToolUse) {
        pi.on('tool_result', async (event, ctx): Promise<ToolResultEventResult | undefined> => {
          const hooks = postToolUse.filter((hook) => matches(hook, event.toolName));
          if (hooks.length === 0) return undefined;
          const toolResult = event.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').slice(0, MAX_OUTPUT_BYTES);
          const outcomes = await run(hooks, { ...base(ctx.sessionManager.getSessionId(), 'PostToolUse'), toolName: event.toolName, toolCallId: event.toolCallId, toolInput: event.input, toolResult, toolIsError: event.isError });
          report(outcomes, ctx);
          const feedback = outcomes.filter((outcome) => outcome.code === BLOCK_EXIT_CODE).map((outcome) => `[hook ${describe(outcome)}]`);
          if (feedback.length === 0) return undefined;
          return {
            content: [...event.content, { type: 'text', text: feedback.join('\n') }],
            ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
          };
        });
      }
      const stop = byEvent.get('Stop');
      if (stop) {
        pi.on('input', (event) => { if (event.source !== 'extension') continuations = 0; });
        pi.on('agent_end', async (event, ctx) => {
          const last = [...event.messages].reverse().find((message) => message.role === 'assistant');
          const lastAssistantMessage = last && Array.isArray(last.content)
            ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').slice(0, MAX_LAST_MESSAGE_CHARS)
            : undefined;
          const outcomes = await run(stop, { ...base(ctx.sessionManager.getSessionId(), 'Stop'), ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}), stopHookActive: continuations > 0 });
          report(outcomes, ctx);
          const feedback = outcomes.filter((outcome) => outcome.code === BLOCK_EXIT_CODE).map((outcome) => outcome.stderr || outcome.stdout).filter(Boolean);
          if (feedback.length === 0 || continuations >= MAX_STOP_CONTINUATIONS) return;
          continuations += 1;
          pi.sendUserMessage(feedback.join('\n\n'), { deliverAs: 'followUp' });
        });
      }
    },
  };
}
