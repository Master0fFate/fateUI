import { ipcRenderer } from 'electron';
import { z } from 'zod';
import { ipcChannels } from '../shared/contracts/ipc';
import { browserActionMessage } from '../shared/browserActionError';
import type { wordReviewChannels } from '../shared/contracts/wordReview';

type Channel = typeof ipcChannels[keyof typeof ipcChannels];
type InvokeChannel = Channel | typeof wordReviewChannels[keyof typeof wordReviewChannels];

export const ignoreResult = z.unknown().transform(() => undefined);
export const discardResult = <S extends z.ZodTypeAny>(schema: S) => schema.transform(() => undefined);

export async function invoke<S extends z.ZodTypeAny>(channel: InvokeChannel, inputSchema: z.ZodTypeAny, outputSchema: S, ...input: [] | [unknown]): Promise<z.output<S>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, inputSchema.parse(input.length ? input[0] : {}));
    return outputSchema.parse(result);
  } catch (error) {
    if (!channel.startsWith('browser:')) throw error;
    throw new Error(browserActionMessage(error));
  }
}

export function subscribe<S extends z.ZodTypeAny>(channel: Channel, schema: S, listener: (payload: z.output<S>) => void, onInvalid?: (error: z.ZodError) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    if (!onInvalid) {
      listener(schema.parse(payload));
      return;
    }
    const parsed = schema.safeParse(payload);
    if (parsed.success) listener(parsed.data);
    else onInvalid(parsed.error);
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

export function unwrapResult<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
