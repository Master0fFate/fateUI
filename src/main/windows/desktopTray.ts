import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';

interface DesktopTrayActions {
  openWindow: () => void;
  newWindow: () => void;
  hideWindows: () => void;
}

export function canParkOnDesktopTray(tray: Tray | null): boolean {
  if (process.platform === 'linux') return true;
  if (!tray || tray.isDestroyed()) return false;
  const { width, height } = tray.getBounds();
  return width > 0 && height > 0;
}

export function createDesktopTray(actions: DesktopTrayActions): Tray {
  const assets = app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(app.getAppPath(), 'build');
  const iconPath = path.join(assets, process.platform === 'darwin'
    ? 'trayTemplate.png'
    : process.platform === 'win32' ? 'icon.ico' : 'icons/32x32.png');
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error('The tray icon could not be loaded.');
  if (process.platform === 'darwin') image.setTemplateImage(true);

  const menu = Menu.buildFromTemplate([
    { label: 'Open Fate UI', click: actions.openWindow },
    { label: 'New Window', click: actions.newWindow },
    { label: process.platform === 'linux' ? 'Minimize Windows to Taskbar' : 'Hide Windows', click: actions.hideWindows },
    { type: 'separator' },
    { label: 'Quit Fate UI', click: () => app.quit() },
  ]);
  const tray = new Tray(image);
  try {
    tray.setToolTip('Fate UI');
    if (process.platform === 'linux') {
      tray.setContextMenu(menu);
      tray.on('click', actions.openWindow);
    } else {
      if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(false);
      tray.on('double-click', actions.openWindow);
      tray.on('right-click', () => tray.popUpContextMenu(menu));
    }
  } catch (error) {
    tray.destroy();
    throw error;
  }
  return tray;
}
