/**
 * Keep the screen on. Wake Lock API when available (secure contexts only, which a LAN http:// page
 * isn't), else a muted inline looping tiny video (the NoSleep trick). Re-acquired on visibility.
 */
import { NOSLEEP_MP4, NOSLEEP_WEBM } from './nosleep-media.ts';
import { settings } from './settings.ts';
import { createStore } from './store.ts';

export type AwakeMode = 'wakelock' | 'video' | 'none';
export interface AwakeStatus {
  mode: AwakeMode;
  active: boolean;
  /** Human-readable status for the menu. */
  note: string;
}

export const awake = createStore<AwakeStatus>({ mode: 'none', active: false, note: 'Starting…' });

let sentinel: WakeLockSentinel | null = null;
let video: HTMLVideoElement | null = null;
let gestureArmed = false;
let started = false;

const wantAwake = () => settings.get().keepAwake;

function set(mode: AwakeMode, active: boolean, note: string) {
  awake.set({ mode, active, note });
}

function ensureVideo(): HTMLVideoElement {
  if (video) return video;
  const v = document.createElement('video');
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.setAttribute('aria-hidden', 'true');
  v.muted = true;
  v.loop = true;
  v.disablePictureInPicture = true;
  // Full-viewport but painted under the opaque app root: browsers only hold the screen for videos
  // they consider visible, and they judge visibility by viewport intersection, not occlusion.
  v.className = 'bp-nosleep';
  for (const [src, type] of [[NOSLEEP_MP4, 'video/mp4'], [NOSLEEP_WEBM, 'video/webm']] as const) {
    const s = document.createElement('source');
    s.src = src;
    s.type = type;
    v.append(s);
  }
  v.addEventListener('playing', () => wantAwake() && set('video', true, 'On · video fallback (no Wake Lock on this page)'));
  v.addEventListener('pause', () => {
    if (awake.get().mode === 'video' && wantAwake() && document.visibilityState === 'visible') {
      set('video', false, 'Paused · tap anywhere to resume');
      armGesture();
    }
  });
  document.body.prepend(v);
  video = v;
  return v;
}

function armGesture() {
  if (gestureArmed) return;
  gestureArmed = true;
  const go = () => {
    gestureArmed = false;
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
    void acquire();
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

async function acquire(): Promise<void> {
  if (!wantAwake()) return set('none', false, 'Off');
  if (document.visibilityState !== 'visible') return;
  if ('wakeLock' in navigator && window.isSecureContext) {
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      video?.pause();
      set('wakelock', true, 'On · Wake Lock');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        if (wantAwake()) set('wakelock', false, 'Released · re-acquiring when visible');
        if (document.visibilityState === 'visible') void acquire();
      });
      return;
    } catch {
      // NotAllowedError (battery saver, no user activation yet...): fall back to the video.
    }
  }
  const v = ensureVideo();
  if (!v.paused) return set('video', true, 'On · video fallback (no Wake Lock on this page)');
  try {
    await v.play();
  } catch {
    set('video', false, 'Waiting · tap anywhere to activate');
    armGesture();
  }
}

function release() {
  void sentinel?.release().catch(() => {});
  sentinel = null;
  video?.pause();
  set('none', false, 'Off');
}

/** Idempotent; follows the device setting from then on. */
export function startKeepAwake(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
  });
  let last = wantAwake();
  settings.subscribe((s) => {
    if (s.keepAwake === last) return;
    last = s.keepAwake;
    if (s.keepAwake) void acquire();
    else release();
  });
  void acquire();
}
