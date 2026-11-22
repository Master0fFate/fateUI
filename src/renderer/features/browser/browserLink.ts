import { getDesktopApiOptional, hasCapability } from '../../platform/api';
import { unavailableExplanation } from '../../platform/capabilityPolicy';
import { browserActionMessage } from '../../../shared/browserActionError';
import { normalizeBrowserWebUrl } from '../../../shared/contracts/browser';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

export async function openBrowserLink(value: string): Promise<void> {
  const url = normalizeBrowserWebUrl(value);
  if (!url) return;

  const ui = useUiStore.getState();
  const browser = useBrowserStore.getState();
  const { project, sessionId } = useRuntimeStore.getState().runtime;
  if (!hasCapability('nativeBrowser')) {
    ui.showToast({ kind: 'warning', title: 'Browser unavailable', message: unavailableExplanation.nativeBrowser });
    return;
  }
  if (!project?.trusted) {
    ui.showToast({ kind: 'warning', title: 'Browser unavailable', message: 'Open and trust a project before opening links in the Browser workspace.' });
    return;
  }
  const desktop = getDesktopApiOptional();
  if (typeof desktop?.navigateBrowser !== 'function') {
    ui.showToast({ kind: 'error', title: 'Browser unavailable', message: 'Restart the desktop app to reconnect the browser.' });
    return;
  }
  if (browser.pending) return;

  const stillSelected = () => {
    const current = useRuntimeStore.getState().runtime;
    return current.project?.trusted && current.project.path === project.path && current.sessionId === sessionId;
  };
  ui.setBrowserOpen(true);
  browser.setPending('navigation');
  try {
    const state = await desktop.navigateBrowser(url);
    if (stillSelected()) browser.hydrate(state);
  } catch (error) {
    if (!stillSelected()) return;
    const message = browserActionMessage(error, 'Could not open the link. Check the address and try again.');
    if (useUiStore.getState().browserOpen) browser.setError(message);
    else ui.showToast({ kind: 'error', title: 'Could not open link', message });
  } finally {
    if (stillSelected()) browser.setPending(null);
  }
}
