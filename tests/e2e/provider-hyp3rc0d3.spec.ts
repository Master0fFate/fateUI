import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeOrExplain } from './closeOrExplain';

test.use({ trace: 'off', screenshot: 'off' });

const READY = { timeout: 45_000 };
const PROVIDER = 'fate-e2e-synthetic';
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type BrowserAttempt = { hostname: string; hostId: string | null; callbackPort: number };
type GuardedGlobal = typeof globalThis & { fateE2eBrowserAttempts: BrowserAttempt[] };
type RequestRecord = { model: string; reasoning: string | undefined; hyp3rc0d3: boolean; child: boolean; reply: string; tool: string | undefined;
  tag?: string; args?: Record<string, unknown>; tools?: string[]; results?: { tool: string; error: boolean; text: string; details?: unknown }[] };
type SyntheticGlobal = typeof globalThis & { fateE2eSynthetic?: { held: Map<string, () => void>; released: Set<string>; releasedAll: boolean } };
type PromptTraceGlobal = typeof globalThis & { fateE2ePromptTrace: Record<string, unknown>[] };
const pageApplications = new WeakMap<Page, ElectronApplication>();

async function projectFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const data = path.join(root, 'data');
  const agent = path.join(root, 'agent');
  await Promise.all([mkdir(data, { mode: 0o700 }), mkdir(agent), mkdir(path.join(root, 'project'))]);
  const project = await realpath(path.join(root, 'project'));
  execFileSync('git', ['init', '-q', project]);
  await writeFile(path.join(data, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [project] }));
  return { root, data, agent, project };
}

async function launchProduction(fixture: Awaited<ReturnType<typeof projectFixture>>) {
  const application = await electron.launch({
    args: [`--user-data-dir=${path.join(fixture.root, 'chromium')}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', path.resolve('.'), '--new-instance'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: fixture.data,
      PI_CODING_AGENT_DIR: fixture.agent, PI_OFFLINE: '1', FATE_STATE_PERSISTENCE: 'legacy-json', PI_OAUTH_CALLBACK_HOST: '127.0.0.1' },
  });
  try {
    await application.evaluate(({ shell, session }) => {
      const state = globalThis as GuardedGlobal;
      state.fateE2eBrowserAttempts = [];
      shell.openExternal = async (value) => {
        const url = new URL(value);
        const redirect = url.searchParams.get('redirect_uri');
        state.fateE2eBrowserAttempts.push({ hostname: url.hostname, hostId: url.searchParams.get('ext_agent_host_id'),
          callbackPort: redirect ? Number(new URL(redirect).port) : 0 });
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.protocol === 'http:' || url.protocol === 'https:') return Promise.reject(new Error('External network is disabled in this production E2E.'));
        return originalFetch(input, init);
      };
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    });
    const page = await application.firstWindow();
    await page.route(/^https?:\/\//u, (route) => route.abort('blockedbyclient'));
    await expect(page.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
    await application.evaluate(({ ipcMain }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
      const handler = handlers?.get('runtime:prompt');
      if (!(handlers instanceof Map) || typeof handler !== 'function') throw new Error('runtime:prompt invoke handler unavailable for diagnostics');
      const trace: Record<string, unknown>[] = [];
      (globalThis as PromptTraceGlobal).fateE2ePromptTrace = trace;
      const record = (entry: Record<string, unknown>) => { trace.push(entry); if (trace.length > 20) trace.shift(); };
      handlers.set('runtime:prompt', function (this: unknown, event, ...args) {
        const input = args[0] as { text?: unknown } | undefined;
        record({ type: 'entry', textLength: typeof input?.text === 'string' ? input.text.length : null });
        const returned = (value: unknown) => {
          const result = value as { ok?: boolean; value?: { accepted?: boolean; disposition?: string }; accepted?: boolean; disposition?: string; error?: { message?: string } } | null;
          const data = result?.value ?? result;
          record({ type: 'return', accepted: data?.accepted, disposition: data?.disposition, error: result?.error?.message?.slice(0, 500) });
          return value;
        };
        const rejected = (error: unknown) => {
          record({ type: 'reject', error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
          throw error;
        };
        try {
          const result = handler.call(this, event, ...args);
          return result instanceof Promise ? result.then(returned, rejected) : returned(result);
        } catch (error) { return rejected(error); }
      });
    });
    pageApplications.set(page, application);
    await page.evaluate((project) => window.piDesktop.openProject(project), fixture.project);
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.project?.path)), READY).toBe(fixture.project);
    return { application, page };
  } catch (error) {
    await closeOrExplain(application);
    throw error;
  }
}

async function browserAttempts(application: ElectronApplication): Promise<BrowserAttempt[]> {
  return application.evaluate(() => (globalThis as GuardedGlobal).fateE2eBrowserAttempts);
}

async function callbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function startOpenAiLogin(page: Page) {
  const composer = page.getByRole('textbox', { name: 'Message Pi', exact: true });
  await expect(composer).toBeEnabled(READY);
  await composer.fill('/login');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const dialog = page.locator('.provider-dialog-content');
  await expect(dialog).toBeVisible(READY);
  await dialog.getByRole('textbox', { name: 'Search providers', exact: true }).fill('openai');
  const providerName = await page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.providerLogin?.providers.find((provider) => provider.id === 'openai')?.name));
  expect(providerName).toBeTruthy();
  await dialog.getByRole('option').filter({ has: page.getByText(providerName!, { exact: true }) }).click();
  await expect(dialog.locator('.provider-dialog-detail-head small')).toHaveText(/^openai ·/u);
  await dialog.getByRole('button', { name: /Sign in in browser/u }).click();
  return dialog;
}

test('production OpenAI OAuth opens the browser safely and keeps its installation ID through cancellation and restart', async () => {
  test.setTimeout(180_000);
  const fixture = await projectFixture('fate-provider-oauth-e2e-');
  let application: ElectronApplication | undefined;
  try {
    let launched = await launchProduction(fixture);
    application = launched.application;
    let expectedHostId: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dialog = await startOpenAiLogin(launched.page);
      const expectedAttempts = attempt === 2 ? 1 : attempt + 1;
      await expect.poll(async () => (await browserAttempts(application!)).length, READY).toBe(expectedAttempts);
      const browser = (await browserAttempts(application)).at(-1)!;
      expect(browser.hostname).toBe('auth.openai.com');
      expect(browser.hostId).toMatch(UUID);
      expect(browser.callbackPort).toBe(1455);
      expectedHostId ??= browser.hostId;
      expect(browser.hostId).toBe(expectedHostId);
      await expect(dialog.getByText('Paste sign-in code', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
      await expect.poll(() => launched.page.evaluate(async () => {
        const login = (await window.piDesktop.getRuntimeState()).providerLogin;
        return { providerId: login?.providerId, status: login?.status, prompt: login?.prompt?.type };
      }), READY).toEqual({ providerId: 'openai', status: 'working', prompt: 'manual_code' });
      await dialog.getByText('Paste sign-in code', { exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: 'Code or URL', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Submit code', exact: true })).toBeDisabled();
      await expect(dialog.locator('.provider-dialog-working')).toBeVisible();
      const cancel = dialog.getByRole('button', { name: attempt === 0 ? 'Cancel' : 'Close', exact: true });
      await expect(cancel).toBeInViewport({ ratio: 1 });
      await cancel.click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => launched.page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.providerLogin?.status)), READY).toBe('idle');
      await expect.poll(() => callbackPortAvailable(browser.callbackPort), READY).toBe(true);
      if (attempt === 1) {
        await closeOrExplain(application);
        application = undefined;
        launched = await launchProduction(fixture);
        application = launched.application;
      }
    }
  } finally {
    try { await closeOrExplain(application); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

async function installSyntheticProvider(agent: string, recordsPath: string): Promise<void> {
  await mkdir(path.join(agent, 'extensions'));
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: 'plain',
    defaultThinkingLevel: 'off', enabledModels: [`${PROVIDER}/*`], compaction: { enabled: false } }));
  await writeFile(path.join(agent, 'extensions', 'synthetic-provider.ts'), `
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';

const text = (message) => typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const control = globalThis.fateE2eSynthetic ??= { held: new Map(), released: new Set(), releasedAll: false };

export default function (pi) {
  pi.registerProvider(${JSON.stringify(PROVIDER)}, {
    name: 'Isolated E2E', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-e2e-not-a-secret', api: 'fate-e2e-stream',
    models: ['reasoning', 'plain'].map((id) => ({ id, name: 'E2E ' + id, reasoning: id === 'reasoning', input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 32768 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: [], stopReason: 'pending', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          const system = getCurrentSystemPrompt(context.messages);
          const child = system.includes('This is an isolated Fate UI child Pi session');
          const title = system.includes('Create a concise sidebar title') || context.systemPrompt?.includes('Create a concise sidebar title');
          const user = text(context.messages.filter((item) => item.role === 'user').at(-1) ?? { content: '' });
          const toolResults = context.messages.filter((item) => item.role === 'toolResult');
          let tool;
          let args;
          let tag;
          let hold;
          let failure;
          const tools = getCurrentTools(context.messages).map((item) => item.name);
          const lastUserIndex = context.messages.findLastIndex((item) => item.role === 'user');
          const turnResults = context.messages.slice(lastUserIndex + 1).filter((item) => item.role === 'toolResult');
          const task = child ? context.messages.filter((item) => item.role === 'user').map(text).find((value) => value.includes('e2e:child:')) : undefined;
          const childCommand = task?.match(/e2e:child:([a-z-]+):([a-z0-9-]+)/);
          const startCommand = !child && user.match(/^e2e:start:([a-z0-9-]+)\\n([\\s\\S]+)$/);
          const resultsCommand = !child && user.match(/^e2e:results:([a-z0-9-]+)\\n([\\s\\S]+)$/);
          let reply = title ? 'E2E session' : child ? 'child-complete-sentinel' : 'reply:' + user;
          if (!title && childCommand) {
            const [, action, name] = childCommand;
            tag = action + ':' + name;
            if (action === 'hold') { hold = name; reply = 'held-complete:' + name; }
            if (action === 'large') { hold = name; reply = 'L'.repeat(70000) + ':large-result-tail'; }
            if (action === 'error') { hold = name; failure = 'E'.repeat(7000) + ':large-error-tail'; }
            if (action === 'empty') { hold = name; reply = ''; }
            if (action === 'write') {
              if (!toolResults.some((item) => item.toolName === 'write')) {
                tool = 'write'; args = { path: 'inherited-permission.txt', content: 'inherited-write-sentinel' };
              } else {
                if (toolResults.find((item) => item.toolName === 'write').isError) throw new Error('Inherited write failed');
                reply = 'write-complete-sentinel';
              }
            }
            if (action === 'delegate') {
              const spawned = toolResults.find((item) => item.toolName === 'spawn_agent');
              const scopeCheck = toolResults.find((item) => item.toolName === 'wait_agent');
              if (!scopeCheck) {
                tool = 'wait_agent'; args = { targets: ['/root'], timeoutSeconds: 0 };
              } else if (!scopeCheck.isError) throw new Error('A descendant was allowed to wait on the root');
              else if (!spawned) {
                tool = 'spawn_agent'; args = { task: name === 'parent' ? 'e2e:child:delegate:middle' : 'e2e:child:hold:leaf',
                  name: name === 'parent' ? 'middle' : 'leaf', permission: 'read-only', tools: [], skillMode: 'none',
                  workspace: { mode: 'shared' }, model: { provider: model.provider, id: model.id } };
              } else {
                if (spawned.isError) throw new Error('Descendant spawn failed: ' + text(spawned));
                const evidence = context.messages.filter((item) => item.role === 'user' || item.role === 'toolResult').map(text).join('\\n');
                reply = evidence.includes('held-complete:leaf') ? name + '-synthesis:held-complete:leaf' : 'awaiting-descendants:' + name;
              }
            }
          } else if (!title && (startCommand || resultsCommand)) {
            const command = startCommand ?? resultsCommand;
            tag = command[1];
            const completed = turnResults.find((item) => item.toolName === 'agent_workflow');
            if (completed) reply = (startCommand ? 'e2e-started:' : 'e2e-results:') + tag;
            else if (!tools.includes('agent_workflow')) {
              if (turnResults.some((item) => item.toolName === 'tool_search')) throw new Error('Workflow discovery failed');
              tool = 'tool_search'; args = { query: 'agent_workflow', limit: 1 };
            } else { tool = 'agent_workflow'; args = JSON.parse(command[2]); }
          } else if (!title && !child && !user.includes('child-complete-sentinel') && /Subagent workflow (\\S+) settled as/.test(user)) {
            tag = 'notification';
            reply = 'e2e-notified:' + user.match(/Subagent workflow (\\S+) settled as/)[1];
          } else if (!title && !child && user === 'run bounded workflow') {
            if (!toolResults.some((item) => item.toolName === 'agent_workflow')) {
              if (!getCurrentTools(context.messages).some((item) => item.name === 'agent_workflow')) {
                if (toolResults.some((item) => item.toolName === 'tool_search')) throw new Error('Workflow discovery did not expose agent_workflow');
                tool = 'tool_search'; args = { query: 'agent_workflow', limit: 1 };
              } else {
                tool = 'agent_workflow';
                args = { action: 'start', maxConcurrency: 1, nodes: [{ id: 'check', task: 'Return child-complete-sentinel without using tools.',
                  role: 'worker', permission: 'read-only', tools: [], skillMode: 'none', notifyParent: 'never', workspace: { mode: 'shared' }, model: { provider: model.provider, id: model.id } }] };
              }
            } else reply = 'workflow-started-sentinel';
          } else if (!title && !child && user.includes('child-complete-sentinel')) reply = 'workflow-notification-received-sentinel';
          await options?.onPayload?.({ model: model.id, synthetic: true }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          if (!title) appendFileSync(${JSON.stringify(recordsPath)}, JSON.stringify({ model: model.id, reasoning: options?.reasoning,
            hyp3rc0d3: system.includes('Hyp3rc0d3 mode is on for this session.'), child, reply, tool, tag, args, tools,
            results: turnResults.map((item) => ({ tool: item.toolName, error: Boolean(item.isError), text: text(item), details: item.details })) }) + '\\n');
          if (hold && !control.releasedAll && !control.released.has(hold)) await new Promise((resolve, reject) => {
            const abort = () => { control.held.delete(hold); reject(new Error('Held synthetic request aborted')); };
            if (options?.signal?.aborted) { abort(); return; }
            options?.signal?.addEventListener('abort', abort, { once: true });
            control.held.set(hold, () => { options?.signal?.removeEventListener('abort', abort); control.held.delete(hold); resolve(); });
          });
          if (failure) throw new Error(failure);
          if (options?.signal?.aborted) throw new Error('Synthetic request aborted');
          await options?.onProviderStreamEvent?.({ type: 'synthetic' }, model);
          stream.push({ type: 'start', partial: message });
          if (tool) {
            const block = { type: 'toolCall', id: randomUUID(), name: tool, arguments: {} };
            message.content.push(block);
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            block.arguments = args;
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
          } else {
            const block = { type: 'text', text: '' };
            message.content.push(block);
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            block.text = reply;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: reply, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: reply, partial: message });
          }
          message.stopReason = tool ? 'toolUse' : 'stop';
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
`);
}

async function sendMessage(page: Page, value: string, reply: string): Promise<void> {
  const application = pageApplications.get(page);
  if (!application) throw new Error('Electron application unavailable for send diagnostics');
  const nativeState = () => application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { appActive: process.platform === 'darwin' ? app.isActive() : null,
      windowFocused: window?.isFocused() ?? null, webContentsFocused: window?.webContents.isFocused() ?? null };
  });
  const before = await nativeState();
  await page.evaluate(() => {
    const state = window as typeof window & { fateE2eComposerTrace?: Record<string, unknown>[]; fateE2eComposerCleanup?: () => void };
    const trace: Record<string, unknown>[] = [];
    const push = trace.push.bind(trace);
    trace.push = (...entries) => { const length = push(...entries); if (trace.length > 100) trace.splice(0, trace.length - 100); return length; };
    state.fateE2eComposerTrace = trace;
    const describe = (target: EventTarget | null) => target instanceof Element
      ? { tag: target.tagName, id: target.id.slice(0, 100), class: String(target.className).slice(0, 200), label: target.getAttribute('aria-label')?.slice(0, 100) } : null;
    const snapshot = () => {
      const button = document.querySelector<HTMLButtonElement>('.send-button');
      return { focused: document.hasFocus(), active: describe(document.activeElement),
        error: document.querySelector('.composer-error')?.textContent?.slice(0, 500),
        button: button ? { disabled: button.disabled, label: button.getAttribute('aria-label'), mode: button.dataset.mode } : null };
    };
    trace.push({ type: 'before', ...snapshot() });
    const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'submit', 'invalid'];
    const listener = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.composer')) return;
      const entry = { type: event.type, trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
        target: describe(event.target), submitter: event instanceof SubmitEvent ? describe(event.submitter) : null };
      trace.push(entry);
      queueMicrotask(() => { entry.defaultPrevented = event.defaultPrevented; });
    };
    for (const type of types) document.addEventListener(type, listener, true);
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => {
        const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return element?.closest('.composer') || [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
          node instanceof Element && (node.matches('.composer-error, .send-button') || node.querySelector('.composer-error, .send-button')));
      })) trace.push({ type: 'mutation', ...snapshot() });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true,
      attributeFilter: ['disabled', 'aria-label', 'data-mode', 'class'] });
    state.fateE2eComposerCleanup = () => {
      trace.push({ type: 'after', ...snapshot() });
      observer.disconnect();
      for (const type of types) document.removeEventListener(type, listener, true);
      delete state.fateE2eComposerCleanup;
    };
  });
  try {
    const composer = page.getByRole('textbox', { name: 'Message Pi', exact: true });
    await composer.fill(value);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(composer).toHaveValue('');
    await page.evaluate(() => (window as typeof window & { fateE2eComposerCleanup?: () => void }).fateE2eComposerCleanup?.());
    await expect.poll(() => page.evaluate(async (expected) => {
      const state = await window.piDesktop.getRuntimeState();
      return state.messages.some((message) => message.role === 'assistant' && message.text === expected);
    }, reply), READY).toBe(true);
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.activeSessionRunning ?? state.streaming)), READY).toBe(false);
    const scrollbar = page.getByRole('scrollbar', { name: 'Conversation scroll position' });
    if (await scrollbar.isVisible()) await scrollbar.press('End');
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
  } catch (error) {
    await page.evaluate(() => (window as typeof window & { fateE2eComposerCleanup?: () => void }).fateE2eComposerCleanup?.()).catch(() => {});
    const state = await page.evaluate(async () => {
      const runtime = await window.piDesktop.getRuntimeState();
      const button = document.querySelector<HTMLButtonElement>('.send-button');
      return { status: runtime.status, error: runtime.error, streaming: runtime.streaming, activeSessionRunning: runtime.activeSessionRunning,
        model: runtime.model, messages: runtime.messages.slice(-2).map((message) => ({ role: message.role, text: message.text.slice(0, 500) })),
        composerError: document.querySelector('.composer-error')?.textContent?.slice(0, 500),
        sendButton: button ? { disabled: button.disabled, label: button.getAttribute('aria-label'), mode: button.dataset.mode } : null };
    }).catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
    const after = await nativeState().catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
    const trace = await page.evaluate(() => (window as typeof window & { fateE2eComposerTrace?: Record<string, unknown>[] }).fateE2eComposerTrace)
      .catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
    const promptTrace = await application.evaluate(() => (globalThis as PromptTraceGlobal).fateE2ePromptTrace)
      .catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nComposer send state: ${JSON.stringify(state)}\nSend diagnostics: ${JSON.stringify({ before, after, trace, promptTrace })}`, { cause: error });
  } finally {
    await page.evaluate(() => (window as typeof window & { fateE2eComposerCleanup?: () => void }).fateE2eComposerCleanup?.()).catch(() => {});
  }
}

async function toggleHyp3rc0d3(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Model and reasoning settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Model settings', exact: true });
  await settings.getByRole('button', { name: `Hyp3rc0d3 ${enabled ? 'off' : 'on'}`, exact: true }).click();
  await expect(settings.getByRole('button', { name: `Hyp3rc0d3 ${enabled ? 'on' : 'off'}`, exact: true })).toHaveAttribute('aria-pressed', String(enabled));
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

async function requestRecords(recordsPath: string): Promise<RequestRecord[]> {
  const contents = await readFile(recordsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function releaseStreams(application: ElectronApplication | undefined, names?: string[]): Promise<void> {
  if (!application) return;
  await application.evaluate((_electron, selected) => {
    const control = (globalThis as SyntheticGlobal).fateE2eSynthetic;
    if (!control) return;
    if (!selected) control.releasedAll = true;
    for (const name of selected ?? [...control.held.keys()]) {
      control.released.add(name);
      control.held.get(name)?.();
    }
  }, names);
}

async function closeSynthetic(application: ElectronApplication | undefined, root: string): Promise<void> {
  try { await releaseStreams(application); }
  finally {
    try { await closeOrExplain(application); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function readySynthetic(page: Page, model = 'plain'): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.status)), READY).toBe('ready');
  await page.evaluate(async ({ provider, id }) => {
    await window.piDesktop.setModel(provider, id);
    await window.piDesktop.setPermissionLevel('full-access');
    await window.piDesktop.setHyp3rc0d3(true);
  }, { provider: PROVIDER, id: model });
}

function workflowNode(id: string, task: string, permission: 'read-only' | 'inherit' = 'read-only', tools: string[] = []) {
  return { id, task, role: 'worker', ...(permission === 'inherit' ? {} : { permission }), tools, skillMode: 'none', notifyParent: 'never',
    workspace: { mode: 'shared' }, model: { provider: PROVIDER, id: 'plain' } };
}

async function startWorkflow(page: Page, tag: string, nodes: ReturnType<typeof workflowNode>[], maxConcurrency: number) {
  await sendMessage(page, `e2e:start:${tag}\n${JSON.stringify({ action: 'start', nodes, maxConcurrency })}`, `e2e-started:${tag}`);
  const workflow = (await page.evaluate(() => window.piDesktop.getRuntimeState())).subagentWorkflows?.at(-1);
  expect(workflow).toBeDefined();
  expect(workflow!.nodes.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
  return workflow!;
}

type RetainedResults = { workflowId: string; status: string; notificationDeliveryErrors: unknown[]; nodes: {
  id: string; status: string; runId: string | null; result: string | null; error: string | null; resultLength: number | null; errorLength: number | null;
  resultRange: { offset: number; length: number; nextOffset: number | null } | null;
  errorRange: { offset: number; length: number; nextOffset: number | null } | null;
}[] };

async function retrieveResults(page: Page, recordsPath: string, tag: string, input: Record<string, unknown>) {
  await sendMessage(page, `e2e:results:${tag}\n${JSON.stringify(input)}`, `e2e-results:${tag}`);
  const record = (await requestRecords(recordsPath)).filter((item) => item.tag === tag && !item.tool).at(-1);
  const result = record?.results?.find((item) => item.tool === 'agent_workflow');
  expect(result).toBeDefined();
  return result!;
}

async function completedWorkflow(page: Page, workflowId: string, status = 'completed'): Promise<void> {
  await expect.poll(() => page.evaluate(async (id) => (await window.piDesktop.getRuntimeState()).subagentWorkflows?.find((item) => item.id === id)?.status, workflowId), READY).toBe(status);
  await expect.poll(() => page.evaluate(async (reply) => (await window.piDesktop.getRuntimeState()).messages.filter((item) => item.role === 'assistant' && item.text === reply).length, `e2e-notified:${workflowId}`), READY).toBe(1);
  await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.activeSessionRunning ?? state.streaming)), READY).toBe(false);
}

test('production plain-model Hypercode persists cold session mode and accepts both keyword aliases without forcing effort', async () => {
  test.setTimeout(240_000);
  const fixture = await projectFixture('fate-hypercode-mode-e2e-');
  const recordsPath = path.join(fixture.root, 'requests.jsonl');
  let application: ElectronApplication | undefined;
  try {
    await installSyntheticProvider(fixture.agent, recordsPath);
    let launched = await launchProduction(fixture);
    application = launched.application;
    let page = launched.page;
    await readySynthetic(page);
    const saved = await page.evaluate(() => window.piDesktop.getRuntimeState());
    expect(saved.sessionId).toBeTruthy();
    expect(saved.sessionFile).toBeTruthy();
    expect(saved.messages).toEqual([]);
    const initialJsonl = await readFile(saved.sessionFile!, 'utf8');
    const entries = initialJsonl.trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.type === 'message')).toEqual([]);
    expect(entries.filter((entry) => entry.customType === 'fate-hyp3rc0d3').at(-1)).toMatchObject({ type: 'custom', data: { version: 1, enabled: true } });
    await page.evaluate(async () => { await window.piDesktop.getRuntimeState(); await window.piDesktop.listSessions(); await window.piDesktop.getRuntimeState(); });
    expect(await readFile(saved.sessionFile!, 'utf8')).toBe(initialJsonl);
    const independent = await page.evaluate(() => window.piDesktop.newSession());
    expect(independent.hyp3rc0d3).toBe(false);
    expect(independent.sessionId).not.toBe(saved.sessionId);
    expect(await readFile(saved.sessionFile!, 'utf8')).toBe(initialJsonl);
    const cold = await page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!);
    expect(cold.hyp3rc0d3).toBe(true);
    await closeOrExplain(application);
    application = undefined;
    launched = await launchProduction(fixture);
    application = launched.application;
    page = launched.page;
    expect((await page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!)).hyp3rc0d3).toBe(true);
    expect(await readFile(saved.sessionFile!, 'utf8')).toBe(initialJsonl);
    await toggleHyp3rc0d3(page, false);
    expect(await requestRecords(recordsPath)).toEqual([]);
    const offJsonl = await readFile(saved.sessionFile!, 'utf8');
    expect(JSON.parse(offJsonl.trim().split('\n').at(-1)!)).toMatchObject({ customType: 'fate-hyp3rc0d3', data: { enabled: false } });
    await closeOrExplain(application);
    application = undefined;
    launched = await launchProduction(fixture);
    application = launched.application;
    page = launched.page;
    expect((await page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!)).hyp3rc0d3).toBe(false);
    expect(await requestRecords(recordsPath)).toEqual([]);
    await page.evaluate((provider) => window.piDesktop.setModel(provider, 'plain'), PROVIDER);
    await toggleHyp3rc0d3(page, true);
    const effort = (await page.evaluate(() => window.piDesktop.getRuntimeState())).thinkingLevel;
    await sendMessage(page, 'plain model greeting', 'reply:plain model greeting');
    expect((await page.evaluate(() => window.piDesktop.getRuntimeState())).thinkingLevel).toBe(effort);
    await toggleHyp3rc0d3(page, false);
    await sendMessage(page, 'hyp3rc0d3: first alias', 'reply:first alias');
    expect((await page.evaluate(() => window.piDesktop.getRuntimeState())).hyp3rc0d3).toBe(true);
    await toggleHyp3rc0d3(page, false);
    await sendMessage(page, 'hypercode: second alias', 'reply:second alias');
    const current = await page.evaluate(() => window.piDesktop.getRuntimeState());
    expect(current.hyp3rc0d3).toBe(true);
    const forkPoint = current.forkPoints?.[0];
    expect(forkPoint).toBeDefined();
    const fork = await page.evaluate((entryId) => window.piDesktop.forkSession(entryId), forkPoint!.entryId);
    expect(fork.state.hyp3rc0d3).toBe(true);
    expect(fork.state.sessionId).not.toBe(saved.sessionId);
    await page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!);
    const clone = await page.evaluate(() => window.piDesktop.cloneSession());
    expect(clone.hyp3rc0d3).toBe(true);
    expect(clone.sessionId).not.toBe(saved.sessionId);
    await page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!);
    const records = await requestRecords(recordsPath);
    expect(records.filter((record) => !record.child).map((record) => ({ model: record.model, hyp3rc0d3: record.hyp3rc0d3, reasoning: record.reasoning })))
      .toEqual(Array.from({ length: 3 }, () => ({ model: 'plain', hyp3rc0d3: true, reasoning: undefined })));
    await closeOrExplain(application);
    application = undefined;
    launched = await launchProduction(fixture);
    application = launched.application;
    expect((await launched.page.evaluate((id) => window.piDesktop.switchSession(id), saved.sessionId!)).hyp3rc0d3).toBe(true);
    expect(await requestRecords(recordsPath)).toEqual(records);
  } finally { await closeSynthetic(application, fixture.root); }
});

test('production Hypercode runs seventeen children concurrently and respects a lower explicit workflow limit', async () => {
  test.setTimeout(240_000);
  const fixture = await projectFixture('fate-hypercode-concurrency-e2e-');
  const recordsPath = path.join(fixture.root, 'requests.jsonl');
  let application: ElectronApplication | undefined;
  try {
    await installSyntheticProvider(fixture.agent, recordsPath);
    const launched = await launchProduction(fixture);
    application = launched.application;
    const page = launched.page;
    await readySynthetic(page);
    const names = Array.from({ length: 17 }, (_, index) => `wide-${index}`);
    const workflow = await startWorkflow(page, 'wide', names.map((name) => workflowNode(name, `e2e:child:hold:${name}`)), 17);
    await expect.poll(() => application!.evaluate(() => [...((globalThis as SyntheticGlobal).fateE2eSynthetic?.held.keys() ?? [])].length), READY).toBe(17);
    await expect.poll(() => page.evaluate(async (id) => {
      const state = await window.piDesktop.getRuntimeState();
      return { running: state.subagentWorkflows?.find((item) => item.id === id)?.nodes.filter((node) => node.status === 'running').length,
        active: state.agentTeams?.flatMap((team) => team.nodes).filter((node) => node.depth === 1 && node.status === 'active').length };
    }, workflow.id), READY).toEqual({ running: 17, active: 17 });
    await expect(page.getByLabel('agent_workflow tool running', { exact: true })).toBeVisible();
    expect((await requestRecords(recordsPath)).filter((record) => record.child && record.tag?.startsWith('hold:wide-'))).toHaveLength(17);
    await releaseStreams(application, names);
    await completedWorkflow(page, workflow.id);
    await expect(page.getByLabel('agent_workflow tool completed', { exact: true })).toBeVisible();
    const full = await retrieveResults(page, recordsPath, 'wide-full', { action: 'results', workflowId: workflow.id });
    expect(full.error).toBe(false);
    expect((JSON.parse(full.text) as RetainedResults).nodes.map((node) => node.result)).toEqual(names.map((name) => `held-complete:${name}`));
    const limitedNames = ['limited-0', 'limited-1', 'limited-2'];
    const limited = await startWorkflow(page, 'limited', limitedNames.map((name) => workflowNode(name, `e2e:child:hold:${name}`)), 2);
    await expect.poll(() => application!.evaluate(() => [...((globalThis as SyntheticGlobal).fateE2eSynthetic?.held.keys() ?? [])]), READY).toEqual(limitedNames.slice(0, 2));
    const limitedState = (await page.evaluate(() => window.piDesktop.getRuntimeState())).subagentWorkflows?.find((item) => item.id === limited.id);
    expect(limitedState?.maxConcurrency).toBe(2);
    expect(limitedState?.nodes.map((node) => node.status)).toEqual(['running', 'running', 'pending']);
    await releaseStreams(application, [limitedNames[0]!]);
    await expect.poll(() => application!.evaluate(() => [...((globalThis as SyntheticGlobal).fateE2eSynthetic?.held.keys() ?? [])]), READY).toEqual(limitedNames.slice(1));
    await releaseStreams(application, limitedNames);
    await completedWorkflow(page, limited.id);
  } finally { await closeSynthetic(application, fixture.root); }
});

test('production workflow descendants join for synthesis and omitted node permission inherits actual write authority', async () => {
  test.setTimeout(240_000);
  const fixture = await projectFixture('fate-hypercode-delegation-e2e-');
  const recordsPath = path.join(fixture.root, 'requests.jsonl');
  let application: ElectronApplication | undefined;
  try {
    await installSyntheticProvider(fixture.agent, recordsPath);
    const launched = await launchProduction(fixture);
    application = launched.application;
    const page = launched.page;
    await readySynthetic(page);
    const workflow = await startWorkflow(page, 'nested', [workflowNode('parent', 'e2e:child:delegate:parent'),
      workflowNode('writer', 'e2e:child:write:writer', 'inherit', ['write']), workflowNode('reader', 'e2e:child:hold:reader')], 3);
    await expect.poll(() => application!.evaluate(() => [...((globalThis as SyntheticGlobal).fateE2eSynthetic?.held.keys() ?? [])].sort()), READY).toEqual(['leaf', 'reader']);
    await expect.poll(() => readFile(path.join(fixture.project, 'inherited-permission.txt'), 'utf8'), READY).toBe('inherited-write-sentinel');
    const state = await page.evaluate(() => window.piDesktop.getRuntimeState());
    expect(state.subagentWorkflows?.find((item) => item.id === workflow.id)?.status).toBe('running');
    expect(state.messages.some((item) => item.text === `e2e-notified:${workflow.id}`)).toBe(false);
    const nodes = state.agentTeams?.flatMap((team) => team.nodes) ?? [];
    expect(nodes.find((node) => node.depth === 1 && node.enabledTools.includes('write'))?.permissionLevel).toBe('full-access');
    expect(nodes.filter((node) => node.depth > 0 && !node.enabledTools.includes('write')).every((node) => node.permissionLevel === 'read-only')).toBe(true);
    expect(nodes.map((node) => node.depth)).toEqual(expect.arrayContaining([1, 2, 3]));
    const nestedRecords = (await requestRecords(recordsPath)).filter((record) => record.tag?.startsWith('delegate:'));
    expect(nestedRecords.some((record) => record.tag === 'delegate:parent' && record.tool === 'spawn_agent')).toBe(true);
    expect(nestedRecords.some((record) => record.tag === 'delegate:middle' && record.tool === 'spawn_agent')).toBe(true);
    for (const tag of ['delegate:parent', 'delegate:middle']) {
      const scopeResult = nestedRecords.find((record) => record.tag === tag && record.tool === 'spawn_agent')?.results?.find((result) => result.tool === 'wait_agent');
      expect(scopeResult).toMatchObject({ error: true, text: expect.stringMatching(/direct children/u) });
    }
    for (const record of nestedRecords) {
      expect(record.tools).toEqual(expect.arrayContaining(['spawn_agent', 'wait_agent', 'send_message']));
      expect(record.tools).not.toEqual(expect.arrayContaining(['create_team']));
    }
    await releaseStreams(application, ['leaf', 'reader']);
    await completedWorkflow(page, workflow.id);
    const response = await retrieveResults(page, recordsPath, 'nested-full', { action: 'results', workflowId: workflow.id });
    expect(response.error).toBe(false);
    expect((JSON.parse(response.text) as RetainedResults).nodes.find((node) => node.id === 'parent')).toMatchObject({ status: 'completed', result: 'parent-synthesis:held-complete:leaf' });
    expect((await requestRecords(recordsPath)).some((record) => record.tag === 'delegate:middle' && record.reply === 'middle-synthesis:held-complete:leaf')).toBe(true);
  } finally { await closeSynthetic(application, fixture.root); }
});

test('production workflow results retain full large outcomes and errors across ranges and restart without reexecuting children', async () => {
  test.setTimeout(240_000);
  const fixture = await projectFixture('fate-hypercode-results-e2e-');
  const recordsPath = path.join(fixture.root, 'requests.jsonl');
  let application: ElectronApplication | undefined;
  try {
    await installSyntheticProvider(fixture.agent, recordsPath);
    let launched = await launchProduction(fixture);
    application = launched.application;
    let page = launched.page;
    await readySynthetic(page);
    const workflow = await startWorkflow(page, 'large', [workflowNode('large', 'e2e:child:large:output'),
      workflowNode('failure', 'e2e:child:error:failure'), workflowNode('empty', 'e2e:child:empty:empty')], 3);
    await expect.poll(() => application!.evaluate(() => [...((globalThis as SyntheticGlobal).fateE2eSynthetic?.held.keys() ?? [])].sort()), READY).toEqual(['empty', 'failure', 'output']);
    await releaseStreams(application, ['output', 'failure', 'empty']);
    await completedWorkflow(page, workflow.id, 'error');
    const sessionId = (await page.evaluate(() => window.piDesktop.getRuntimeState())).sessionId!;
    const metadata = await retrieveResults(page, recordsPath, 'large-status', { action: 'status', workflowId: workflow.id });
    expect(metadata.error).toBe(false);
    expect(metadata.text).not.toContain(':large-result-tail');
    expect(metadata.text).not.toContain(':large-error-tail');
    const full = await retrieveResults(page, recordsPath, 'large-full', { action: 'results', workflowId: workflow.id });
    expect(full.error).toBe(false);
    const retained = JSON.parse(full.text) as RetainedResults;
    const output = retained.nodes.find((node) => node.id === 'large')!;
    const failure = retained.nodes.find((node) => node.id === 'failure')!;
    const empty = retained.nodes.find((node) => node.id === 'empty')!;
    expect(output.result).toBe('L'.repeat(70000) + ':large-result-tail');
    expect(output.resultLength).toBe(output.result!.length);
    expect(output.error).toBeNull();
    expect(output.errorRange).toBeNull();
    expect(failure.error!.length).toBeGreaterThan(4000);
    expect(failure.error).toContain(':large-error-tail');
    expect(empty.result).toBe('');
    expect(empty.resultLength).toBe(0);
    expect(empty.resultRange).toEqual({ offset: 0, length: 0, nextOffset: null });
    expect(empty.error).toBeNull();
    const parts: string[] = [];
    let offset = 0;
    for (let index = 0; index < 3; index += 1) {
      const response = await retrieveResults(page, recordsPath, `large-range-${index}`, { action: 'results', workflowId: workflow.id, nodeIds: ['large'], textOffset: offset, textLength: 30000 });
      expect(response.error).toBe(false);
      const selected = (JSON.parse(response.text) as RetainedResults).nodes;
      expect(selected).toHaveLength(1);
      expect(selected[0]!.resultRange?.offset).toBe(offset);
      parts.push(selected[0]!.result!);
      offset += selected[0]!.resultRange!.length;
      expect(selected[0]!.resultRange!.nextOffset).toBe(index === 2 ? null : offset);
    }
    expect(parts.join('')).toBe(output.result);
    const tail = await retrieveResults(page, recordsPath, 'error-tail', { action: 'results', workflowId: workflow.id, nodeIds: ['failure'], textOffset: 6500 });
    expect(tail.error).toBe(false);
    expect((JSON.parse(tail.text) as RetainedResults).nodes[0]!.error).toBe(failure.error!.slice(6500));
    const noNodes = await retrieveResults(page, recordsPath, 'empty-selection', { action: 'results', workflowId: workflow.id, nodeIds: [] });
    expect(noNodes.error).toBe(false);
    expect((JSON.parse(noNodes.text) as RetainedResults).nodes).toEqual([]);
    const unknown = await retrieveResults(page, recordsPath, 'unknown-node', { action: 'results', workflowId: workflow.id, nodeIds: ['missing'] });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toContain('Unknown workflow node missing');
    const before = (await requestRecords(recordsPath)).filter((record) => record.child);
    expect(before.map((record) => record.tag).sort()).toEqual(['empty:empty', 'error:failure', 'large:output']);
    await closeOrExplain(application);
    application = undefined;
    launched = await launchProduction(fixture);
    application = launched.application;
    page = launched.page;
    await page.bringToFront();
    const sessions = await page.evaluate(() => window.piDesktop.listSessions());
    const saved = sessions.find((session) => session.id === sessionId);
    expect(saved).toBeDefined();
    expect(sessions.filter((session) => session.title === saved!.title)).toHaveLength(1);
    const row = page.locator('.session-row').filter({ has: page.getByText(saved!.title, { exact: true }) });
    await expect(row).toHaveCount(1);
    if (await row.getAttribute('aria-current') !== 'page') await row.locator('button.session-open, button.session-preview-open').click();
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.sessionId)), READY).toBe(sessionId);
    const scrollbar = page.getByRole('scrollbar', { name: 'Conversation scroll position' });
    if (await scrollbar.isVisible()) await scrollbar.press('End');
    await expect(page.getByText('e2e-results:unknown-node', { exact: true })).toBeVisible(READY);
    const afterRestart = await retrieveResults(page, recordsPath, 'restart-full', { action: 'results', workflowId: workflow.id });
    expect(afterRestart.error).toBe(false);
    expect(JSON.parse(afterRestart.text)).toEqual(retained);
    expect((await requestRecords(recordsPath)).filter((record) => record.child)).toEqual(before);
  } finally { await closeSynthetic(application, fixture.root); }
});

test('production Hyp3rc0d3 sends through the SDK, preserves effort and receives a real workflow completion', async () => {
  test.setTimeout(180_000);
  const fixture = await projectFixture('fate-hyp3rc0d3-e2e-');
  const recordsPath = path.join(fixture.root, 'requests.jsonl');
  let application: ElectronApplication | undefined;
  try {
    await installSyntheticProvider(fixture.agent, recordsPath);
    const launched = await launchProduction(fixture);
    application = launched.application;
    const page = launched.page;
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.status)), READY).toBe('ready');
    await page.evaluate(async (provider) => {
      await window.piDesktop.setModel(provider, 'reasoning');
      await window.piDesktop.setThinkingLevel('medium');
    }, PROVIDER);
    await toggleHyp3rc0d3(page, true);
    await sendMessage(page, 'hello in graph mode', 'reply:hello in graph mode');
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.piDesktop.getRuntimeState();
      return { hyp3rc0d3: state.hyp3rc0d3, thinking: state.thinkingLevel, error: state.error };
    }), READY).toEqual({ hyp3rc0d3: true, thinking: 'medium', error: null });
    await page.getByRole('textbox', { name: 'Message Pi', exact: true }).fill('run bounded workflow');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Pi', exact: true })).toHaveValue('');
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.piDesktop.getRuntimeState();
      return state.subagentWorkflows?.map((workflow) => ({ status: workflow.status, notification: workflow.notification,
        nodes: workflow.nodes.map((node) => ({ status: node.status })) }));
    }), READY).toEqual([{ status: 'completed', notification: 'immediate', nodes: [{ status: 'completed' }] }]);
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.messages.some((message) => message.role === 'assistant' && message.text === 'workflow-notification-received-sentinel'))), READY).toBe(true);
    await expect.poll(() => page.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.activeSessionRunning ?? state.streaming)), READY).toBe(false);
    await toggleHyp3rc0d3(page, false);
    await sendMessage(page, 'hello after graph mode', 'reply:hello after graph mode');
    const records: RequestRecord[] = (await readFile(recordsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => !record.child).every((record) => record.reasoning === 'medium')).toBe(true);
    expect(records.find((record) => record.reply === 'reply:hello in graph mode')).toMatchObject({ hyp3rc0d3: true, model: 'reasoning' });
    expect(records.find((record) => record.child)).toMatchObject({ reply: 'child-complete-sentinel', model: 'reasoning' });
    expect(records.find((record) => record.reply === 'reply:hello after graph mode')).toMatchObject({ hyp3rc0d3: false, model: 'reasoning' });
    expect(records.some((record) => record.tool === 'agent_workflow')).toBe(true);
    expect(await page.evaluate(async () => {
      const state = await window.piDesktop.getRuntimeState();
      return { hyp3rc0d3: state.hyp3rc0d3, thinking: state.thinkingLevel, error: state.error };
    })).toEqual({ hyp3rc0d3: false, thinking: 'medium', error: null });
  } finally {
    try { await closeOrExplain(application); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});
