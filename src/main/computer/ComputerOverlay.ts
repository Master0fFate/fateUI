import { BaseWindow, screen, WebContentsView, type Display, type Rectangle } from 'electron';
import os from 'node:os';

const ACCENT = '124, 108, 255';
const PILL_WIDTH = 280;
const PILL_HEIGHT = 40;

const frameHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.edge, .glow { position: fixed; inset: 0; pointer-events: none; }
.edge { box-shadow: inset 0 0 0 2px rgba(${ACCENT}, .5); transition: box-shadow 240ms ease-out; }
.glow { box-shadow: inset 0 0 48px 8px rgba(${ACCENT}, .38); opacity: 0; transition: opacity 320ms ease-out; }
body[data-active] .edge { box-shadow: inset 0 0 0 3px rgba(${ACCENT}, .95); }
body[data-active] .glow { opacity: 1; animation: breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.cursor { position: fixed; left: 0; top: 0; display: flex; align-items: flex-start; gap: 4px; opacity: 0; will-change: transform;
  transition: transform 300ms cubic-bezier(.2, .8, .2, 1), opacity 160ms ease-out; }
.cursor svg { margin: -2px 0 0 -3px; filter: drop-shadow(0 2px 4px rgba(8, 9, 16, .45)); }
.label { margin-top: 16px; padding: 4px 8px; border-radius: 6px; color: #fff; background: rgba(${ACCENT}, .96);
  font: 600 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap; box-shadow: 0 2px 8px rgba(8, 9, 16, .35); }
.label:empty { display: none; }
.ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; pointer-events: none;
  border: 2px solid rgba(${ACCENT}, .95); background: rgba(${ACCENT}, .18); animation: ripple 480ms cubic-bezier(.2, .8, .2, 1) forwards; }
@keyframes ripple { from { transform: scale(.25); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style></head><body>
<div class="edge"></div><div class="glow"></div>
<div class="cursor"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 2.5v17l4.7-4.3 3 6.4 3-1.4-3-6.3h6.3z" fill="rgb(${ACCENT})" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="label"></span></div>
<script>
const cursor = document.querySelector('.cursor');
const label = document.querySelector('.label');
window.fate = {
  active(on) { if (on) document.body.dataset.active = ''; else delete document.body.dataset.active; },
  move(x, y, text) { label.textContent = text; cursor.style.opacity = '1'; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
  hide() { cursor.style.opacity = '0'; },
  click(x, y) {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    document.body.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
    setTimeout(() => ripple.remove(), 1000);
  },
};
</script></body></html>`;

const pillHtml = (shortcut: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; user-select: none; }
body { display: flex; align-items: center; justify-content: center; }
.pill { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 4px 0 12px; border-radius: 999px; color: #ecebf7;
  background: rgba(16, 17, 26, .94); border: 1px solid rgba(${ACCENT}, .5); box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: rgb(${ACCENT}); }
body[data-active] .dot { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.8); } }
kbd { color: rgba(236, 235, 247, .55); font: 500 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
button { height: 22px; padding: 0 10px; border: 0; border-radius: 999px; color: #fff; background: rgba(255, 255, 255, .12);
  font: inherit; cursor: pointer; transition: background-color 120ms ease-out; }
button:hover { background: #e5484d; }
button:active { transform: scale(.96); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style></head><body>
<div class="pill"><span class="dot"></span><span>Computer use</span><kbd>${shortcut}</kbd><button type="button">Stop</button></div>
<script>
window.fate = { active(on) { if (on) document.body.dataset.active = ''; else delete document.body.dataset.active; } };
document.querySelector('button').addEventListener('click', () => { document.title = 'stop:' + Date.now(); });
</script></body></html>`;

interface Surface {
  readonly window: BaseWindow;
  readonly view: WebContentsView;
}

interface FrameSurface extends Surface {
  readonly display: Display;
}

export class ComputerOverlay {
  private frames: FrameSurface[] = [];
  private pill: Surface | null = null;
  private active = false;
  private shown = false;
  private readonly rebuild = () => { if (this.shown) void this.show(); };

  constructor(private readonly shortcutLabel: string, private readonly onStop: () => void) {}

  async show(): Promise<void> {
    this.destroySurfaces();
    if (!this.shown) {
      this.shown = true;
      screen.on('display-added', this.rebuild);
      screen.on('display-removed', this.rebuild);
      screen.on('display-metrics-changed', this.rebuild);
    }
    this.frames = screen.getAllDisplays().map((display) => ({ display, ...createSurface(display.bounds, true) }));
    const primary = screen.getPrimaryDisplay().workArea;
    this.pill = createSurface({
      x: Math.round(primary.x + (primary.width - PILL_WIDTH) / 2),
      y: primary.y + 8,
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
    }, false);
    this.pill.view.webContents.on('page-title-updated', (_event, title) => { if (title.startsWith('stop:')) this.onStop(); });
    await Promise.all([
      ...this.frames.map((frame) => load(frame, frameHtml)),
      load(this.pill, pillHtml(this.shortcutLabel)),
    ]);
    this.setActive(this.active);
  }

  hide(): void {
    this.shown = false;
    screen.off('display-added', this.rebuild);
    screen.off('display-removed', this.rebuild);
    screen.off('display-metrics-changed', this.rebuild);
    this.destroySurfaces();
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const surface of this.surfaces()) run(surface, `fate.active(${active})`);
    if (!active) for (const frame of this.frames) run(frame, 'fate.hide()');
  }

  pointTo(point: { x: number; y: number }, label: string): void {
    for (const frame of this.frames) {
      const local = localPoint(frame.display.bounds, point);
      run(frame, local ? `fate.move(${local.x},${local.y},${JSON.stringify(label)})` : 'fate.hide()');
    }
  }

  ripple(point: { x: number; y: number }): void {
    for (const frame of this.frames) {
      const local = localPoint(frame.display.bounds, point);
      if (local) run(frame, `fate.click(${local.x},${local.y})`);
    }
  }

  async conceal<T>(capture: () => Promise<T>): Promise<T> {
    const surfaces = this.surfaces();
    if (!surfaces.length || captureExcludesProtectedWindows()) return capture();
    const linux = process.platform === 'linux';
    for (const { window } of surfaces) {
      if (linux) window.hide();
      else window.setOpacity(0);
    }
    await new Promise((resolve) => setTimeout(resolve, linux ? 90 : 50));
    try {
      return await capture();
    } finally {
      for (const { window } of surfaces) {
        if (window.isDestroyed()) continue;
        if (linux) window.showInactive();
        else window.setOpacity(1);
      }
    }
  }

  private surfaces(): Surface[] {
    return [...this.frames, ...(this.pill ? [this.pill] : [])].filter(({ window }) => !window.isDestroyed());
  }

  private destroySurfaces(): void {
    for (const { window, view } of this.surfaces()) {
      view.webContents.close();
      window.destroy();
    }
    this.frames = [];
    this.pill = null;
  }
}

function createSurface(bounds: Rectangle, clickThrough: boolean): Surface {
  const window = new BaseWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    thickFrame: false,
    roundedCorners: false,
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setContentProtection(true);
  if (clickThrough) window.setIgnoreMouseEvents(true);
  if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  view.setBackgroundColor('#00000000');
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  window.contentView.addChildView(view);
  return { window, view };
}

async function load(surface: Surface, html: string): Promise<void> {
  await surface.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (!surface.window.isDestroyed()) surface.window.showInactive();
}

function run(surface: Surface, code: string): void {
  if (surface.window.isDestroyed() || surface.view.webContents.isDestroyed()) return;
  void surface.view.webContents.executeJavaScript(code, false).catch(() => undefined);
}

function localPoint(bounds: Rectangle, point: { x: number; y: number }): { x: number; y: number } | null {
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function captureExcludesProtectedWindows(): boolean {
  if (process.platform !== 'win32') return false;
  return Number(os.release().split('.')[2] ?? 0) >= 19041;
}
