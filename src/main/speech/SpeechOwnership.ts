import { ipcChannels, speechStreamUpdateSchema, type SpeechModelId, type SpeechStreamUpdate } from '../../shared/contracts/ipc';
import type { SpeechService } from './SpeechService';

type Engine = Pick<SpeechService, 'transcribe' | 'cancel' | 'streamStart' | 'streamFeed' | 'streamStop' | 'streamCancel'>;

type Owner = {
  sender: Electron.WebContents;
  attemptId: string;
  valid: () => boolean;
  detach: () => void;
  mode: 'capture' | 'batch' | 'stream';
  starting?: Promise<void>;
  stopping?: Promise<void>;
  pending: number;
  ended: boolean;
};

export class SpeechOwnership {
  private owner: Owner | null = null;

  constructor(private readonly engine: Engine, private readonly reportError: (error: unknown) => void) {}

  target(): Electron.WebContents | null {
    return this.owner?.valid() ? this.owner.sender : null;
  }

  claim(sender: Electron.WebContents, attemptId: string, valid: () => boolean): Owner {
    if (this.owner) throw new Error('Another voice recording is already running.');
    if (!valid()) throw new Error('The initiating voice window is unavailable.');
    const owner: Owner = { sender, attemptId, valid, mode: 'capture', pending: 0, ended: false, detach: () => {
      sender.removeListener('destroyed', abort);
      sender.removeListener('render-process-gone', abort);
      sender.removeListener('did-start-navigation', navigate);
    } };
    const abort = () => { void this.abort(owner).catch(this.reportError); };
    const navigate = (event: { isMainFrame: boolean; isSameDocument: boolean }) => { if (event.isMainFrame && !event.isSameDocument) abort(); };
    sender.once('destroyed', abort);
    sender.once('render-process-gone', abort);
    sender.on('did-start-navigation', navigate);
    this.owner = owner;
    return owner;
  }

  private match(sender: Electron.WebContents, attemptId: string): Owner | null {
    const owner = this.owner;
    return owner && owner.sender === sender && owner.attemptId === attemptId && !owner.ended && owner.valid() ? owner : null;
  }

  private begin(sender: Electron.WebContents, attemptId: string, valid: () => boolean, mode: 'batch' | 'stream'): Owner {
    const owner = this.match(sender, attemptId);
    if (!owner || !valid()) throw new Error('This voice recording is not active.');
    if (owner.mode !== 'capture') throw new Error('Another voice transcription is already running.');
    owner.mode = mode;
    return owner;
  }

  private retire(owner: Owner): void {
    if (this.owner !== owner || !owner.ended || owner.pending !== 0) return;
    owner.detach();
    this.owner = null;
  }

  private async track<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    owner.pending++;
    try { return await operation(); }
    finally { owner.pending--; this.retire(owner); }
  }

  private async abort(owner: Owner): Promise<boolean> {
    if (this.owner !== owner || owner.ended) return false;
    owner.ended = true;
    if (owner.mode === 'stream') {
      await this.track(owner, () => this.engine.streamCancel());
      return true;
    }
    try { return owner.mode === 'batch' ? this.engine.cancel() : true; }
    finally { this.retire(owner); }
  }

  async release(sender: Electron.WebContents, attemptId: string): Promise<void> {
    const owner = this.match(sender, attemptId);
    if (owner) await this.abort(owner);
  }

  async transcribe(sender: Electron.WebContents, attemptId: string, valid: () => boolean, modelId: SpeechModelId, audio: ArrayBuffer, language?: string) {
    const owner = this.begin(sender, attemptId, valid, 'batch');
    return this.track(owner, async () => {
      try {
        const result = await this.engine.transcribe(modelId, audio, language);
        if (owner.ended || !owner.valid()) throw new Error('Voice transcription was cancelled.');
        return result;
      } finally { owner.ended = true; }
    });
  }

  async cancelBatch(sender: Electron.WebContents, attemptId: string): Promise<boolean> {
    const owner = this.match(sender, attemptId);
    return owner?.mode === 'batch' && this.abort(owner);
  }

  start(sender: Electron.WebContents, attemptId: string, valid: () => boolean, modelId: SpeechModelId, language?: string, refine?: boolean): Promise<void> {
    const owner = this.begin(sender, attemptId, valid, 'stream');
    owner.starting = this.track(owner, async () => {
      try {
        await this.engine.streamStart(modelId, language, refine);
        if (owner.ended || !owner.valid()) throw new Error('Live transcription was cancelled.');
      } catch (error) { owner.ended = true; throw error; }
    });
    return owner.starting;
  }

  feed(sender: Electron.WebContents, attemptId: string, audio: ArrayBuffer): Promise<void> {
    const owner = this.match(sender, attemptId);
    if (owner?.mode !== 'stream') throw new Error('This voice recording is not active.');
    return this.track(owner, () => this.engine.streamFeed(audio));
  }

  async stop(sender: Electron.WebContents, attemptId: string): Promise<void> {
    const owner = this.match(sender, attemptId);
    if (owner?.mode !== 'stream') return;
    owner.stopping ??= this.track(owner, async () => {
      try {
        await owner.starting;
        if (!owner.ended && owner.valid()) await this.engine.streamStop();
      } finally { owner.ended = true; }
    });
    await owner.stopping;
  }

  async cancelStream(sender: Electron.WebContents, attemptId: string): Promise<void> {
    const owner = this.match(sender, attemptId);
    if (owner?.mode === 'stream') await this.abort(owner);
  }

  update(update: SpeechStreamUpdate): void {
    const owner = this.owner;
    if (owner?.mode !== 'stream' || (owner.ended && update.state !== 'cancelled')) return;
    try {
      if (owner.valid()) owner.sender.send(ipcChannels.speechStreamEvents, speechStreamUpdateSchema.parse({ ...update, attemptId: owner.attemptId }));
    } finally {
      if (update.state === 'final' || update.state === 'error' || update.state === 'cancelled') {
        owner.ended = true;
        this.retire(owner);
      }
    }
  }
}
