import { expect, test, type Page } from '@playwright/test';
import { captureEvidence, launchIntelligentUi, openSavedAgent, sendFixture } from './intelligent-ui-navigation';

async function expectStreamingIsHidden(page: Page) {
  await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(true);
  await expect(page.getByText('streaming_raw_lang_marker')).toHaveCount(0);
  await expect(page.locator('.intelligent-answer').first()).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(false);
}

async function showRelease(page: Page) {
  await page.getByRole('scrollbar', { name: 'Conversation scroll position' }).press('Home');
  const heading = page.locator('.intelligent-answer').first().getByRole('heading', { name: 'Release readiness', exact: true });
  await expect(heading).toBeVisible();
  await heading.evaluate((element) => element.scrollIntoView({ block: 'start' }));
}

async function changeControls(page: Page) {
  const release = page.locator('.intelligent-answer').first();
  await expect(release.getByRole('table', { name: 'Release checks' })).toContainText('Build');
  await release.getByLabel('Risk', { exact: true }).selectOption('High');
  await expect(release.getByRole('table', { name: 'Release checks' })).not.toContainText('Build');
  await expect(release.getByRole('table', { name: 'Release checks' })).toContainText('Migration');
  const reviewers = release.getByLabel('Reviewers');
  await reviewers.press('Home');
  await reviewers.press('ArrowRight');
  await reviewers.press('ArrowRight');
  await reviewers.press('ArrowRight');
  await expect(release.locator('.iui-metric').filter({ hasText: 'Review hours' })).toContainText('1');
  await release.getByLabel('Review complete').check();
  await release.getByLabel('Review notes').fill('Rollback verified');
  const details = page.locator('.intelligent-answer').nth(1);
  await details.getByLabel('Reviewer').fill('Mara');
  await details.getByLabel('Team').fill('Platform');
  await details.getByLabel('Reference').fill('REL-42');
  await expect(details.getByText('Mara / Platform')).toBeVisible();
  await details.getByRole('button', { name: 'Grow' }).click();
  await details.getByRole('button', { name: 'Grow' }).click();
  await expect(details.getByText('xxxx', { exact: true })).toBeVisible();
}

async function expectControlsPersist(page: Page) {
  const release = page.locator('.intelligent-answer').first();
  const details = page.locator('.intelligent-answer').nth(1);
  await expect(release.getByLabel('Risk', { exact: true })).toHaveValue('High');
  await expect(release.getByLabel('Reviewers')).toHaveValue('4');
  await expect(release.getByLabel('Review complete')).toBeChecked();
  await expect(release.getByLabel('Review notes')).toHaveValue('Rollback verified');
  await expect(details.getByLabel('Reviewer')).toHaveValue('Mara');
  await expect(details.getByLabel('Team')).toHaveValue('Platform');
  await expect(details.getByLabel('Reference')).toHaveValue('REL-42');
  await expect(details.getByText('xxxx', { exact: true })).toBeVisible();
}

async function expectDraftOnly(page: Page, action: () => Promise<void>, text: string) {
  const composer = page.getByLabel('Message Pi');
  await composer.fill('Existing unsent draft');
  await composer.press('ControlOrMeta+A');
  const before = await page.evaluate(async () => (await window.piDesktop.getRuntimeState()).messages.length);
  await action();
  await expect(composer).toHaveValue(/Existing unsent draft/);
  await expect(composer).toHaveValue(new RegExp(text));
  await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).messages.length)).toBe(before);
  await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(false);
}

test('interactive answers work and remain isolated in regular and saved Agent chats', async () => {
  test.setTimeout(120_000);
  const { app, page, cleanup } = await launchIntelligentUi();
  try {
    await sendFixture(page);
    await expectStreamingIsHidden(page);
    await showRelease(page);
    await expect(page.getByText('Mock data for an illustrative release, not a live assessment.', { exact: true })).toBeVisible();
    await expect(page.locator('.intelligent-answer').first().getByRole('table', { name: 'Release checks' })).toBeVisible();
    await expect(page.locator('.intelligent-answer').first().getByText('Passed checks', { exact: true })).toBeVisible();
    await expect(page.getByText('ordinary_code_marker')).toBeVisible();
    await captureEvidence(page, 'regular-dark.png');
    await changeControls(page);
    const budget = page.locator('.intelligent-answer').nth(2);
    await expect(budget.locator('.iui-metric')).toContainText('$540');
    await budget.getByLabel('Hours', { exact: true }).fill('8');
    await expect(budget.locator('.iui-metric')).toContainText('$720');
    await budget.getByRole('button', { name: 'Done' }).first().click();
    await expect(budget).toContainText('1 of 3 reviewed');
    await page.locator('.session-open').filter({ hasText: 'Second session' }).click();
    await expect(page.locator('.intelligent-answer')).toHaveCount(0);
    await page.locator('.session-open').filter({ hasText: 'First session' }).click();
    await expectControlsPersist(page);
    await page.reload();
    await expectControlsPersist(page);
    await expectDraftOnly(page, async () => { await page.locator('.intelligent-answer').first().getByRole('button', { name: 'Review release' }).click(); }, 'Review this release assessment');
    await expect(page.getByLabel('Message Pi')).toHaveValue(/Rollback verified/);
    await expectDraftOnly(page, async () => { await page.locator('.intelligent-answer').nth(1).getByLabel('Team').press('Enter'); }, 'Review these details');
    await expect(page.getByLabel('Message Pi')).toHaveValue(/REL-42/);
    await page.getByLabel('Message Pi').fill('');
    await expect(page.locator('.composer-fork-notice')).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 700));
    await showRelease(page);
    await captureEvidence(page, 'narrow.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1100));
    await openSavedAgent(page);
    await expect(page.locator('.intelligent-answer')).toHaveCount(0);
    await sendFixture(page);
    await expectStreamingIsHidden(page);
    await showRelease(page);
    await expect(page.locator('.intelligent-answer').first().getByLabel('Risk', { exact: true })).toHaveValue('All');
    await captureEvidence(page, 'agents-dark.png');
    await changeControls(page);
    await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: /^Second session/ }).click();
    await expect(page.locator('.intelligent-answer')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: /^Release reviewer/ }).getByText('Release reviewer', { exact: true }).click();
    await expectControlsPersist(page);
  } finally {
    await cleanup();
  }
});

test('interactive answers render in light appearance', async () => {
  test.setTimeout(120_000);
  const { page, cleanup } = await launchIntelligentUi('light');
  try {
    await sendFixture(page);
    await expectStreamingIsHidden(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'light');
    await showRelease(page);
    await captureEvidence(page, 'regular-light.png');
  } finally {
    await cleanup();
  }
});

test('unsafe and oversized programs expose source without executing', async () => {
  test.setTimeout(120_000);
  const { page, cleanup } = await launchIntelligentUi();
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('intelligent-ui.invalid')) requests.push(request.url()); });
  try {
    await sendFixture(page, true);
    await expectStreamingIsHidden(page);
    const answers = page.locator('.intelligent-answer');
    await expect(answers).toHaveCount(5);
    for (const answer of (await answers.all()).slice(0, 2)) {
      await expect(answer.getByRole('alert')).toContainText('Interactive answer unavailable');
      await answer.getByText('View source').click();
    }
    await expect(answers.first()).toContainText('HtmlView');
    await expect(answers.nth(1)).toContainText('@Range');
    await expect(answers.nth(2).getByRole('button', { name: 'Injected' })).toHaveCount(0);
    await expect(answers.nth(3)).toContainText('quoted field works');
    await expect(answers.nth(4).locator('button:not(:disabled)')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__intelligentScriptRan)).toBeUndefined();
    expect(requests).toEqual([]);
  } finally {
    await cleanup();
  }
});
