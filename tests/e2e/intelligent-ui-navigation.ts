import { _electron as electron, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

export async function launchIntelligentUi(appearance: 'dark' | 'light' = 'dark') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fate-intelligent-ui-')));
  const project = path.join(directory, 'project');
  const profile = path.join(directory, 'profile');
  const data = path.join(profile, 'fateGUI');
  await mkdir(project);
  await mkdir(data, { recursive: true });
  await writeFile(path.join(project, 'README.md'), '# Isolated intelligent answer fixture\n');
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'high', confirmRiskyCommands: true, terminalShell: null, reduceMotion: true, skinId: 'default', themeId: appearance === 'light' ? 'daylight' : 'midnight', agentWorkspace: { preferredMode: 'shared', strict: false } })));
  try {
    const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: data, PI_DESKTOP_E2E_INTELLIGENT_UI: '1', PI_OFFLINE: '1' } });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1100));
    await page.getByRole('button', { name: /Open project/ }).first().click();
    return { app, page, cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
}

export async function openSavedAgent(page: Page) {
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const card = settings.locator('#saved-agent-new');
  await card.getByLabel('Agent name', { exact: true }).fill('Release reviewer');
  await card.getByLabel('Agent instructions').fill('Review release readiness.');
  await card.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(settings.getByRole('region', { name: 'Agent Release reviewer' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: /^Release reviewer/ }).getByText('Release reviewer', { exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).project?.agentId)).toBeTruthy();
}

export async function sendFixture(page: Page, invalid = false) {
  await page.getByLabel('Message Pi').fill(invalid ? '__FATE_INTELLIGENT_UI_INVALID__' : '__FATE_INTELLIGENT_UI__');
  await page.getByRole('button', { name: 'Send message' }).click();
}

export async function captureEvidence(page: Page, name: string) {
  await expect(page.getByRole('button', { name: 'Dismiss notification', exact: true })).toHaveCount(0);
  const directory = path.resolve('artifacts/intelligent-ui');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
}
