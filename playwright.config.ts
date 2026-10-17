import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') {
  const privateTemp = path.join(homedir(), '.fate-e2e-tmp');
  mkdirSync(privateTemp, { recursive: true });
  process.env.TEMP = privateTemp;
  process.env.TMP = privateTemp;
}

export default defineConfig({
  // Windows: fixtures under the system Temp inherit sandbox ACEs on some hosts, which the
  // native state backend's private-ACL gate rejects. A folder directly under the profile stays private.
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  // The long first-launch journey exercises native Electron + worktree folder
  // switching; retry twice on hosted runners where timing can flake.
  retries: process.env.CI ? 2 : 0,
  // Hosted macOS Intel runners can take more than a minute for the full native Electron journey.
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
