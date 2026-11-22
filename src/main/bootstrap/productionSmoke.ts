import type { SpeechModelId, SpeechStreamUpdate } from '../../shared/contracts/ipc';
import { assertSpokenTranscript, readSpokenFixture } from './spokenSmokeFixture';

export interface SpeechSmokeSurface {
  verifyRuntime(): Promise<void>;
  setStreamSink(sink: (update: SpeechStreamUpdate) => void): void;
  download(model: SpeechModelId): Promise<unknown>;
  streamStart(model: SpeechModelId, language: string): Promise<unknown>;
  streamFeed(samples: ArrayBuffer): Promise<unknown>;
  streamStop(): Promise<unknown>;
  streamCancel(): Promise<unknown>;
  transcribe(model: SpeechModelId, samples: ArrayBuffer, language: string): Promise<{ text: string }>;
}

export interface MusicStatusSurface {
  getStatus(): Promise<{ available: boolean; version: string | null; message?: string | undefined }>;
}

export interface ThemesSurface {
  loadThemes(): Promise<readonly { name: string; tone: string }[]>;
}

export interface ProductionSmokeDeps {
  speech: SpeechSmokeSurface;
  music: MusicStatusSurface;
  settings: ThemesSurface;
  smokeTerminalRuntime: (cwd: string) => Promise<string>;
  smokeRenderer: () => Promise<void>;
  cwd: string;
  streamSmokeEnabled: boolean;
  now(): number;
  log: (line: string) => void;
  error: (line: string) => void;
  quit: () => void;
  exit: (code: number) => void;
  /** Delay before a successful smoke quits. Defaults to 100ms. */
  quitDelayMs?: number;
}

async function smokeParakeetStream(speech: SpeechSmokeSurface, pcm: Float32Array): Promise<void> {
  await speech.download('parakeet-unified');
  let transcript = '';
  speech.setStreamSink((update) => { if (update.state === 'final') transcript = update.committed; });
  await speech.streamStart('parakeet-unified', 'auto');
  try {
    const chunkSize = 2_560;
    const padded = new Float32Array(Math.max(38 * chunkSize, pcm.length));
    padded.set(pcm);
    const feeds: Promise<unknown>[] = [];
    for (let i = 0; i < padded.length; i += chunkSize) feeds.push(speech.streamFeed(padded.slice(i, i + chunkSize).buffer));
    await Promise.all([...feeds, speech.streamStop()]);
    assertSpokenTranscript(transcript, 'Parakeet stream');
  } catch (error) {
    await speech.streamCancel().catch(() => undefined);
    throw error;
  }
}

async function smokeBatchSpeech(speech: SpeechSmokeSurface, pcm: Float32Array<ArrayBuffer>): Promise<void> {
  await speech.download('canary-flash');
  const result = await speech.transcribe('canary-flash', pcm.buffer, 'auto');
  assertSpokenTranscript(result.text, 'Canary batch');
}

export async function runProductionSmoke(deps: ProductionSmokeDeps): Promise<void> {
  try {
    await deps.smokeRenderer();
    deps.log('PI_DESKTOP_RENDERER_OK');
    const [, musicStatus, themes, terminalShell] = await Promise.all([
      deps.speech.verifyRuntime(),
      deps.music.getStatus(),
      deps.settings.loadThemes(),
      deps.smokeTerminalRuntime(deps.cwd),
    ]);
    if (!musicStatus.available) throw new Error(musicStatus.message ?? 'Bundled yt-dlp is unavailable.');
    // The standard themes are the two that Pi bundles. A theme from the operator's own Pi
    // profile must not satisfy this check, or a broken bundle passes on a developer machine.
    const standard = (name: string) => themes.some((theme) => theme.name === `Pi · ${name}` && theme.tone === name);
    if (!standard('dark') || !standard('light')) {
      throw new Error('Standard Pi themes are unavailable.');
    }
    if (deps.streamSmokeEnabled) {
      const pcm = await readSpokenFixture(deps.cwd);
      const streamStartedAt = deps.now();
      await smokeParakeetStream(deps.speech, pcm);
      deps.log(`PI_DESKTOP_PARAKEET_STREAM_OK ${Math.round(deps.now() - streamStartedAt)}ms`);
      const batchStartedAt = deps.now();
      await smokeBatchSpeech(deps.speech, pcm);
      deps.log(`PI_DESKTOP_BATCH_SPEECH_OK ${Math.round(deps.now() - batchStartedAt)}ms`);
    }
    deps.log('PI_DESKTOP_SPEECH_OK native binding');
    deps.log(`PI_DESKTOP_YT_DLP_OK ${musicStatus.version}`);
    deps.log('PI_DESKTOP_THEMES_OK');
    deps.log(`PI_DESKTOP_TERMINAL_OK ${terminalShell}`);
    deps.log('PI_DESKTOP_SMOKE_OK');
    setTimeout(() => deps.quit(), deps.quitDelayMs ?? 100);
  } catch (error: unknown) {
    deps.error(`PI_DESKTOP_RUNTIME_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    deps.exit(1);
  }
}
