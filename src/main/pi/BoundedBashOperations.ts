import { createLocalBashOperations, type BashOperations } from '@earendil-works/pi-coding-agent';

/** Applied when the model omits `timeout`. The SDK has no default, so an
 *  omitted value used to mean "wait forever" for servers, watchers, and
 *  commands blocked on a hidden prompt. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

/** Time the SDK gets to kill the process tree and drain pipes after a
 *  deadline or abort before the tool call is released regardless. */
export const BASH_SETTLE_GRACE_MS = 10_000;

const MAX_TIMER_MS = 2_147_483_647;

/**
 * Shell operations that always end. Every command gets a deadline, and a
 * backstop releases the call if the process tree survives the SDK's kill
 * (for example a Windows descendant that taskkill cannot stop). A released
 * call reports the same `timeout:` / `aborted` errors the SDK formats.
 */
export function createBoundedBashOperations(
  base: BashOperations = createLocalBashOperations(),
  graceMs: number = BASH_SETTLE_GRACE_MS,
): BashOperations {
  return {
    exec(command, cwd, options) {
      const timeout = options.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS;
      const run = base.exec(command, cwd, { ...options, timeout });
      return new Promise((resolve, reject) => {
        const { signal } = options;
        let deadline: NodeJS.Timeout | undefined;
        let backstop: NodeJS.Timeout | undefined;
        const cleanup = () => {
          clearTimeout(deadline);
          clearTimeout(backstop);
          signal?.removeEventListener('abort', onAbort);
        };
        const release = (reason: string) => {
          backstop ??= setTimeout(() => { cleanup(); reject(new Error(reason)); }, graceMs);
        };
        const onAbort = () => release('aborted');
        const timeoutMs = timeout * 1000;
        // Invalid values are rejected by the SDK itself; only arm valid deadlines.
        if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS) {
          deadline = setTimeout(() => release(`timeout:${timeout}`), timeoutMs);
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        run.then(
          (result) => { cleanup(); resolve(result); },
          (error: unknown) => { cleanup(); reject(error); },
        );
      });
    },
  };
}

/** Appended to timeout errors so the model retries correctly instead of looping. */
export const BASH_TIMEOUT_HINT = 'If the command needs more time, re-run it with a larger `timeout` (seconds). Start servers and watchers in the background with output redirected to a file, then read the file.';

export const BASH_TIMEOUT_GUIDELINE = `bash: commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds unless you pass \`timeout\`. Pass a larger \`timeout\` for long builds or test suites. Never run servers, watchers, or interactive commands in the foreground.`;
