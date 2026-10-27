import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { InputDriver, InputStep } from './InputDriver';
import type { KeyName } from './keys';

const STARTUP_TIMEOUT_MS = 20_000;

const helperSource = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class FateInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
    SetProcessDPIAware();
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) {
      throw new InvalidOperationException("Windows rejected the input. A secure desktop or locked screen may be active.");
    }
  }

  static INPUT Mouse(uint flags, uint data) {
    INPUT input = new INPUT();
    input.type = 0;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = data;
    return input;
  }

  static INPUT Keyboard(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = 1;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  public static void Move(int x, int y) {
    SetCursorPos(x, y);
    Send(Mouse(0x0001, 0));
  }

  public static void Button(string button, bool down) {
    uint flags = button == "right" ? (down ? 0x0008u : 0x0010u) : button == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(Mouse(flags, 0));
  }

  public static void Scroll(int dx, int dy) {
    if (dy != 0) Send(Mouse(0x0800, unchecked((uint)(dy * 120))));
    if (dx != 0) Send(Mouse(0x1000, unchecked((uint)(dx * 120))));
  }

  public static void Key(int vk, bool extended, bool down) {
    Send(Keyboard((ushort)vk, (ushort)MapVirtualKeyW((uint)vk, 0), (extended ? 0x0001u : 0u) | (down ? 0u : 0x0002u)));
  }

  public static void Char(string text, bool down) {
    char ch = text[0];
    short mapped = VkKeyScanW(ch);
    if (mapped == -1 || (mapped & 0x600) != 0) { Unicode(ch, down); return; }
    int vk = mapped & 0xff;
    bool shift = (mapped & 0x100) != 0;
    if (down) {
      if (shift) Key(0x10, false, true);
      Key(vk, false, true);
    } else {
      Key(vk, false, false);
      if (shift) Key(0x10, false, false);
    }
  }

  static void Unicode(char ch, bool down) {
    Send(Keyboard(0, ch, 0x0004u | (down ? 0u : 0x0002u)));
  }

  public static void Text(string text) {
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { Key(0x0D, false, true); Key(0x0D, false, false); }
      else if (ch == '\t') { Key(0x09, false, true); Key(0x09, false, false); }
      else { Unicode(ch, true); Unicode(ch, false); }
      Thread.Sleep(4);
    }
  }
}
`;

const helperScript = [
  '$ErrorActionPreference = "Stop"',
  `Add-Type -Language CSharp -TypeDefinition @'${helperSource}'@`,
  '[FateInput]::Init()',
  '[Console]::Out.WriteLine("ready")',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  try {',
  '    foreach ($s in (ConvertFrom-Json $line)) {',
  '      switch ($s.op) {',
  '        "move" { [FateInput]::Move([int]$s.x, [int]$s.y) }',
  '        "button" { [FateInput]::Button([string]$s.button, [bool]$s.down) }',
  '        "scroll" { [FateInput]::Scroll([int]$s.dx, [int]$s.dy) }',
  '        "vk" { [FateInput]::Key([int]$s.vk, [bool]$s.ext, [bool]$s.down) }',
  '        "char" { [FateInput]::Char([string]$s.ch, [bool]$s.down) }',
  '        "text" { [FateInput]::Text([string]$s.text) }',
  '        "sleep" { Start-Sleep -Milliseconds ([int]$s.ms) }',
  '      }',
  '    }',
  '    [Console]::Out.WriteLine("ok")',
  '  } catch {',
  '    [Console]::Out.WriteLine("error " + ($_.Exception.Message -replace "\\s+", " "))',
  '  }',
  '}',
].join('\n');

const virtualKeys: Record<string, readonly [number, boolean]> = {
  enter: [0x0d, false], tab: [0x09, false], escape: [0x1b, false], backspace: [0x08, false], delete: [0x2e, true], space: [0x20, false],
  up: [0x26, true], down: [0x28, true], left: [0x25, true], right: [0x27, true], home: [0x24, true], end: [0x23, true],
  pageup: [0x21, true], pagedown: [0x22, true], insert: [0x2d, true], capslock: [0x14, false], printscreen: [0x2c, true], menu: [0x5d, true],
  ctrl: [0x11, false], shift: [0x10, false], alt: [0x12, false], meta: [0x5b, true],
};

type Pending = { resolve: (line: string) => void; reject: (error: Error) => void };

export class WindowsInputDriver implements InputDriver {
  readonly usesNativePixels = true;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started: Promise<void> | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = '';

  async check(): Promise<string | null> {
    try {
      await this.start();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  run(steps: readonly InputStep[]): Promise<void> {
    const next = this.queue.then(() => this.send(steps));
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.started = null;
    this.pending?.reject(new Error('Computer use stopped.'));
    this.pending = null;
    child?.kill();
  }

  private async send(steps: readonly InputStep[]): Promise<void> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('The Windows input helper is not running.');
    const typed = steps.reduce((total, step) => total + (step.op === 'text' ? step.text.length : 0), 0);
    const waited = steps.reduce((total, step) => total + (step.op === 'sleep' ? step.ms : 0), 0);
    const line = await this.request(child, asciiJson(steps.map(toWire)), 10_000 + typed * 12 + waited);
    if (line !== 'ok') throw new Error(line.replace(/^error\s*/u, '') || 'The Windows input helper failed.');
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(helperScript, 'utf16le').toString('base64')], { windowsHide: true });
    this.child = child;
    this.stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2_000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(line.trim());
    });
    child.on('error', (error) => this.fail(child, error));
    child.on('exit', (code) => this.fail(child, new Error(`The Windows input helper exited (${code ?? 'signal'}). ${this.stderr.trim()}`.trim())));
    const started = this.request(child, null, STARTUP_TIMEOUT_MS).then((line) => {
      if (line !== 'ready') throw new Error(`The Windows input helper did not start: ${line}`);
    });
    this.started = started;
    started.catch(() => { if (this.child === child) this.dispose(); });
    return started;
  }

  private request(child: ChildProcessWithoutNullStreams, line: string | null, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending !== entry) return;
        this.pending = null;
        reject(new Error('The Windows input helper timed out.'));
        if (this.child === child) this.dispose();
      }, timeoutMs);
      const entry: Pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.pending = entry;
      if (line !== null) child.stdin.write(`${line}\n`);
    });
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.started = null;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

function toWire(step: InputStep): Record<string, unknown> {
  if (step.op === 'key') return keyWire(step.key, step.down);
  if (step.op === 'button') return { op: 'button', button: step.button, down: step.down };
  if (step.op === 'move') return { op: 'move', x: Math.round(step.x), y: Math.round(step.y) };
  if (step.op === 'scroll') return { op: 'scroll', dx: step.dx, dy: -step.dy };
  return step;
}

function keyWire(key: KeyName, down: boolean): Record<string, unknown> {
  if (typeof key === 'object') return { op: 'char', ch: key.char, down };
  const known = virtualKeys[key];
  if (known) return { op: 'vk', vk: known[0], ext: known[1], down };
  return { op: 'vk', vk: 0x6f + Number(key.slice(1)), ext: false, down };
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
