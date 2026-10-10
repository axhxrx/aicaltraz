/**
 * Client-side half of a button: turns pointer/key input into fires (hold/tap/double, drift,
 * confirm, cooldown) and owns the client-only states (ARMING, CONFIRM, SENDING, flashes, and the
 * results this device keeps on screen until touched). Host state stays authoritative; this only
 * decorates it. Framework-free; one per button for the whole session (run/session.ts), so the
 * outcome of a press still buzzes after switching pads.
 *
 * Gesture timing goes by the input events' own timestamps (mono()), not by when a handler got to
 * run: on a stalled main thread a finger lifted before holdMs must not fire, and one held past it
 * must. Everything shown with a time uses wall() (lib/clock.ts).
 *
 * Which runs are this device's: only the ones an ack says it started (or queued). A run that
 * shows up with no ack of ours behind it is another device's: no outcome buzz, a small mark.
 * Run ids that go backwards (a host that started over without its state file, the demo's Reset)
 * mean the runs remembered here are gone: that memory starts over.
 */
import type { LastResult, RunState } from '../../core/machine.ts';
import { PRESS_MAX_AGE_MS, type PressResult, type WireButton } from '../../core/protocol.ts';
import { PressError, type PressAck } from '../backend/types.ts';
import { wall } from '../lib/clock.ts';
import { afterQueuedInput, mono } from '../lib/env.ts';
import { cue, haptic, unlockAudio } from '../lib/feedback.ts';
import { createStore } from '../lib/store.ts';

export const DOUBLE_TAP_MS = 400;
export const ACK_TIMEOUT_MS = 2000;
/** A tap held longer than this is a resting thumb, not a tap: letting go doesn't fire. */
export const TAP_MAX_MS = 1500;
/** A tap shorter than this is a graze (a glove brushing past), not a tap. */
export const TAP_MIN_MS = 40;
/** A press that confirms must begin at least this long after CONFIRM appeared (a bounce or a chattering key is quicker). */
export const CONFIRM_MIN_MS = 400;
/** Rough mode (gloves, vibration): firmer taps, a longer cooldown, more drift allowed. One button at a time is the session's. */
export const ROUGH = { tapMinMs: 80, cooldownMs: 800, drift: 1.5 };
/** Two keydowns closer than this are a bouncing key, not a double press. */
const KEY_DOUBLE_MIN_MS = 60;
/**
 * After NO RESPONSE, a host state showing that the press did run counts as ours for this long (a
 * run that started more than PRESS_MAX_AGE_MS after the press was made never does: the host drops
 * a press that old).
 */
const OUTCOME_WINDOW_MS = 30_000;
const FLASH_MS = 1200;
const SHORT_FLASH_MS = 700;
/** After a 'started' ack, wait this long at most for the host's state broadcast. */
const STATE_GRACE_MS = 1500;
/** Backstop: a backend that has neither sent the press nor given up by now didn't send it. */
const SEND_DEADLINE_MS = 500;
/** A hold timer this late means the main thread stalled: let queued input land before deciding. */
const LATE_MS = 20;
/** How many run ids to remember as ours / someone else's. */
const REMEMBER = 12;

/**
 * busy: pressed while running (or while the last press is still on its way). cooldown: pressed
 * again within the button's cooldown (a bounce, a chattering key). later: the host refused to start
 * it just now (rate limit, its last run still dying): try again. already: someone else's run
 * started while this press was on its way (it wasn't sent, or the host ignored it). queued: the
 * re-run is queued already. unknown: the host has no such button. denied: offline. slipped: a
 * hold let go early, or a press that slid off.
 */
export type FlashKind = 'busy' | 'cooldown' | 'later' | 'already' | 'queued' | 'unknown' | 'denied' | 'slipped';

/** How the press that asked for a confirmation was made: the CONFIRM face says it the same way. */
export type Via = 'key' | 'hold' | 'tap' | 'double';

/**
 * What a key press did (a key for a button on another pad says it in a toast): sent; confirm (the
 * confirm step: press again); again (the first press of a double); cooldown (too soon after the
 * last fire, ignored); busy (the last press is still on its way); offline (not connected); cleared
 * (it cleared a result kept on screen); none (a bounce, a finger on the button).
 */
export type KeyResult = 'sent' | 'confirm' | 'again' | 'cooldown' | 'busy' | 'offline' | 'cleared' | 'none';

/**
 * A result this device shows on its own, on top of what the host says:
 * - failure / interrupted: one of this device's runs failed. Stays until touched.
 * - noresponse: sent, no answer (it may or may not have run). Stays until touched, or until the
 *   host's state shows what it did.
 * - notsent: it never reached the host (or arrived too late and was dropped). Stays until touched.
 * - ran: a press that got no answer did run, and finished before the link came back. Shows how it
 *   ended when the host still knows (`last`); a failure stays until touched, anything else for
 *   resultHoldMs.
 */
export interface LocalResult {
  kind: 'failure' | 'interrupted' | 'noresponse' | 'notsent' | 'ran';
  /** The run it is about: the failed run; for noresponse/notsent, the run the host showed when the press went out. */
  runId: number;
  /** wall() it appeared. */
  at: number;
  /** wall() it goes away by itself; absent: when touched. */
  until?: number;
  /** failure / interrupted: the host's word on it (`fromLast`: rebuilt from READY's `last`, which has no exit code). */
  host?: Extract<RunState, { phase: 'failure' }>;
  fromLast?: true;
  /** ran: how it ended, if the host still knows. */
  last?: LastResult;
  /** notsent: why. */
  text?: string;
}

export interface Local {
  input: 'idle' | 'arming' | 'pressed' | 'double';
  /** wall() when the hold began (the fill is synced to it). */
  armAt: number;
  armMs: number;
  /** Set on early release/drift so the face can drain the fill. */
  disarmAt: number;
  firedAt: number;
  /** CONFIRM: shown since `at`, until `until` (wall()). */
  confirm: { at: number; until: number; via: Via } | null;
  sending: { at: number; baseRunId: number; acked: boolean } | null;
  result: LocalResult | null;
  flash: { kind: FlashKind; at: number; ms: number } | null;
  /** Runs started (or queued) by this device's presses, as acked. */
  own: readonly number[];
  /** Runs seen starting while connected, with no press of this device behind them. */
  others: readonly number[];
}

export interface ControllerCtx {
  /** The button as the config says now (live, not a copy from the last render). */
  button(): WireButton;
  host(): RunState;
  /** Add to a host timestamp to get a local (wall()) one (Snapshot.clockSkew). */
  skew(): number;
  online(): boolean;
  rough(): boolean;
  /**
   * Sends a press made at `at` (mono(): the gesture's own time, which a stalled page may have left
   * behind). `onAck` gets the host's answer; the promise rejects with a PressError when there is none.
   */
  press(opts: { confirm: boolean; at: number; onSent(): void; onAck(ack: PressAck): void }): Promise<unknown>;
  /** The link looks dead, or someone touched a button while offline: check / reconnect now. */
  kick(): void;
  /**
   * A contact landed here at `t`: may it start a press (rough mode: one button at a time per pad;
   * a palm)? Every contact counts for palm detection, also the ones refused.
   */
  mayStart(t: number): boolean;
}

/** A press that went out: what NO RESPONSE needs to tell, later, whether a run was its doing. */
interface Sent {
  /** The run the host showed when it went out. */
  baseRunId: number;
  /** wall() when it was made, and the clock offset it went out with: its `at` was made - skew. */
  made: number;
  skew: number;
  /** Pressed on a running queue button: what it starts is the re-run after that run. */
  queue: boolean;
}

/** NO RESPONSE: if the host turns out to have run the press, show that (onHost). */
interface Outcome extends Sent {
  /** wall() it stops counting. */
  until: number;
  /** queue: the run it would wait for ended (or is being cancelled) with a re-run still coming. */
  requeued: boolean;
}

const idle = (): Local => ({
  input: 'idle',
  armAt: 0,
  armMs: 0,
  disarmAt: 0,
  firedAt: 0,
  confirm: null,
  sending: null,
  result: null,
  flash: null,
  own: [],
  others: [],
});

const remember = (list: readonly number[], id: number) => (list.includes(id) ? list : [...list, id].slice(-REMEMBER));

/** How a run ended, from a result face or from READY's `last`. */
export function outcomeOf(host: RunState): (LastResult & { state?: Extract<RunState, { phase: 'failure' }> }) | null {
  if (host.phase === 'success') return { runId: host.runId, ok: true, text: host.text, endedAt: host.endedAt };
  if (host.phase === 'failure') return { runId: host.runId, ok: false, reason: host.reason, text: host.text, endedAt: host.endedAt, state: host };
  if (host.phase === 'ready' && host.last) return host.last;
  return null;
}

/** Whether the local result is on screen: it hasn't run out, and the host hasn't moved on to a newer run. */
export function resultShown(l: Local, host: RunState, now: number): boolean {
  const r = l.result;
  return !!r && (r.until === undefined || now < r.until) && host.runId <= r.runId;
}

/** One press of the button: from the first contact down to the last one up. */
interface Gesture {
  /** Contacts on the button now. A rolling thumb or a glove makes several: any one carries the press. */
  pointers: Map<string, { x0: number; y0: number }>;
  /** mono() when the press began (the first contact's event time). */
  t0: number;
  /** Taken at the start: a config change mid-press doesn't change what this press does. */
  trigger: WireButton['trigger'];
  holdMs: number;
  driftPx: number;
  tapMinMs: number;
  fired: boolean;
  /** Second tap of a double. */
  second: boolean;
  /** Began inside the confirm window: firing runs the action (decided at the start). */
  confirmed: boolean;
  /** The confirm window this press took over, given back if the press comes to nothing. */
  window: Local['confirm'];
  /** Began on a result this device kept on screen, and dismissed it: a tap doesn't fire; a hold that comes to nothing is quiet. */
  dismissed: boolean;
  /** What the host showed when it began: a run someone else starts meanwhile isn't this press's to touch. */
  runId0: number;
  idle0: boolean;
}

export class ButtonController {
  readonly local = createStore<Local>(idle());
  private ctx: ControllerCtx | null = null;
  private g: Gesture | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sendSeq = 0;
  /** How the last press that went out was made (a `needs-confirm` answer asks again the same way). */
  private sentVia: Via = 'tap';
  /** mono() of the last fire (send or confirm step), for the cooldown. */
  private lastFire = -Infinity;
  /** The first tap (or keydown) of a double: when it ended (mono()), and the confirm state it carries. */
  private tapAt = 0;
  private tapConfirmed = false;
  private tapWindow: Local['confirm'] = null;
  /** A press that got no answer: if the host turns out to have run it, show that. */
  private outcome: Outcome | null = null;
  /** The press NO RESPONSE is about: its answer may still come (a link that recovers delivers it late). */
  private lateSeq = 0;
  /** Own runs whose outcome has been cued (and kept on screen, if it failed). */
  private handled: number[] = [];
  /** Runs that showed up while a press of ours was unanswered: ours or not, the ack will say. */
  private unclaimed: number[] = [];
  /**
   * A `queued` ack: the re-run after run `behind` is ours, unless that run ends (or is cancelled)
   * without it (All off, a cancel, a host restart). `seen`: the state when the ack came, which on a
   * host predates the press (its state broadcast follows the ack): not a sign of anything.
   */
  private queuedBehind: { behind: number; seen: RunState | undefined } | null = null;
  private lastRunId = -1;

  setCtx(ctx: ControllerCtx): void {
    this.ctx = ctx;
    this.lastRunId = ctx.host().runId;
  }

  private get l() {
    return this.local.get();
  }

  private patch(p: Partial<Local>) {
    this.local.set({ ...this.l, ...p });
  }

  private after(name: string, ms: number, fn: () => void) {
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(fn, ms));
  }

  private clear(name: string) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }

  private flash(kind: FlashKind, ms = FLASH_MS) {
    this.patch({ flash: { kind, at: wall(), ms } });
    this.after('flash', ms, () => this.patch({ flash: null }));
  }

  private isOwn(runId: number) {
    return this.l.own.includes(runId);
  }

  private claim(runId: number) {
    this.patch({ own: remember(this.l.own, runId), others: this.l.others.filter((r) => r !== runId) });
    this.unclaimed = this.unclaimed.filter((r) => r !== runId);
  }

  /** A `queued` ack: the run after `behind` is ours, as long as it is still coming (followQueued). */
  private claimQueued(behind: number) {
    this.claim(behind + 1);
    this.queuedBehind = { behind, seen: this.ctx?.host() };
  }

  private cooldown(): number {
    const b = this.ctx?.button();
    return Math.max(b?.cooldownMs ?? 0, this.ctx?.rough() ? ROUGH.cooldownMs : 0);
  }

  /** Has a press in progress (a finger on it). */
  get pressing(): boolean {
    return this.g !== null;
  }

  /** Link dropped: a gesture in progress can't be sent, so let go of it (fill drains). */
  onLink(online: boolean): void {
    if (!online && this.g) this.cancelGesture(this.g, 'quiet');
  }

  /** The button moved, changed size or went away under a finger (config change), or left the screen: let go. */
  letGo(why: 'moved' | 'hidden'): void {
    if (this.g) this.cancelGesture(this.g, why === 'moved' ? 'buzz' : 'quiet');
  }

  /** A palm (or rough mode): drop the press in progress without a word. */
  drop(): void {
    if (this.g) this.cancelGesture(this.g, 'quiet');
  }

  /**
   * Host state changed (`live`: while connected; false for the states a hello or a reload brings,
   * whose runs this device didn't see start). Settles SENDING, resolves an unanswered press, sorts
   * runs into ours and others', cues and keeps the outcome of ours.
   */
  onHost(host: RunState, live = true): void {
    // Run ids went backwards: the host started over (no state file; the demo's Reset).
    if (host.runId < this.lastRunId) this.forget(host);
    const s = this.l.sending;
    if (s?.acked && host.runId > s.baseRunId) this.patch({ sending: null });
    this.followQueued(host);
    const o = this.outcome;
    if (o && wall() > o.until) this.outcome = null;
    else if (o) this.resolve(o, host);
    if (host.runId > this.lastRunId && host.phase !== 'ready') {
      // A run we didn't see coming: whose is it? An unanswered press of ours may have started it.
      const fresh = host.runId;
      if (!this.isOwn(fresh) && live) {
        if (this.l.sending && !this.l.sending.acked) this.unclaimed = remember(this.unclaimed, fresh) as number[];
        else if (!this.outcome) this.patch({ others: remember(this.l.others, fresh) });
      }
    }
    this.lastRunId = Math.max(this.lastRunId, host.runId);
    // A result kept on screen gives way to a newer run (NO RESPONSE only once that run turned out
    // not to be its outcome, above).
    const r = this.l.result;
    if (r && host.runId > r.runId && (r.kind !== 'noresponse' || !this.outcome)) this.patch({ result: null });
    this.settle(host);
  }

  /**
   * NO RESPONSE: does the host's state show that the press did reach it? A newer run is its doing,
   * unless that run started more than PRESS_MAX_AGE_MS after the press was made (the host drops a
   * press that old, so that's someone else's), or, for a press on a running queue button, it is the
   * re-run after the run it pressed on, and that run ended with the re-run still coming.
   */
  private resolve(o: Outcome, host: RunState) {
    if (host.runId === o.baseRunId) {
      // The run a queue press would wait for: is a re-run coming after it?
      if (o.queue && (host.phase !== 'running' || host.cancelling)) o.requeued = host.phase !== 'ready' && !!host.queued;
      return;
    }
    if (host.runId < o.baseRunId) return;
    this.outcome = null;
    const ran = host.phase === 'ready' ? host.last?.runId ?? host.runId : host.runId;
    const late = host.phase !== 'ready' && host.startedAt + o.skew > o.made + PRESS_MAX_AGE_MS + 1;
    if (late && !(o.queue && o.requeued && ran === o.baseRunId + 1)) return;
    // The press that got no answer did reach the host: show what it did, not NO RESPONSE.
    this.claim(ran);
    if (this.l.result?.kind === 'noresponse') this.patch({ result: null });
    // Already back to READY: show how it ended (or, if the host no longer knows, that it ran).
    if (host.phase === 'ready' && !(host.last && host.last.runId === ran && !host.last.ok)) {
      this.markHandled(ran);
      const holdMs = this.ctx?.button().resultHoldMs ?? 2500;
      const last = host.last?.runId === ran ? host.last : undefined;
      this.setResult({ kind: 'ran', runId: ran, at: wall(), until: wall() + Math.max(holdMs, 1500), ...(last ? { last } : {}) });
      if (last) cue(last.ok ? 'success' : last.reason === 'interrupted' ? 'unknown' : 'failure');
    }
  }

  /**
   * A re-run this device queued: is it still coming? Not once the run it waits for ends, or is
   * being cancelled, without it (All off, a cancel, a host restart): then the run after that one,
   * whoever starts it, isn't this device's.
   */
  private followQueued(host: RunState) {
    const q = this.queuedBehind;
    if (!q || host === q.seen) return;
    if (host.runId > q.behind) this.queuedBehind = null;
    else if (host.runId === q.behind && (host.phase === 'ready' || (!host.queued && (host.phase !== 'running' || host.cancelling)))) {
      this.patch({ own: this.l.own.filter((r) => r !== q.behind + 1) });
      this.queuedBehind = null;
    }
  }

  /**
   * Run ids started over: the runs remembered here are gone, and their ids will name new ones. A
   * result kept on screen stays until touched (the next run supersedes it, as usual); one that a
   * newer run had superseded already doesn't come back.
   */
  private forget(host: RunState) {
    const { result: r, sending } = this.l;
    const shown = !!r && r.runId >= this.lastRunId && (r.until === undefined || wall() < r.until);
    this.handled = [];
    this.unclaimed = [];
    this.outcome = null;
    this.queuedBehind = null;
    this.lastRunId = host.runId;
    this.patch({ own: [], others: [], ...(sending ? { sending: { ...sending, baseRunId: Math.min(sending.baseRunId, host.runId) } } : {}) });
    if (r && shown) this.setResult({ ...r, runId: host.runId });
    else if (r) {
      this.clear('result');
      this.patch({ result: null });
    }
  }

  private markHandled(runId: number) {
    this.handled = remember(this.handled, runId) as number[];
  }

  private setResult(r: LocalResult) {
    this.clear('result');
    this.patch({ result: r });
    if (r.until !== undefined) this.after('result', Math.max(0, r.until - wall()) + 20, () => this.l.result === r && this.patch({ result: null }));
  }

  /** One of our runs ended: cue it once, and keep a failure on screen until touched. */
  private settle(host: RunState) {
    const o = outcomeOf(host);
    if (!o || !this.isOwn(o.runId) || this.handled.includes(o.runId)) return;
    this.markHandled(o.runId);
    if (o.ok) return cue('success');
    // Stopped on purpose (a cancel, a `stops`): not a failure, no failure buzz.
    if (o.reason === 'cancelled') return;
    cue(o.reason === 'interrupted' ? 'unknown' : 'failure');
    const state: Extract<RunState, { phase: 'failure' }> = o.state ?? {
      phase: 'failure',
      runId: o.runId,
      startedAt: o.endedAt,
      endedAt: o.endedAt,
      exitCode: null,
      reason: o.reason ?? 'exit',
      ...(o.text !== undefined ? { text: o.text } : {}),
    };
    this.setResult({ kind: o.reason === 'interrupted' ? 'interrupted' : 'failure', runId: o.runId, at: wall(), host: state, ...(o.state ? {} : { fromLast: true as const }) });
  }

  // ---- input ----------------------------------------------------------------------------------

  /**
   * A contact went down on the button at `t` (mono()). Returns whether it is now part of a press
   * (the caller captures the pointer). A second contact on a pressed button joins that press.
   */
  down(src: string, x: number, y: number, t = mono()): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const g = this.g;
    if (g) {
      // Rolling thumb, glove: the new contact can carry the press on when the first one lifts.
      if (g.fired || g.pointers.has(src)) return false;
      g.pointers.set(src, { x0: x, y0: y });
      return true;
    }
    unlockAudio();
    if (!ctx.online()) {
      this.deny();
      // The host may be back already: try now rather than at the next retry.
      ctx.kick();
      return false;
    }
    if (!ctx.mayStart(t)) return false;
    const b = ctx.button();
    const now = wall();
    const c = this.l.confirm && this.l.confirm.until > now ? this.l.confirm : null;
    // A confirming press is a new, deliberate one: not a bounce right after CONFIRM came up (by
    // when the contact happened, not when a busy page got to it).
    if (c && now - Math.max(0, mono() - t) - c.at < Math.max(CONFIRM_MIN_MS, this.cooldown())) return false;
    const host = ctx.host();
    // A result kept on screen: this touch is for it.
    const dismissed = resultShown(this.l, host, now);
    if (dismissed) {
      this.clear('result');
      this.patch({ result: null });
      haptic('touch');
    }
    const second = b.trigger === 'double' && this.tapAt > 0 && t - this.tapAt <= DOUBLE_TAP_MS;
    this.tapAt = 0;
    this.clear('double');
    // Confirm-or-fire is settled now, at the start: a window that runs out mid-hold doesn't re-ask.
    let confirmed = false;
    let window: Local['confirm'] = null;
    if (second) [confirmed, window] = [this.tapConfirmed, this.tapWindow];
    else if (c) {
      [confirmed, window] = [true, c];
      this.clear('confirm');
      this.patch({ confirm: null });
    }
    const rough = ctx.rough();
    const next: Gesture = {
      pointers: new Map([[src, { x0: x, y0: y }]]),
      t0: t,
      trigger: b.trigger,
      holdMs: b.holdMs,
      driftPx: b.driftPx * (rough ? ROUGH.drift : 1),
      tapMinMs: rough ? ROUGH.tapMinMs : TAP_MIN_MS,
      fired: false,
      second,
      confirmed,
      window,
      dismissed,
      runId0: host.runId,
      idle0: host.phase !== 'running',
    };
    this.g = next;
    if (b.trigger === 'hold') {
      if (!dismissed) haptic('touch');
      this.patch({ input: 'arming', armAt: now - Math.max(0, mono() - t), armMs: b.holdMs });
      this.after('hold', Math.max(0, t + b.holdMs - mono()), () => this.holdDue(next, false));
    } else if (!dismissed) this.patch({ input: 'pressed' });
    return true;
  }

  /**
   * The hold timer. Running late means the main thread stalled, and a pointerup from before
   * holdMs may still be queued behind it: let queued input land first (up() then decides by the
   * event's own time). A finger still down after that has held long enough.
   */
  private holdDue(g: Gesture, waited: boolean) {
    if (this.g !== g || g.fired) return;
    if (!waited && mono() - (g.t0 + g.holdMs) > LATE_MS) return afterQueuedInput(() => this.holdDue(g, true));
    this.fireGesture(g);
  }

  /** The press fired: made when the hold reached holdMs, or when the tap's last contact lifted (`t`). */
  private fireGesture(g: Gesture, t = mono()) {
    g.fired = true;
    this.clear('hold');
    this.patch({ input: 'idle' });
    this.fire(g.trigger === 'hold' ? 'hold' : g.trigger, g.confirmed, g.trigger === 'hold' ? g.t0 + g.holdMs : t, g);
  }

  /**
   * The press came to nothing. `slipped`: let go early or slid off (says SLIPPED, buzzes). `buzz`:
   * a short buzz only (a resting thumb, the system took the contact, the button moved). `quiet`:
   * nothing (a graze, a palm, the link went, a touch that only dismissed a result).
   */
  private cancelGesture(g: Gesture, how: 'slipped' | 'buzz' | 'quiet') {
    if (this.g === g) this.g = null;
    this.clear('hold');
    if (g.fired) return;
    this.patch({ input: 'idle', disarmAt: this.l.input === 'arming' ? wall() : this.l.disarmAt });
    this.restoreWindow(g.window);
    if (g.dismissed) return;
    if (how === 'slipped') this.flash('slipped');
    if (how !== 'quiet') cue('cancel');
  }

  /** Give back a confirm window that a press took over, if it hasn't run out meanwhile. */
  private restoreWindow(w: Local['confirm']) {
    if (!w) return;
    const left = w.until - wall();
    if (left <= 0 || this.l.confirm) return;
    this.patch({ confirm: w });
    this.after('confirm', left, () => this.patch({ confirm: null }));
  }

  move(src: string, x: number, y: number, t = mono()): void {
    const g = this.g;
    const p = g?.pointers.get(src);
    if (!g || !p || g.fired || Math.hypot(x - p.x0, y - p.y0) <= g.driftPx) return;
    // The hold was complete before this slide; its timer is just late.
    if (g.trigger === 'hold' && t - g.t0 >= g.holdMs) return this.fireGesture(g);
    // This contact slid away; another one may still hold the press.
    g.pointers.delete(src);
    if (!g.pointers.size) this.cancelGesture(g, 'slipped');
  }

  up(src: string, t = mono()): void {
    const g = this.g;
    if (!g || !g.pointers.delete(src)) return;
    // Another contact still holds the button: the press goes on.
    if (g.pointers.size) return;
    this.g = null;
    this.clear('hold');
    // Fired already (a hold): done, even if the trigger changed to tap meanwhile.
    if (g.fired) return;
    const held = t - g.t0;
    if (g.trigger === 'hold') return held >= g.holdMs ? this.fireGesture(g) : this.cancelGesture(g, 'slipped');
    // A touch that dismissed a result is done.
    if (g.dismissed) return this.cancelGesture(g, 'quiet');
    // A graze isn't a tap; a thumb resting on a tap button and lifting later isn't either.
    if (held < g.tapMinMs) return this.cancelGesture(g, 'quiet');
    if (held > TAP_MAX_MS) return this.cancelGesture(g, 'buzz');
    if (g.trigger === 'tap' || g.second) return this.fireGesture(g, t);
    // First tap of a double: wait for the second.
    [this.tapAt, this.tapConfirmed, this.tapWindow] = [t, g.confirmed, g.window];
    this.patch({ input: 'double' });
    this.after('double', DOUBLE_TAP_MS, () => {
      this.patch({ input: 'idle' });
      this.restoreWindow(this.tapWindow);
    });
  }

  /** pointercancel, lost capture: the system took the contact. */
  abort(src: string): void {
    const g = this.g;
    if (!g || !g.pointers.delete(src) || g.pointers.size) return;
    this.cancelGesture(g, 'buzz');
  }

  /**
   * A mapped key went down at `t` (auto-repeat already filtered out). Keys don't hold: clickers
   * send keydown and keyup together, so hold and tap buttons fire right away, and a double fires
   * on the second keydown within DOUBLE_TAP_MS. Confirm and cooldown still apply. A result kept on
   * screen takes the key (it only clears it), unless the button is `offscreen` (on another pad):
   * then nobody sees that result to clear, and the key press is a press. Says what it did.
   */
  key(t = mono(), offscreen = false): KeyResult {
    const ctx = this.ctx;
    if (!ctx) return 'none';
    unlockAudio();
    if (!ctx.online()) {
      this.deny();
      ctx.kick();
      return 'offline';
    }
    // A finger is on it already.
    if (this.g) return 'none';
    const now = wall();
    if (resultShown(this.l, ctx.host(), now)) {
      this.clear('result');
      this.patch({ result: null });
      // A result kept on screen: this key press is for it.
      if (!offscreen) {
        haptic('touch');
        return 'cleared';
      }
    }
    const c = this.l.confirm && this.l.confirm.until > now ? this.l.confirm : null;
    // A key that bounces (or chatters) right after CONFIRM came up doesn't confirm.
    if (c && now - Math.max(0, mono() - t) - c.at < Math.max(CONFIRM_MIN_MS, this.cooldown())) return 'none';
    if (ctx.button().trigger !== 'double') return this.fire('key', !!c, t);
    if (this.tapAt > 0 && t - this.tapAt <= DOUBLE_TAP_MS) {
      // A bouncing key: not a second press.
      if (t - this.tapAt < KEY_DOUBLE_MIN_MS) return 'none';
      this.tapAt = 0;
      this.clear('double');
      this.patch({ input: 'idle' });
      return this.fire('key', this.tapConfirmed, t);
    }
    [this.tapAt, this.tapConfirmed, this.tapWindow] = [t, !!c, null];
    this.patch({ input: 'double' });
    this.after('double', DOUBLE_TAP_MS, () => this.patch({ input: 'idle' }));
    return 'again';
  }

  private deny() {
    this.flash('denied');
    cue('denied');
  }

  // ---- firing ---------------------------------------------------------------------------------

  /** A press fired (made at `at`, mono()): send it, or ask for the confirm step, or say why not. */
  private fire(via: Via, confirmed: boolean, at: number, g?: Gesture): KeyResult {
    const ctx = this.ctx;
    if (!ctx) return 'none';
    // Pressed again right after a fire: a bounce, a chattering key. Ignored, without a buzz.
    if (mono() - this.lastFire < this.cooldown()) {
      this.restoreWindow(g?.window ?? null);
      this.flash('cooldown', SHORT_FLASH_MS);
      return 'cooldown';
    }
    // The last press is still on its way: say so, rather than buzz "fired" and drop this one.
    if (this.l.sending) {
      this.flash('busy');
      cue('busy');
      return 'busy';
    }
    const button = ctx.button();
    const host = ctx.host();
    // Begun on what looked READY, but someone else's run started meanwhile: this press was meant to
    // start one, not to cancel, queue behind or bump into theirs.
    if (g?.idle0 && host.phase === 'running' && host.runId > g.runId0 && !this.isOwn(host.runId)) {
      this.flash('already');
      cue('busy');
      return 'none';
    }
    const now = wall();
    this.lastFire = mono();
    this.patch({ firedAt: now });
    const starts = host.phase !== 'running' || button.whileRunning === 'queue';
    if (button.confirm && starts && !confirmed) {
      this.askConfirm(via);
      return 'confirm';
    }
    this.clear('confirm');
    if (this.l.confirm) this.patch({ confirm: null });
    cue('fire');
    this.sentVia = via;
    this.send(button.confirm && confirmed, at);
    return 'sent';
  }

  private askConfirm(via: Via) {
    const ms = this.ctx?.button().confirmWindowMs ?? 3000;
    const now = wall();
    cue('confirm');
    this.patch({ confirm: { at: now, until: now + ms, via } });
    this.after('confirm', ms, () => this.patch({ confirm: null }));
  }

  private send(confirm: boolean, at: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const seq = ++this.sendSeq;
    const host = ctx.host();
    const baseRunId = host.runId;
    const press: Sent = {
      baseRunId,
      made: wall() - Math.max(0, mono() - at),
      skew: ctx.skew(),
      queue: host.phase === 'running' && ctx.button().whileRunning === 'queue',
    };
    this.outcome = null;
    this.lateSeq = 0;
    this.unclaimed = [];
    this.clear('result');
    this.patch({ sending: { at: wall(), baseRunId, acked: false }, result: null, flash: null });
    let sent = false;
    // The backend sends at once or gives up; this only covers one that does neither.
    this.after('ack', SEND_DEADLINE_MS, () => seq === this.sendSeq && this.notSent('not connected to the host'));
    ctx
      .press({
        confirm,
        at,
        onSent: () => {
          if (seq !== this.sendSeq || sent) return;
          sent = true;
          // The 2 s NO RESPONSE clock starts when the press is on the wire.
          this.after('ack', ACK_TIMEOUT_MS, () => seq === this.sendSeq && this.noResponse(press));
        },
        onAck: (ack) => (seq === this.sendSeq ? this.onAck(ack, baseRunId) : seq === this.lateSeq && this.onLateAck(ack)),
      })
      .catch((e: unknown) => {
        if (seq !== this.sendSeq || !this.l.sending || this.l.sending.acked) return;
        if (sent && !(e instanceof PressError && !e.sent)) this.noResponse(press);
        else this.notSent('not connected to the host');
      });
  }

  /** It never reached the host (or the host dropped it as too old): nothing ran. */
  private notSent(text: string) {
    if (!this.l.sending) return;
    this.clear('ack');
    this.sendSeq++;
    const runId = this.ctx?.host().runId ?? 0;
    this.patch({ sending: null });
    this.setResult({ kind: 'notsent', runId, at: wall(), text });
    cue('denied');
  }

  /** Sent and not answered: it may or may not have run. The host's state will tell (onHost). */
  private noResponse(press: Sent) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    const now = wall();
    this.lateSeq = this.sendSeq;
    this.sendSeq++;
    this.patch({ sending: null });
    this.setResult({ kind: 'noresponse', runId: press.baseRunId, at: now });
    this.outcome = { ...press, until: now + OUTCOME_WINDOW_MS, requeued: false };
    // Not the failure buzz: we don't know that it failed.
    cue('unknown');
    this.ctx?.kick();
    // The run may be on screen already (it showed up before the ack that never came).
    const host = this.ctx?.host();
    if (host) this.onHost(host);
  }

  /**
   * The answer to a press that already says NO RESPONSE. `expired`: it sat in the dead link too long
   * and the host dropped it, so it surely didn't run: NOT SENT. Started/queued: it did (onHost then
   * shows what it did, as for any run that turns out to be ours).
   */
  private onLateAck(ack: PressAck) {
    this.lateSeq = 0;
    if (this.l.result?.kind !== 'noresponse') return;
    if (ack.result === 'expired') {
      this.outcome = null;
      this.setResult({ kind: 'notsent', runId: this.l.result.runId, at: wall(), text: 'too late — not sent' });
    } else if (ack.runId !== undefined && ack.result === 'started') {
      this.claim(ack.runId);
      const host = this.ctx?.host();
      if (host) this.onHost(host);
    } else if (ack.runId !== undefined && ack.result === 'queued') {
      // It queued a re-run: that's ours while it's still coming (followQueued), whatever else runs.
      this.outcome = null;
      this.claimQueued(ack.runId);
      this.clear('result');
      this.patch({ result: null });
    }
  }

  private onAck(ack: PressAck, baseRunId: number) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    const ctx = this.ctx;
    const host = ctx?.host();
    const result: PressResult = ack.result;
    const settleUnclaimed = () => {
      // Runs that showed up while this press was unanswered and aren't its own: someone else's.
      for (const r of this.unclaimed) if (!this.isOwn(r)) this.patch({ others: remember(this.l.others, r) });
      this.unclaimed = [];
    };
    switch (result) {
      case 'started': {
        // A v1 host doesn't say which run: the next one.
        const runId = ack.runId ?? baseRunId + 1;
        this.claim(runId);
        settleUnclaimed();
        if (host && host.runId >= runId) this.patch({ sending: null });
        else {
          const seq = this.sendSeq;
          this.patch({ sending: { ...s, acked: true } });
          this.after('grace', STATE_GRACE_MS, () => seq === this.sendSeq && this.patch({ sending: null }));
        }
        break;
      }
      case 'queued':
        // The re-run it queued is ours (it starts after the one running now), while it's coming.
        this.claimQueued(ack.runId ?? host?.runId ?? baseRunId);
        settleUnclaimed();
        this.patch({ sending: null });
        break;
      case 'cancelling':
        settleUnclaimed();
        this.patch({ sending: null });
        break;
      case 'ignored':
        settleUnclaimed();
        this.patch({ sending: null });
        // Someone else's run got there first; the re-run is queued already; busy with its own run;
        // not running: refused for now (rate limit, last run still dying).
        if (host?.phase === 'running') this.flash(host.runId > baseRunId && !this.isOwn(host.runId) ? 'already' : host.queued ? 'queued' : 'busy');
        else this.flash('later');
        cue('busy');
        break;
      case 'expired':
        // It sat in a dead link too long: the host dropped it, and it will never run.
        this.notSent('too late — not sent');
        break;
      case 'needs-confirm':
        // The host wants the confirm step (the button became a confirm button on the way): ask.
        this.patch({ sending: null });
        this.askConfirm(this.sentVia);
        break;
      case 'unknown-button':
        this.patch({ sending: null });
        this.flash('unknown');
        cue('failure');
        break;
    }
    if (host && result !== 'expired') this.settle(host);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.g = null;
  }
}
