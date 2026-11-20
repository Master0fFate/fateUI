import { expect, type ElectronApplication, type Locator } from '@playwright/test';

export async function saveMcpWithApproval(
  app: ElectronApplication,
  settings: Locator,
  { name, command, args }: { name: string; command: string; args: readonly string[] },
): Promise<void> {
  const exact = JSON.stringify([command, ...args]).replace(/[^\x20-\x7e]|[&<>']/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const detail = `Fate may run this command as you, without asking again. Enable it only if you trust the command and its arguments.\n\nJSON list (command first, then arguments; line breaks are display wrapping):\n${exact.match(/.{1,64}/g)!.join('\n')}`;
  const original = await app.evaluateHandle(({ dialog }) => dialog.showMessageBox);
  try {
    await app.evaluate(({ dialog }, { original, name, detail }) => {
      dialog.showMessageBox = async (_owner: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions) => {
        if (options?.title !== 'Enable local MCP server' || options.message !== `Allow ${name} to run a local command?`
          || options.detail !== detail || options.type !== 'warning' || options.defaultId !== 0 || options.cancelId !== 0
          || options.noLink !== true || JSON.stringify(options.buttons) !== '["Cancel","Enable local server"]') {
          throw new Error(`Unexpected native dialog while saving MCP server ${name}`);
        }
        dialog.showMessageBox = original;
        return { response: 1, checkboxChecked: false };
      };
    }, { original, name, detail });
    await settings.getByRole('button', { name: 'Save MCP servers' }).click();
    await expect(settings.getByRole('status').filter({ hasText: 'Saved. Reopen this project' })).toBeVisible();
    expect(await app.evaluate(({ dialog }, original) => dialog.showMessageBox === original, original),
      `Expected native enable confirmation for ${name}`).toBe(true);
  } finally {
    await original.dispose();
  }
}
