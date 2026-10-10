/** URL options, pairing token, fullscreen, and the locked-down touch environment. */
import { KEYS, lsGet, lsSet } from './settings.ts';
import { createStore } from './store.ts';

export interface AppOptions {
  /** `?demo`: in-browser backend, no host needed. */
  demo: boolean;
  /** `?pad=ID`: open this pad. */
  pad: string | null;
  /** `?lock`: no pad tabs, no edit entry (kiosk / handlebar mount). */
  lock: boolean;
  /** `?demo&exact`: no random durations or failures in the demo (tests). */
  exact: boolean;
  /** `?gallery`: every button state side by side (design QA). */
  gallery: boolean;
}

export function readOptions(search = location.search): AppOptions {
  const q = new URLSearchParams(search);
  const flag = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  return { demo: flag('demo') || flag('gallery'), pad: q.get('pad'), lock: flag('lock'), exact: flag('exact'), gallery: flag('gallery') };
}

/** Accepts a pairing URL (`…#token=X`), a bare `#token=X`, or a raw token. */
export function parseToken(input: string): string | null {
  const s = input.trim();
  const m = /[#&?]token=([^&\s#]+)/.exec(s);
  const t = m ? decodeURIComponent(m[1]!) : s;
  return /^[\w-]{8,}={0,2}$/.test(t) ? t : null;
}

/** Moves `#token=` from the URL into storage and strips it from the address bar. */
export function takeHashToken(): void {
  if (!location.hash.includes('token=')) return;
  const t = parseToken(location.hash);
  if (t) lsSet(KEYS.token, t);
  history.replaceState(null, '', location.pathname + location.search);
}

export const loadToken = () => lsGet(KEYS.token);
export const saveToken = (t: string | null) => lsSet(KEYS.token, t);

// ---- fullscreen -------------------------------------------------------------------------------

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const fsDoc = () => document as FsDoc;

export const fullscreenSupported = () => !!(fsDoc().fullscreenEnabled || fsDoc().webkitFullscreenEnabled);
export const isFullscreen = createStore(false);

export async function toggleFullscreen(): Promise<void> {
  const d = fsDoc();
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    else {
      const el = document.documentElement as FsEl;
      await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    }
  } catch {
    /* denied: nothing to do */
  }
}

// ---- lockdown ---------------------------------------------------------------------------------

const editable = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, [contenteditable], [data-selectable]');

/** No zoom, no callouts, no context menu, no selection, no pull-to-refresh (CSS does the rest). */
export function lockdown(): void {
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener('contextmenu', (e) => !editable(e.target) && e.preventDefault());
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop, { passive: false });
  document.addEventListener('selectstart', (e) => !editable(e.target) && e.preventDefault());
  document.addEventListener('dblclick', stop, { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.touches.length > 1 || !el?.closest('[data-scroll], [data-scroll-x]')) e.preventDefault();
    },
    { passive: false },
  );
  const sync = () => isFullscreen.set(!!(fsDoc().fullscreenElement || fsDoc().webkitFullscreenElement));
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

// ---- time -------------------------------------------------------------------------------------

/** 0.4s · 9.9s · 12s · 1:05 · 1:02:03 */
export function fmtElapsed(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return m < 60 ? `${m}:${ss}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}`;
}
