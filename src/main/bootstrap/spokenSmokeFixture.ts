import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readSpokenFixture(root: string) {
  const data = await readFile(path.join(root, 'tests/fixtures/speech/review-changes.s16le'));
  if (!data.length || data.length % 2) throw new Error('Malformed spoken smoke fixture.');
  const pcm = new Float32Array(data.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

export function assertSpokenTranscript(text: string, source: string): void {
  if (!/\breview\b.*\bchanges\b.*\bmessage\b/s.test(text.toLowerCase())) {
    throw new Error(`${source}: expected "review", "changes" and "message" in order, received ${JSON.stringify(text.slice(0, 240))}.`);
  }
}
