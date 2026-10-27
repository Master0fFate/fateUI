import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron';
import type { ComputerActionInput, ComputerActionOutput, ComputerUsePort, LogPort } from '../../core/ports';
import type { ComputerUseState } from '../../shared/contracts/ipc';
import { ComputerOverlay } from './ComputerOverlay';
import { disableSecureDesktop, isElevated, restoreSecureDesktop } from './elevation';
import type { InputDriver, InputStep, MouseButton } from './InputDriver';
import { parseKeyCombo, parseKeySequence, parseModifiers, type KeyCombo, type Modifier } from './keys';
import { LinuxInputDriver } from './LinuxInputDriver';
import { MacInputDriver } from './MacInputDriver';
import { captureRegion, captureScreen, fromScreenPoint, orderedDisplays, screenTarget, toScreenPoint, type ScreenTarget } from './ScreenCapture';
import { WindowsInputDriver } from './WindowsInputDriver';

const STOP_ACCELERATOR = 'Alt+Shift+Escape';
const STOP_LABEL = process.platform === 'darwin' ? '⌥⇧Esc' : 'Alt+Shift+Esc';
const SETTLE_MS = 450;
const POINTER_TRAVEL_MS = 220;
const IDLE_AFTER_MS = 2_500;
const TEXT_CHUNK = 200;
const SUPPORTED = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';

type Point = { x: number; y: number };

const clickCounts: Partial<Record<ComputerActionInput['action'], [MouseButton, number, string]>> = {
  left_click: ['left', 1, 'Click'],
  right_click: ['right', 1, 'Right click'],
  middle_click: ['middle', 1, 'Middle click'],
  double_click: ['left', 2, 'Double click'],
  triple_click: ['left', 3, 'Triple click'],
};

export class ComputerUseService implements ComputerUsePort {
  private enabled = false;
  private active = false;
  private issue: string | null = null;
  private driver: InputDriver | null = null;
  private overlay: ComputerOverlay | null = null;
  private stop = new AbortController();
  private actions: Promise<unknown> = Promise.resolve();
  private toggles: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private displayId: number | null = null;
  private heldButton: MouseButton | null = null;
  private readonly listeners = new Set<(state: ComputerUseState) => void>();

  constructor(private readonly logs: LogPort) {
    app.on('browser-window-created', (_event, window) => window.once('closed', () => {
      if (this.enabled && !BrowserWindow.getAllWindows().some((candidate) => candidate instanceof BrowserWindow && !candidate.isDestroyed())) void this.setEnabled(false);
    }));
  }

  getState(): ComputerUseState {
    return { supported: SUPPORTED, enabled: this.enabled, active: this.active, elevated: isElevated(), issue: this.issue, stopShortcut: STOP_LABEL };
  }

  onState(listener: (state: ComputerUseState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): Promise<ComputerUseState> {
    const next = this.toggles.then(() => enabled ? this.turnOn() : this.turnOff());
    this.toggles = next.catch(() => undefined);
    return next.then(() => this.getState());
  }

  perform(input: ComputerActionInput, signal?: AbortSignal): Promise<ComputerActionOutput> {
    const next = this.actions.then(() => this.execute(input, signal));
    this.actions = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    if (this.enabled) this.shutdown();
  }

  private async turnOn(): Promise<void> {
    if (this.enabled) return;
    const driver = driverFor();
    if (!driver) return this.publish({ issue: 'Computer use is not available on this platform.' });
    const issue = await driver.check() ?? await screenCaptureIssue();
    if (issue) {
      driver.dispose();
      return this.publish({ issue });
    }
    this.driver = driver;
    this.stop = new AbortController();
    if (process.platform === 'win32' && isElevated()) disableSecureDesktop();
    this.overlay = new ComputerOverlay(STOP_LABEL, () => void this.setEnabled(false));
    try {
      await this.overlay.show();
    } catch (error) {
      this.logs.write('warn', 'computer-use', `The computer use overlay could not be shown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!globalShortcut.register(STOP_ACCELERATOR, () => void this.setEnabled(false))) {
      this.logs.write('warn', 'computer-use', `${STOP_ACCELERATOR} is taken by another app; use the Stop button instead.`);
    }
    this.enabled = true;
    this.publish({ issue: null });
  }

  private async turnOff(): Promise<void> {
    if (!this.enabled) return;
    const held = this.heldButton;
    this.heldButton = null;
    if (held) await this.driver?.run([{ op: 'button', button: held, down: false, clicks: 1 }]).catch(() => undefined);
    this.shutdown();
    this.publish({ issue: null });
  }

  private shutdown(): void {
    this.enabled = false;
    this.stop.abort();
    if (globalShortcut.isRegistered(STOP_ACCELERATOR)) globalShortcut.unregister(STOP_ACCELERATOR);
    this.overlay?.hide();
    this.overlay = null;
    this.driver?.dispose();
    this.driver = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.active = false;
    restoreSecureDesktop();
  }

  private publish(change: { issue: string | null }): void {
    this.issue = change.issue;
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private setActive(active: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.active === active) return;
    this.active = active;
    this.overlay?.setActive(active);
    this.publish({ issue: this.issue });
  }

  private async execute(input: ComputerActionInput, outer?: AbortSignal): Promise<ComputerActionOutput> {
    const driver = this.driver;
    if (!this.enabled || !driver) throw new Error('Computer use is off. Ask the user to turn it on from the composer.');
    const signal = outer ? AbortSignal.any([outer, this.stop.signal]) : this.stop.signal;
    this.setActive(true);
    try {
      return await this.dispatch(driver, input, signal);
    } catch (error) {
      if (this.stop.signal.aborted) throw new Error('The user stopped computer use. Do not continue the task on screen.');
      throw error;
    } finally {
      if (this.enabled) this.idleTimer = setTimeout(() => this.setActive(false), IDLE_AFTER_MS);
    }
  }

  private async dispatch(driver: InputDriver, input: ComputerActionInput, signal: AbortSignal): Promise<ComputerActionOutput> {
    const target = this.target(input.display);
    const click = clickCounts[input.action];
    if (click) {
      const [button, count, label] = click;
      const point = await this.pointer(driver, target, input.coordinate, label, signal);
      const modifiers = parseModifiers(input.text);
      const presses = Array.from({ length: count }, (_, index): InputStep[] => [
        { op: 'button', button, down: true, clicks: index + 1 },
        { op: 'button', button, down: false, clicks: index + 1 },
      ]).flat();
      this.overlay?.ripple(point);
      await driver.run([...modifierSteps(modifiers, true), ...presses, ...modifierSteps(modifiers, false)]);
      return this.settle(target, `${label} at ${describe(target, point)}.`, signal);
    }
    switch (input.action) {
      case 'list_displays':
        return { text: describeDisplays(), display: target.number };
      case 'screenshot':
        return this.observe(target, `Screenshot of display ${target.number}.`);
      case 'zoom': {
        if (!input.region) throw new Error('zoom needs region [x1, y1, x2, y2].');
        const region = input.region;
        const image = await this.conceal(() => captureRegion(target, region));
        return { text: `Zoomed into [${input.region.join(', ')}] of display ${target.number}. Keep using coordinates from regular screenshots.`, display: target.number, image };
      }
      case 'cursor_position': {
        const cursor = screen.getCursorScreenPoint();
        const index = orderedDisplays().findIndex((display) => display.id === screen.getDisplayNearestPoint(cursor).id);
        const current = screenTarget(orderedDisplays()[index]!, index + 1);
        const [x, y] = fromScreenPoint(current, cursor);
        return { text: `Cursor at (${x}, ${y}) on display ${current.number}.`, display: current.number };
      }
      case 'mouse_move': {
        const point = await this.pointer(driver, target, required(input.coordinate, 'mouse_move needs coordinate.'), 'Move', signal);
        return this.settle(target, `Moved to ${describe(target, point)}.`, signal);
      }
      case 'left_click_drag': {
        const end = toScreenPoint(target, required(input.coordinate, 'left_click_drag needs coordinate.'));
        const start = await this.pointer(driver, target, input.startCoordinate, 'Drag', signal);
        this.overlay?.pointTo(end, 'Drag');
        const path = Array.from({ length: 12 }, (_, index): InputStep[] => {
          const progress = (index + 1) / 12;
          const point = this.native(driver, { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress });
          return [{ op: 'move', ...point, held: 'left' }, { op: 'sleep', ms: 16 }];
        }).flat();
        await driver.run([{ op: 'button', button: 'left', down: true, clicks: 1 }, { op: 'sleep', ms: 60 }, ...path, { op: 'sleep', ms: 60 }, { op: 'button', button: 'left', down: false, clicks: 1 }]);
        return this.settle(target, `Dragged from ${describe(target, start)} to ${describe(target, end)}.`, signal);
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        const down = input.action === 'left_mouse_down';
        const point = await this.pointer(driver, target, input.coordinate, down ? 'Press' : 'Release', signal);
        await driver.run([{ op: 'button', button: 'left', down, clicks: 1 }]);
        this.heldButton = down ? 'left' : null;
        return this.settle(target, `Left button ${down ? 'pressed' : 'released'} at ${describe(target, point)}.`, signal);
      }
      case 'scroll': {
        const direction = input.scrollDirection ?? 'down';
        const amount = input.scrollAmount ?? 3;
        const point = await this.pointer(driver, target, input.coordinate, `Scroll ${direction}`, signal);
        const modifiers = parseModifiers(input.text);
        const delta = { dx: direction === 'left' ? -amount : direction === 'right' ? amount : 0, dy: direction === 'up' ? -amount : direction === 'down' ? amount : 0 };
        await driver.run([...modifierSteps(modifiers, true), { op: 'scroll', ...delta }, ...modifierSteps(modifiers, false)]);
        return this.settle(target, `Scrolled ${direction} ${amount} at ${describe(target, point)}.`, signal);
      }
      case 'type': {
        const text = required(input.text, 'type needs text.');
        this.overlay?.pointTo(screen.getCursorScreenPoint(), 'Type');
        const characters = [...text];
        for (let start = 0; start < characters.length; start += TEXT_CHUNK) {
          signal.throwIfAborted();
          await driver.run([{ op: 'text', text: characters.slice(start, start + TEXT_CHUNK).join('') }]);
        }
        return this.settle(target, `Typed ${characters.length} characters.`, signal);
      }
      case 'key': {
        const keys = required(input.text, 'key needs text, for example "ctrl+s".');
        const sequence = parseKeySequence(keys);
        this.overlay?.pointTo(screen.getCursorScreenPoint(), keys);
        await driver.run(sequence.flatMap((combo, index) => [...(index ? [{ op: 'sleep', ms: 40 } as const] : []), ...comboSteps(combo, true), ...comboSteps(combo, false)]));
        return this.settle(target, `Pressed ${keys}.`, signal);
      }
      case 'hold_key': {
        const combo = parseKeyCombo(required(input.text, 'hold_key needs text, for example "shift".'));
        const seconds = Math.min(input.duration ?? 1, 10);
        this.overlay?.pointTo(screen.getCursorScreenPoint(), `Hold ${input.text}`);
        await driver.run([...comboSteps(combo, true), { op: 'sleep', ms: Math.round(seconds * 1000) }, ...comboSteps(combo, false)]);
        return this.settle(target, `Held ${input.text} for ${seconds}s.`, signal);
      }
      case 'wait': {
        const seconds = input.duration ?? 1;
        await delay(seconds * 1000, signal);
        return this.observe(target, `Waited ${seconds}s.`);
      }
      default:
        throw new Error(`Unknown computer action ${input.action}.`);
    }
  }

  private target(number: number | undefined): ScreenTarget {
    const displays = orderedDisplays();
    if (number !== undefined) {
      const display = displays[number - 1];
      if (!display) throw new Error(`Display ${number} does not exist. ${describeDisplays()}`);
      this.displayId = display.id;
      return screenTarget(display, number);
    }
    const index = Math.max(0, displays.findIndex((display) => display.id === this.displayId));
    return screenTarget(displays[index]!, index + 1);
  }

  private async pointer(driver: InputDriver, target: ScreenTarget, coordinate: readonly [number, number] | undefined, label: string, signal: AbortSignal): Promise<Point> {
    if (!coordinate) {
      const current = screen.getCursorScreenPoint();
      this.overlay?.pointTo(current, label);
      return current;
    }
    const point = toScreenPoint(target, coordinate);
    this.overlay?.pointTo(point, label);
    await delay(POINTER_TRAVEL_MS, signal);
    await driver.run([{ op: 'move', ...this.native(driver, point), held: this.heldButton }]);
    return point;
  }

  private native(driver: InputDriver, point: Point): Point {
    return driver.usesNativePixels ? screen.dipToScreenPoint(point) : point;
  }

  private async settle(target: ScreenTarget, text: string, signal: AbortSignal): Promise<ComputerActionOutput> {
    await delay(SETTLE_MS, signal);
    return this.observe(target, text);
  }

  private async observe(target: ScreenTarget, text: string): Promise<ComputerActionOutput> {
    const image = await this.conceal(() => captureScreen(target));
    return { text: `${text}\nDisplay ${target.number} screenshot, ${target.width}×${target.height}.`, display: target.number, image };
  }

  private conceal<T>(capture: () => Promise<T>): Promise<T> {
    return this.overlay ? this.overlay.conceal(capture) : capture();
  }
}

function driverFor(): InputDriver | null {
  if (process.platform === 'win32') return new WindowsInputDriver();
  if (process.platform === 'darwin') return new MacInputDriver();
  if (process.platform === 'linux') return new LinuxInputDriver();
  return null;
}

async function screenCaptureIssue(): Promise<string | null> {
  if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted') return null;
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
  return 'Allow Fate UI in System Settings › Privacy & Security › Screen Recording, then restart Fate UI.';
}

function modifierSteps(modifiers: readonly Modifier[], down: boolean): InputStep[] {
  const ordered = down ? modifiers : [...modifiers].reverse();
  return ordered.map((key) => ({ op: 'key', key, down }));
}

function comboSteps(combo: KeyCombo, down: boolean): InputStep[] {
  const key: InputStep[] = combo.key ? [{ op: 'key', key: combo.key, down }] : [];
  return down ? [...modifierSteps(combo.modifiers, true), ...key] : [...key, ...modifierSteps(combo.modifiers, false)];
}

function describe(target: ScreenTarget, point: Point): string {
  const [x, y] = fromScreenPoint(target, point);
  return `(${x}, ${y})`;
}

function describeDisplays(): string {
  return orderedDisplays().map((display, index) => {
    const target = screenTarget(display, index + 1);
    return `Display ${index + 1}${index === 0 ? ' (primary)' : ''}: ${display.bounds.width}×${display.bounds.height} at ${Math.round(display.scaleFactor * 100)}% scale, screenshots ${target.width}×${target.height}.`;
  }).join('\n');
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === '') throw new Error(message);
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
