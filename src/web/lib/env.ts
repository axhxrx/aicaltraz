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
/** The `#token=` this page was opened with, not stored yet: it may be a typo (the app tries it first). */
let incomingToken: string | null = null;
/** See saveFallbackToken. */
let memoryFallback: string | null = null;

/** Takes `#token=` out of the URL (stripped from the address bar); the app decides whether to store it (takeIncomingToken). */
export function takeHashToken(): void {
  incomingToken = readHashToken();
}

/** The `#token=` the page was opened with, once. */
export function takeIncomingToken(): string | null {
  const t = incomingToken;
  incomingToken = null;
  return t;
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

/**
 * The token this device used before a new one that the host couldn't be asked about first (no
 * answer): kept until the host takes the new one, so a rejected new token falls back to it.
 */
export const loadFallbackToken = () => lsGet(KEYS.tokenFallback) ?? memoryFallback;
export function saveFallbackToken(t: string | null): void {
  memoryFallback = t;
  lsSet(KEYS.tokenFallback, t);
}

// ---- clipboard --------------------------------------------------------------------------------

/**
 * Puts `text` on the clipboard; call it right in a tap's handler (browsers want the gesture).
 * Resolves false when it couldn't. A plain-HTTP page has no Clipboard API (it needs a secure
 * context): there, the old way, from a selected text area.
 */
export function copyText(text: string): Promise<boolean> {
  const api = window.isSecureContext ? navigator.clipboard : undefined;
  if (api?.writeText) return api.writeText(text).then(() => true, () => copyBySelection(text));
  return Promise.resolve(copyBySelection(text));
}

function copyBySelection(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  // Off screen, no keyboard, no zoom (iOS zooms into a field under 16 px).
  ta.inputMode = 'none';
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;font-size:16px;opacity:0;';
  const was = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  was?.focus?.({ preventScroll: true });
  return ok;
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
