/** URL options, pairing token, fullscreen, and the locked-down touch environment. */
import { KEYS, lsGet, lsSet } from './settings.ts';
import { createStore } from './store.ts';

export interface AppOptions {
  /** `?demo`: in-browser backend, no host needed. */
  demo: boolean;
  /** `?pad=ID` (or its name, any case): open this pad, and only it — never silently another one. */
  pad: string | null;
  /** `?lock`: no pad tabs, no edit entry, the menu only on a long press (kiosk / handlebar mount). */
  lock: boolean;
  /** `?demo&exact`: no random durations or failures in the demo (tests). */
  exact: boolean;
  /** `?gallery`: every button state side by side (design QA). */
  gallery: boolean;
}

export function readOptions(search = location.search): AppOptions {
  const q = new URLSearchParams(search);
  const flag = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  return { demo: flag('demo') || flag('gallery'), pad: q.get('pad')?.trim() || null, lock: flag('lock'), exact: flag('exact'), gallery: flag('gallery') };
}

/** Accepts a pairing URL (`…#token=X`), a bare `#token=X`, or a raw token. */
export function parseToken(input: string): string | null {
  const s = input.trim();
  const m = /[#&?]token=([^&\s#]+)/.exec(s);
  const t = m ? decodeURIComponent(m[1]!) : s;
  return /^[\w-]{8,}={0,2}$/.test(t) ? t : null;
}

/**
 * The token for this tab, when storage is blocked: pairing then lasts until the tab closes (the
 * app says so) rather than not working at all.
 */
let memoryToken: string | null = null;

/** Moves `#token=` from the URL into storage and strips it from the address bar. */
export function takeHashToken(): void {
  const t = readHashToken();
  if (t) saveToken(t);
}

/** The `#token=` in the URL, stripped from the address bar (not stored). */
export function readHashToken(): string | null {
  if (!location.hash.includes('token=')) return null;
  const t = parseToken(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  return t;
}

export const loadToken = () => lsGet(KEYS.token) ?? memoryToken;
export function saveToken(t: string | null): void {
  memoryToken = t;
  lsSet(KEYS.token, t);
}

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

/** Monotonic ms (the clock of event timestamps). */
export const mono = (): number => performance.now();

/**
 * When an input event happened, on the `mono()` clock. That's `timeStamp` in current browsers;
 * an engine that stamps events with epoch ms (or not at all) gets "now".
 */
export function eventTime(e: { timeStamp: number }): number {
  const now = mono();
  const t = e.timeStamp;
  return t > 0 && t <= now + 50 && now - t < 60_000 ? t : now;
}

const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const queued: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => queued.shift()?.();

/** Run `fn` as a new task, after whatever is already queued. */
export function nextTask(fn: () => void): void {
  if (!channel) return void setTimeout(fn, 0);
  queued.push(fn);
  channel.port2.postMessage(0);
}

/**
 * Run `fn` once input and messages that queued up during a stall have landed: a timer that fires
 * late uses it before it decides anything. One task isn't enough. After a long task Chromium hands
 * queued touch input to the page after the next frame or two (measured: 2–15 ms after the stall,
 * behind rAF callbacks, posted messages and setTimeout 0). So: two frames and at least `minMs`,
 * then a task. Hidden pages get no frames, hence the fallback timeout.
 */
export function afterQueuedInput(fn: () => void, minMs = 80): void {
  const start = mono();
  let frames = 0;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    nextTask(fn);
  };
  const frame = () => {
    if (++frames < 2) return void requestAnimationFrame(frame);
    setTimeout(go, Math.max(0, minMs - (mono() - start)));
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
  setTimeout(go, minMs + 250);
}
