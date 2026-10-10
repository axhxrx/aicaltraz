/** Haptics (navigator.vibrate, iOS switch-tick fallback) and optional WebAudio cues. */
import { settings } from './settings.ts';

export type Cue = 'touch' | 'fire' | 'confirm' | 'success' | 'failure' | 'busy' | 'denied';

const VIBES: Record<Cue, number | number[]> = {
  touch: 8,
  fire: 35,
  confirm: [25, 60, 25],
  success: [40, 70, 40],
  failure: [320],
  busy: [18, 50, 18, 50, 18],
  denied: [70, 50, 70],
};

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
// iOS Safari has no vibrate(), but toggling an <input switch> plays a system haptic tick (iOS 18+).
const isIOS = typeof navigator !== 'undefined' && (/iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
let iosSwitch: HTMLLabelElement | null = null;

export const hapticsSupported = canVibrate || isIOS;

function iosTick(count: number) {
  if (!iosSwitch) {
    iosSwitch = document.createElement('label');
    iosSwitch.setAttribute('aria-hidden', 'true');
    iosSwitch.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    iosSwitch.append(input);
    document.body.append(iosSwitch);
  }
  for (let i = 0; i < count; i++) setTimeout(() => iosSwitch?.click(), i * 90);
}

export function haptic(cue: Cue): void {
  if (!settings.get().haptics) return;
  try {
    if (canVibrate) navigator.vibrate(VIBES[cue]);
    else if (isIOS) iosTick(cue === 'success' || cue === 'confirm' || cue === 'denied' ? 2 : cue === 'busy' ? 3 : 1);
  } catch {
    /* vibrate can throw before the first user activation */
  }
}

let audio: AudioContext | null = null;

/** Call from a user gesture: browsers only allow audio to start inside one. */
export function unlockAudio(): void {
  if (!settings.get().sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

type Tone = [freq: number, startS: number, durS: number, type?: OscillatorType, gain?: number, endFreq?: number];
const TONES: Record<Cue, Tone[]> = {
  touch: [[1400, 0, 0.012, 'square', 0.04]],
  fire: [[880, 0, 0.06, 'square', 0.12]],
  confirm: [[990, 0, 0.07, 'square', 0.1], [990, 0.11, 0.07, 'square', 0.1]],
  success: [[660, 0, 0.09, 'triangle', 0.3], [990, 0.1, 0.16, 'triangle', 0.3]],
  failure: [[220, 0, 0.42, 'sawtooth', 0.16, 140]],
  busy: [[330, 0, 0.06, 'square', 0.1], [330, 0.1, 0.06, 'square', 0.1]],
  denied: [[180, 0, 0.12, 'square', 0.1], [150, 0.15, 0.14, 'square', 0.1]],
};

export function sound(cue: Cue): void {
  if (!settings.get().sound || !audio || audio.state !== 'running') return;
  const t0 = audio.currentTime + 0.005;
  for (const [f, start, dur, type = 'sine', g = 0.2, f2] of TONES[cue]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0 + start);
    if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t0 + start + dur);
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(g, t0 + start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

/** Haptic + sound together, the usual case. */
export function cue(c: Cue): void {
  haptic(c);
  sound(c);
}
