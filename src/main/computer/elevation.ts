import { execFileSync, spawn } from 'node:child_process';
import { app } from 'electron';

let cachedElevated: boolean | null = null;

export function isElevated(): boolean {
  if (cachedElevated !== null) return cachedElevated;
  if (process.platform === 'win32') {
    try {
      execFileSync('net', ['session'], { stdio: 'pipe', windowsHide: true });
      cachedElevated = true;
    } catch {
      cachedElevated = false;
    }
  } else {
    cachedElevated = process.getuid?.() === 0;
  }
  return cachedElevated;
}

function launchAndWait(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

export async function relaunchElevated(): Promise<boolean> {
  const exe = process.execPath;
  const args = process.argv.slice(app.isPackaged ? 1 : 2);

  if (process.platform === 'win32') {
    const argList = args.length
      ? ` -ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}`
      : '';
    const launched = await launchAndWait(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs${argList}`],
    );
    if (!launched) return false;
  } else if (process.platform === 'darwin') {
    const escaped = [exe, ...args].map((a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
    const launched = await launchAndWait('osascript', ['-e', `do shell script "${escaped} &" with administrator privileges`]);
    if (!launched) return false;
  } else {
    spawn('pkexec', [exe, ...args], { detached: true, stdio: 'ignore' }).unref();
  }

  app.exit(0);
  return true;
}

const REG_PATH = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const REG_VALUE = 'PromptOnSecureDesktop';
let savedSecureDesktop: number | null = null;

export function disableSecureDesktop(): void {
  if (process.platform !== 'win32' || !isElevated()) return;
  try {
    const out = execFileSync('reg', ['query', REG_PATH, '/v', REG_VALUE], { encoding: 'utf8', windowsHide: true });
    const match = out.match(/REG_DWORD\s+(0x[0-9a-fA-F]+)/);
    savedSecureDesktop = match?.[1] ? parseInt(match[1], 16) : 1;
    if (savedSecureDesktop === 0) return;
    execFileSync('reg', ['add', REG_PATH, '/v', REG_VALUE, '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true });
  } catch {
    savedSecureDesktop = null;
  }
}

export function restoreSecureDesktop(): void {
  if (process.platform !== 'win32' || savedSecureDesktop === null || savedSecureDesktop === 0) return;
  try {
    execFileSync('reg', ['add', REG_PATH, '/v', REG_VALUE, '/t', 'REG_DWORD', '/d', String(savedSecureDesktop), '/f'], { windowsHide: true });
  } catch {}
  savedSecureDesktop = null;
}
