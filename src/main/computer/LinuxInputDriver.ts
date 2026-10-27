import { execFile } from 'node:child_process';
import type { InputDriver, InputStep, MouseButton } from './InputDriver';
import type { KeyName } from './keys';

const keysyms: Record<string, string> = {
  enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', space: 'space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  insert: 'Insert', capslock: 'Caps_Lock', printscreen: 'Print', menu: 'Menu',
  ctrl: 'Control_L', shift: 'Shift_L', alt: 'Alt_L', meta: 'Super_L',
};

const charKeysyms: Record<string, string> = {
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', ';': 'semicolon', '\'': 'apostrophe', ',': 'comma',
  '.': 'period', '/': 'slash', '\\': 'backslash', '`': 'grave', ' ': 'space', '!': 'exclam', '@': 'at', '#': 'numbersign',
  $: 'dollar', '%': 'percent', '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright',
  _: 'underscore', '+': 'plus', '{': 'braceleft', '}': 'braceright', '|': 'bar', ':': 'colon', '"': 'quotedbl', '<': 'less',
  '>': 'greater', '?': 'question', '~': 'asciitilde',
};

const buttonNumbers: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

export class LinuxInputDriver implements InputDriver {
  readonly usesNativePixels = true;
  private queue: Promise<unknown> = Promise.resolve();

  async check(): Promise<string | null> {
    if (!process.env.DISPLAY) return 'Computer use needs an X11 or XWayland display. Pure Wayland sessions are not supported yet.';
    try {
      await xdotool(['version'], 5_000);
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Install xdotool to use computer use, for example: sudo apt install xdotool'
        : `xdotool failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  run(steps: readonly InputStep[]): Promise<void> {
    const next = this.queue.then(() => this.execute(steps));
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {}

  private async execute(steps: readonly InputStep[]): Promise<void> {
    for (const step of steps) {
      if (step.op === 'sleep') await new Promise((resolve) => setTimeout(resolve, step.ms));
      else await xdotool(args(step), 10_000 + (step.op === 'text' ? step.text.length * 20 : 0));
    }
  }
}

function args(step: Exclude<InputStep, { op: 'sleep' }>): string[] {
  if (step.op === 'move') return ['mousemove', String(Math.round(step.x)), String(Math.round(step.y))];
  if (step.op === 'button') return [step.down ? 'mousedown' : 'mouseup', buttonNumbers[step.button]];
  if (step.op === 'key') return [step.down ? 'keydown' : 'keyup', keysym(step.key)];
  if (step.op === 'text') return ['type', '--delay', '6', '--', step.text];
  const vertical = step.dy === 0 ? [] : ['click', '--repeat', String(Math.abs(step.dy)), step.dy > 0 ? '5' : '4'];
  const horizontal = step.dx === 0 ? [] : ['click', '--repeat', String(Math.abs(step.dx)), step.dx > 0 ? '7' : '6'];
  return [...vertical, ...horizontal];
}

function keysym(key: KeyName): string {
  if (typeof key === 'object') return charKeysyms[key.char] ?? key.char;
  return keysyms[key] ?? key.toUpperCase();
}

function xdotool(argv: readonly string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('xdotool', argv, { timeout }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(error);
      reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
    });
  });
}
