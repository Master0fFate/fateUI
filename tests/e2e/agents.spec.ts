import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';
import { evidenceOutputPath } from './evidenceOutputPath';

async function agents(page: Page) { await page.getByRole('tab', { name: 'Agents', exact: true }).click(); }
async function contained(page: Page) {
  await expect.poll(() => page.locator('.sidebar-tab-content[data-state="active"]').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('button, input')].every((control) => {
      const bounds = control.getBoundingClientRect();
      return bounds.width === 0 || bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1;
    }) && panel.scrollWidth <= panel.clientWidth + 1;
  })).toBe(true);
}
async function toolbarMatchesSessions(page: Page) {
  const measure = () => page.locator('.sidebar-tab-content[data-state="active"] .sidebar-tab-toolbar').evaluate((toolbar) => {
    const metrics = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, background: style.backgroundColor, radius: style.borderRadius };
    };
    return { search: metrics(toolbar.querySelector('.sidebar-search')!), action: metrics(toolbar.querySelector('.sidebar-toolbar-action > button')!) };
  });
  const agentsToolbar = await measure();
  await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
  const sessionsToolbar = await measure();
  for (const key of ['search', 'action'] as const) {
    for (const dimension of ['x', 'y', 'height'] as const) expect(Math.abs(agentsToolbar[key][dimension] - sessionsToolbar[key][dimension])).toBeLessThanOrEqual(1);
    expect(agentsToolbar[key].background).toBe(sessionsToolbar[key].background);
    expect(agentsToolbar[key].radius).toBe(sessionsToolbar[key].radius);
  }
  await agents(page);
}

for (const skin of ['default', 'dreamcore', 'm3-expressive'] as const) {
  test(`Agents open one chat each and edit in Settings across ${skin}`, async () => {
    test.setTimeout(120_000);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), `fate-agents-${skin}-`)));
    const project = path.join(directory, 'project');
    const profile = path.join(directory, 'profile');
    const data = path.join(profile, 'fateGUI');
    await mkdir(project); await mkdir(data, { recursive: true });
    await writeFile(path.join(project, 'README.md'), '# Isolated Agents fixture\n');
    await writeFile(path.join(data, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'high', confirmRiskyCommands: true, terminalShell: null, reduceMotion: true, skinId: skin, themeId: 'midnight', agentWorkspace: { preferredMode: 'shared', strict: false } })));
    const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: data, PI_OFFLINE: '1' } });
    let app: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      app = await launch();
      const page = await app.firstWindow();
      await page.getByRole('button', { name: /Open project/ }).first().click();
      await agents(page);
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.getByText('No agents yet')).toBeVisible();
      await toolbarMatchesSessions(page);
      await contained(page);
      await page.screenshot({ path: await evidenceOutputPath('agents', `${skin}-empty.png`), animations: 'disabled' });

      await page.getByRole('button', { name: 'New agent', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      const card = settings.locator('#saved-agent-new');
      await card.getByLabel('Agent name', { exact: true }).fill('Reviewer');
      await card.getByLabel('Agent instructions').fill('Review carefully. Report back here.');
      await card.screenshot({ path: await evidenceOutputPath('agents', `${skin}-settings.png`), animations: 'disabled' });
      await card.getByRole('button', { name: 'Save agent', exact: true }).click();
      await expect(settings.getByRole('region', { name: 'Agent Reviewer' })).toBeVisible();
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click();

      await page.getByRole('button', { name: /^Reviewer/ }).getByText('Reviewer', { exact: true }).click();
      await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).project?.agentId)).toBeTruthy();
      await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('data-state', 'active');
      await expect(page.locator('.session-row--current')).toContainText('Reviewer');
      await contained(page);
      await page.screenshot({ path: await evidenceOutputPath('agents', `${skin}-chat.png`), animations: 'disabled' });

      await page.getByRole('button', { name: 'Delete agent: Reviewer', exact: true }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText('No agents yet')).toBeVisible();
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
