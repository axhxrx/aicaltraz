/** Per-device preferences and small localStorage helpers (all failures tolerated: private mode etc.). */
import { createStore } from './store.ts';

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: settings just won't persist */
  }
}

export function lsJSON<T>(key: string): T | null {
  const raw = lsGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const KEYS = {
  token: 'buttpad.token',
  pad: 'buttpad.pad',
  settings: 'buttpad.settings',
  configCache: 'buttpad.configCache',
  demoConfig: 'buttpad.demo.config',
} as const;

export interface DeviceSettings {
  sound: boolean;
  haptics: boolean;
  keepAwake: boolean;
  /**
   * Rough mode (gloves, a vibrating mount): one button at a time per pad, firmer taps (80 ms),
   * a cooldown of at least 800 ms after each press, and 1.5× the drift tolerance.
   */
  rough: boolean;
}

const DEFAULTS: DeviceSettings = { sound: false, haptics: true, keepAwake: true, rough: false };

/** This browser refuses to store anything (private mode, "block all site data"). */
export const storageBlocked = ((): boolean => {
  try {
    const k = 'buttpad.probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return false;
  } catch {
    return true;
  }
})();

export const settings = createStore<DeviceSettings>({ ...DEFAULTS, ...lsJSON<Partial<DeviceSettings>>(KEYS.settings) });
settings.subscribe((s) => lsSet(KEYS.settings, JSON.stringify(s)));

export function setSetting<K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]): void {
  settings.set((s) => ({ ...s, [key]: value }));
}
