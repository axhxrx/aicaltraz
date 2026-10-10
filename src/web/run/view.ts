/** Host state + client-local state → one visual state and the bits needed to draw it. */
import { REQUEUE_GAP_MS, type LastResult, type RunState } from '../../core/machine.ts';
import type { WireButton } from '../../core/protocol.ts';
import { CANCEL_GRACE_MS, type ConnStatus } from '../backend/types.ts';
import { paintColor } from '../lib/color.ts';
import { resultShown, type FlashKind, type Local, type LocalResult, type Via } from './controller.ts';

/**
 * success / failure: how a run ended. stopped: cancelled on purpose (a cancel press, another
 * button's `stops`, removed from the config): neutral, not red. unknown: amber "?", the outcome
 * isn't known (NO RESPONSE; IT RAN when the host no longer knows how). interrupted: amber, the
 * host stopped while it ran.
 */
export type Visual = 'ready' | 'arming' | 'confirm' | 'sending' | 'running' | 'success' | 'failure' | 'stopped' | 'unknown' | 'interrupted' | 'offline';

/** The visuals of a run (or a press) that ended. */
export const RESULTS: readonly Visual[] = ['success', 'failure', 'stopped', 'unknown', 'interrupted'];
export const isResult = (v: Visual | undefined) => !!v && RESULTS.includes(v);

export interface ButtonVM {
  id: string;
  label: string;
  /** The color it is painted with (an unpaintable config color falls back to the default). */
  color: string;
  visual: Visual;
  trigger: WireButton['trigger'];
  holdMs: number;
  confirm: boolean;
  keyHint?: string;
  /** Fill rising (hold in progress), possibly over RUNNING/SUCCESS/FAILURE. */
  arming: { at: number; ms: number } | null;
  disarmAt: number;
  firedAt: number;
  pressed: boolean;
  doubleWait: boolean;
  flash: { kind: FlashKind; at: number; ms?: number } | null;
  /** A press is in flight while the host shows RUNNING (cancel/queue presses). */
  sendingOverlay: boolean;
  /** Local ms timestamps (lib/clock.ts wall()). */
  startedAt?: number;
  endedAt?: number;
  /** Results: how long the run took (absent: not known). */
  elapsedMs?: number;
  progress?: number;
  status?: string;
  cancelHint?: boolean;
  cancelling?: boolean;
  /** RUNNING: a re-run is queued behind this one. */
  queued?: boolean;
  /** A result whose queued re-run starts in a moment. */
  nextQueued?: boolean;
  /** Results: the headline (the reason, ≤ 2 lines). */
  title?: string;
  /** Results: the small print (exit code, what stopped it…). */
  detail?: string;
  /** Results: the short name of how it ended (EXIT 3, TIMEOUT, STOPPED, NO RESPONSE…). */
  code?: string;
  /** SUCCESS: the result text. */
  text?: string;
  /** The countdown bar of a result; absent: it stays. */
  resultHoldMs?: number;
  /** This device keeps it on screen until the next run: a press is a retry; its ✕ clears it. */
  sticky?: boolean;
  confirmUntil?: number;
  confirmMs?: number;
  /** How the confirm step is asked for: the way the first press was made. */
  confirmVerb?: string;
  /** OFFLINE: what the host was last seen doing (ready, running, a result), shown underneath. */
  under?: Visual;
  /** OFFLINE over a run: how long it had run when the host was last heard from (frozen). */
  seenElapsed?: number;
  /** Latched device state (`@state`), e.g. "REC ●": shown in every state. */
  latched?: string;
  /** READY: how the last run ended, and how long ago. */
  last?: { tone: 'ok' | 'bad' | 'stopped' | 'warn'; ago: string };
  /** The run on screen was started on another device. */
  other?: boolean;
}

export const READY: RunState = { phase: 'ready', runId: 0 };

const KEY_NAMES: Record<string, string> = {
  ' ': 'SPACE',
  Enter: '↵',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PG↑',
  PageDown: 'PG↓',
  Home: 'HOME',
  End: 'END',
  Escape: 'ESC',
  Backspace: '⌫',
  Delete: 'DEL',
  Insert: 'INS',
  Tab: 'TAB',
  ContextMenu: 'MENU',
  AudioVolumeUp: 'VOL+',
  AudioVolumeDown: 'VOL−',
  AudioVolumeMute: 'MUTE',
  VolumeUp: 'VOL+',
  VolumeDown: 'VOL−',
  VolumeMute: 'MUTE',
  MediaPlayPause: '⏯',
  MediaPlay: 'PLAY',
  MediaPause: 'PAUSE',
  MediaStop: 'STOP',
  MediaTrackNext: '⏭',
  MediaTrackPrevious: '⏮',
  MediaFastForward: '⏩',
  MediaRewind: '⏪',
  BrowserBack: 'BACK',
  BrowserForward: 'FWD',
  Camera: 'CAMERA',
};
/** A KeyboardEvent.key as a chip shows it: AudioVolumeUp → VOL+, " " → SPACE, ArrowUp → ↑, PageDown → PG↓. */
export const keyName = (k: string) => KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k.toUpperCase().slice(0, 6));

const secs = (ms: number) => `${Number((ms / 1000).toFixed(1))}s`;
/** The hold chip: HOLD, or HOLD 1.5s for holds of a second or more. */
export const holdChip = (holdMs: number) => (holdMs >= 1000 ? `HOLD ${secs(holdMs)}` : 'HOLD');

const VERB: Record<Via, string> = { key: 'PRESS', hold: 'HOLD', tap: 'TAP', double: 'DOUBLE-TAP' };
export const verbOf = (t: WireButton['trigger']) => VERB[t];

/** 12 s ago · 3 m ago · 2 h ago · 4 d ago */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

type Part = Partial<ButtonVM> & { visual: Visual };

/**
 * A failure, by why it failed: the reason as the headline, the code as the small print.
 * `noCode`: the exit code isn't known (rebuilt from READY's `last`).
 */
function failure(s: Extract<RunState, { phase: 'failure' }>, noCode = false): Part {
  const text = s.text?.trim() || undefined;
  switch (s.reason) {
    case 'cancelled':
      return { visual: 'stopped', title: 'STOPPED', detail: text, code: 'STOPPED' };
    case 'interrupted':
      return { visual: 'interrupted', title: 'INTERRUPTED', detail: text ?? 'the host stopped while it ran', code: 'INTERRUPTED' };
    case 'timeout':
      return { visual: 'failure', title: 'TIMEOUT', detail: text, code: 'TIMEOUT' };
    case 'spawn':
      return { visual: 'failure', title: text ?? "CAN'T START", detail: text ? "CAN'T START" : undefined, code: "CAN'T START" };
    default: {
      const code = noCode ? 'FAILED' : s.exitCode === null ? 'KILLED' : `EXIT ${s.exitCode}`;
      return { visual: 'failure', title: text ?? code, detail: text ? code : undefined, code };
    }
  }
}

/** What the host says, as a visual (no client-local states). */
function hostView(b: WireButton, host: RunState, skew: number, now: number): Part {
  if (host.phase === 'running')
    return {
      visual: 'running',
      startedAt: host.startedAt + skew,
      progress: host.progress,
      status: host.status,
      // The host ignores a cancel this soon after the start (it would be a double press): don't offer one yet.
      cancelHint: b.whileRunning === 'cancel' && !host.cancelling && now - (host.startedAt + skew) >= CANCEL_GRACE_MS,
      cancelling: host.cancelling,
      queued: host.queued,
    };
  if (host.phase === 'success' || host.phase === 'failure') {
    const timing: Part = {
      visual: 'success',
      startedAt: host.startedAt + skew,
      endedAt: host.endedAt + skew,
      elapsedMs: host.endedAt - host.startedAt,
      // A queued re-run starts REQUEUE_GAP_MS after the result shows.
      resultHoldMs: host.queued ? REQUEUE_GAP_MS : b.resultHoldMs,
      nextQueued: host.queued,
    };
    if (host.phase === 'success') return { ...timing, text: host.text };
    return { ...timing, ...failure(host) };
  }
  return { visual: 'ready' };
}

/** A result this device keeps on screen (controller.ts LocalResult). */
function localView(r: LocalResult, skew: number): Part {
  switch (r.kind) {
    case 'failure':
    case 'interrupted': {
      const h = r.host!;
      const times = r.fromLast ? { endedAt: h.endedAt + skew } : { startedAt: h.startedAt + skew, endedAt: h.endedAt + skew, elapsedMs: h.endedAt - h.startedAt };
      return { ...failure(h, r.fromLast), ...times, sticky: true };
    }
    case 'noresponse':
      return { visual: 'unknown', title: 'NO RESPONSE', detail: 'The host didn’t answer in 2 s', code: 'NO RESPONSE', endedAt: r.at, sticky: true };
    case 'notsent':
      return { visual: 'failure', title: 'NOT SENT', detail: r.text, code: 'NOT SENT', endedAt: r.at, sticky: true };
    case 'ran': {
      const hold = (r.until ?? r.at) - r.at;
      if (r.last?.ok) return { visual: 'success', text: r.last.text, endedAt: r.at, resultHoldMs: hold };
      return { visual: 'unknown', title: 'IT RAN', detail: 'It finished while the link was down', code: 'IT RAN', endedAt: r.at, resultHoldMs: hold };
    }
  }
}

function lastMark(last: LastResult, skew: number, now: number): ButtonVM['last'] {
  const tone = last.ok ? 'ok' : last.reason === 'cancelled' ? 'stopped' : last.reason === 'interrupted' ? 'warn' : 'bad';
  return { tone, ago: ago(now - (last.endedAt + skew)) };
}

export interface ViewExtra {
  /** Latched device state of this button. */
  latched?: string;
  /** While offline: local time the host was last heard from. */
  lastSeen?: number | null;
}

export function viewOf(b: WireButton, host: RunState, l: Local, link: ConnStatus, skew: number, now: number, extra: ViewExtra = {}): ButtonVM {
  const vm: ButtonVM = {
    id: b.id,
    label: b.label,
    color: paintColor(b.color),
    visual: 'ready',
    trigger: b.trigger,
    holdMs: b.holdMs,
    confirm: b.confirm,
    keyHint: b.key ? keyName(b.key) : undefined,
    arming: l.input === 'arming' ? { at: l.armAt, ms: l.armMs } : null,
    disarmAt: l.disarmAt,
    firedAt: l.firedAt,
    pressed: l.input === 'pressed',
    doubleWait: l.input === 'double',
    flash: l.flash,
    sendingOverlay: false,
    latched: extra.latched || undefined,
  };
  const fromHost = hostView(b, host, skew, now);
  const local = l.result && resultShown(l, host, now) ? localView(l.result, skew) : null;
  // The run on screen was started elsewhere (only runs this device saw start count).
  const other = host.phase !== 'ready' && l.others.includes(host.runId);

  // While first connecting the grid is just dimmed (no grey flash on every page load).
  if (link === 'offline' || link === 'unauthorized') {
    // What was last seen stays visible under the OFFLINE look. A host result runs out when it
    // would have; a run is shown as last seen, its clock stopped there.
    let under: Part = local ?? fromHost;
    if (!local && isResult(fromHost.visual) && now > (fromHost.endedAt ?? 0) + (fromHost.resultHoldMs ?? b.resultHoldMs)) under = { visual: 'ready' };
    const out: ButtonVM = { ...vm, ...under, visual: 'offline', under: under.visual, arming: null, cancelHint: false, sticky: false };
    if (under.visual === 'running') out.seenElapsed = Math.max(0, (extra.lastSeen ?? now) - (under.startedAt ?? now));
    return out;
  }
  const running = fromHost.visual === 'running';
  const c = l.confirm && l.confirm.until > now ? l.confirm : null;
  if (l.sending && !running) return { ...vm, visual: 'sending' };
  // A press on a kept result asked for the confirm step: CONFIRM shows over it (it's back if the window runs out).
  if (local && !c) return { ...vm, ...local };
  if (running) return { ...vm, ...fromHost, sendingOverlay: !!l.sending, other };
  if (c) return { ...vm, visual: 'confirm', confirmUntil: c.until, confirmMs: c.until - c.at, confirmVerb: VERB[c.via] };
  if (fromHost.visual !== 'ready') return { ...vm, ...fromHost, other };
  if (host.phase === 'ready' && host.last) vm.last = lastMark(host.last, skew, now);
  if (vm.arming) vm.visual = 'arming';
  return vm;
}

/** Re-render cadence a VM needs (0 = none): running clocks, the cancel hint's grace, results running out, "12 s ago". */
export function tickFor(vm: ButtonVM, now: number): number {
  const under = vm.visual === 'offline' ? vm.under : vm.visual;
  // Offline: a host result runs out; a run's clock is stopped.
  if (vm.visual === 'offline') return isResult(under) ? 500 : 0;
  if (under === 'running' && vm.startedAt !== undefined) return now - vm.startedAt < 10_000 ? 100 : 500;
  if (vm.last) return vm.last.ago.endsWith(' s ago') ? 1000 : 30_000;
  return 0;
}
