import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getDesktopApiOptional } from '../platform/api';

interface ComputerUseSwitchState {
  supported: boolean;
  on: boolean;
  busy: boolean;
  issue: string | null;
}

let state: ComputerUseSwitchState = { supported: false, on: false, busy: false, issue: null };
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Partial<ComputerUseSwitchState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function load() {
  const desktop = getDesktopApiOptional();
  if (loaded || typeof desktop?.getSettings !== 'function' || typeof desktop.getComputerUseState !== 'function') return;
  loaded = true;
  void desktop.getComputerUseState().then((live) => {
    publish({ supported: live.supported, on: live.enabled, issue: live.issue });
  }).catch(() => { loaded = false; });
  desktop.onComputerUseState((live) => publish({ supported: live.supported, on: live.enabled, issue: live.issue }));
}

async function change(next: boolean) {
  const desktop = getDesktopApiOptional();
  if (!desktop || state.busy) return;
  publish({ busy: true, issue: null });
  try {
    const settings = await desktop.getSettings();
    if (settings.computerUseElevated === next) {
      const live = await desktop.setComputerUseEnabled(next);
      publish({ on: live.enabled, issue: live.issue });
    } else await desktop.setSettings({ ...settings, computerUseElevated: next });
  } catch (error) {
    publish({ issue: error instanceof Error ? error.message : 'Computer use could not be changed.' });
  } finally {
    publish({ busy: false });
  }
}

export function useComputerUseSwitch() {
  useEffect(load, []);
  const current = useSyncExternalStore(subscribe, () => state);
  const toggle = useCallback((next: boolean) => change(next), []);
  return { ...current, toggle };
}
