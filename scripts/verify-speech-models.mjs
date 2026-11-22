import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TranscribeModel, getAvailableBackends } from 'transcribe-cpp';
import { resolveModelLanguage, speechModel, speechModels } from '../src/main/speech/speechModels.ts';
import { assertSpokenTranscript, readSpokenFixture } from '../src/main/bootstrap/spokenSmokeFixture.ts';

async function download(definition, target) {
  const { bytes, sha256, url } = definition;
  let size = await stat(target).then((s) => s.size, () => 0);
  for (let attempt = 1; size < bytes && attempt <= 6; attempt++) {
    try {
      const response = await fetch(url, size ? { headers: { Range: `bytes=${size}-` } } : {});
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
      const append = response.status === 206;
      if (append && !response.headers.get('content-range')?.startsWith(`bytes ${size}-`)) throw new Error('Invalid download range');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: append ? 'a' : 'w' }));
    } catch (error) {
      if (attempt === 6) throw error;
      console.warn(`[${definition.id}] download interrupted: ${error.message}; retrying`);
    }
    size = await stat(target).then((s) => s.size, () => 0);
  }
  const hash = createHash('sha256');
  if (size === bytes) for await (const chunk of createReadStream(target)) hash.update(chunk);
  if (size !== bytes || hash.digest('hex') !== sha256) {
    await rm(target, { force: true });
    throw new Error(`Size or SHA-256 mismatch for ${definition.fileName}`);
  }
}

async function verify(definition, file, pcm) {
  const { id } = definition;
  const model = await TranscribeModel.load(file, { backend: 'cpu' });
  try {
    const auto = resolveModelLanguage(definition, 'auto');
    const english = resolveModelLanguage(definition, 'en');
    const batchSession = model.createSession({ nThreads: 4 });
    try {
      const batch = await batchSession.run(pcm, { timestamps: 'none', ...(auto ? { language: auto } : {}) });
      assertSpokenTranscript(batch.text, `${id} batch`);
      console.log(`[${id}] batch: ${batch.text.trim()}`);
    } finally {
      batchSession.dispose();
    }
    if (!definition.streaming) return;
    for (const language of new Set([auto, english])) {
      const session = model.createSession({ nThreads: 4 });
      try {
        const stream = await session.stream({
          timestamps: 'none', commitPolicy: 'stable_prefix',
          ...(language ? { language } : {}),
          ...(definition.streamFamily ? { family: definition.streamFamily } : {}),
        });
        for (let i = 0; i < pcm.length; i += 2_560) await stream.feed(pcm.subarray(i, i + 2_560));
        await stream.finalize();
        assertSpokenTranscript(stream.text.committed, `${id} stream (${language ?? 'auto'})`);
        console.log(`[${id}] stream (${language ?? 'auto'}): ${stream.text.committed.trim()}`);
      } finally {
        session.dispose();
      }
    }
  } finally {
    model.dispose();
  }
}

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, 'node_modules', '.cache', 'speech-spike');
const targets = process.argv.length > 2 ? process.argv.slice(2).map(speechModel) : speechModels;
const pcm = await readSpokenFixture(root);
await mkdir(cache, { recursive: true });
console.log('Backends:', getAvailableBackends().map((b) => `${b.kind}(${b.deviceType})`).join(', '));
for (const definition of targets) {
  const file = path.join(cache, definition.fileName);
  console.log(`[${definition.id}] verifying ${definition.fileName}`);
  await download(definition, file);
  await verify(definition, file, pcm);
}
