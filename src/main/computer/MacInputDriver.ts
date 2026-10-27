import { execFile } from 'node:child_process';
import { systemPreferences } from 'electron';
import type { InputDriver, InputStep } from './InputDriver';
import type { KeyName } from './keys';

const script = `
ObjC.import('CoreGraphics');
function run(argv) {
  const steps = JSON.parse(argv[0]);
  const buttons = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] };
  const post = (event) => $.CGEventPost($.kCGHIDEventTap, event);
  let flags = 0;
  for (const s of steps) {
    if (s.op === 'move') {
      const held = s.held ? buttons[s.held] : null;
      const event = $.CGEventCreateMouseEvent(null, held ? held[2] : 5, { x: s.x, y: s.y }, held ? held[3] : 0);
      $.CGEventSetFlags(event, flags);
      post(event);
    } else if (s.op === 'button') {
      const button = buttons[s.button];
      const event = $.CGEventCreateMouseEvent(null, s.down ? button[0] : button[1], $.CGEventGetLocation($.CGEventCreate(null)), button[3]);
      $.CGEventSetIntegerValueField(event, 1, s.clicks);
      $.CGEventSetFlags(event, flags);
      post(event);
    } else if (s.op === 'scroll') {
      const event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, s.dy, s.dx, 0);
      $.CGEventSetFlags(event, flags);
      post(event);
    } else if (s.op === 'key') {
      if (s.flag) flags = s.down ? (flags | s.flag) : (flags & ~s.flag);
      const event = $.CGEventCreateKeyboardEvent(null, s.code, s.down);
      $.CGEventSetFlags(event, flags | (s.shift ? 0x20000 : 0));
      post(event);
    } else if (s.op === 'text') {
      const events = Application('System Events');
      s.text.split('\\n').forEach((part, index) => {
        if (index) events.keyCode(36);
        if (part) events.keystroke(part);
      });
    } else if (s.op === 'sleep') {
      delay(s.ms / 1000);
    }
  }
  return 'ok';
}
`;

const namedCodes: Record<string, number> = {
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117, capslock: 57, menu: 110, printscreen: 105, insert: 114,
  home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  ctrl: 59, shift: 56, alt: 58, meta: 55,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

const modifierFlags: Record<string, number> = { ctrl: 0x40000, shift: 0x20000, alt: 0x80000, meta: 0x100000 };

const charCodes: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, l: 37, j: 38, '\'': 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50, ' ': 49,
};

const shiftedChars: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': '\'', '<': ',', '>': '.', '?': '/',
};

export class MacInputDriver implements InputDriver {
  readonly usesNativePixels = false;
  private queue: Promise<unknown> = Promise.resolve();

  async check(): Promise<string | null> {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      return 'Allow Fate UI in System Settings › Privacy & Security › Accessibility, then turn computer use on again.';
    }
    return null;
  }

  run(steps: readonly InputStep[]): Promise<void> {
    const next = this.queue.then(() => this.execute(steps));
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {}

  private execute(steps: readonly InputStep[]): Promise<void> {
    const typed = steps.reduce((total, step) => total + (step.op === 'text' ? step.text.length : 0), 0);
    const waited = steps.reduce((total, step) => total + (step.op === 'sleep' ? step.ms : 0), 0);
    const payload = JSON.stringify(steps.map(toWire));
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', script, payload], { timeout: 15_000 + typed * 40 + waited }, (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = String(stderr || error.message).trim();
        reject(new Error(/not allowed|1002|assistive/iu.test(detail)
          ? 'macOS blocked keyboard input. Allow Fate UI in System Settings › Privacy & Security › Accessibility.'
          : `macOS input failed: ${detail.slice(0, 300)}`));
      });
    });
  }
}

function toWire(step: InputStep): Record<string, unknown> {
  if (step.op === 'key') return { op: 'key', down: step.down, ...keyCode(step.key) };
  if (step.op === 'scroll') return { op: 'scroll', dx: -step.dx * 3, dy: -step.dy * 3 };
  return step;
}

function keyCode(key: KeyName): { code: number; flag?: number; shift?: boolean } {
  if (typeof key === 'string') {
    const code = namedCodes[key];
    if (code === undefined) throw new Error(`The ${key} key is not available on macOS.`);
    const flag = modifierFlags[key];
    return flag ? { code, flag } : { code };
  }
  const lower = key.char.toLowerCase();
  const base = shiftedChars[key.char] ?? lower;
  const code = charCodes[base];
  if (code === undefined) throw new Error(`"${key.char}" cannot be pressed as a key on macOS. Use the type action for text.`);
  return { code, shift: base !== key.char };
}
