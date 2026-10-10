/**
 * Client-side half of a button: turns pointer/key input into fires (hold/tap/double, drift,
 * confirm) and owns the client-only states (ARMING, CONFIRM, SENDING, NO RESPONSE, flashes).
 * Host state stays authoritative; this only decorates it. Framework-free; RunButton wires it up.
 *
 * Gesture timing goes by the input events' own timestamps, not by when a handler got to run: on a
 * stalled main thread a finger lifted before holdMs must not fire, and one held past it must.
 */
import type { RunState } from '../../core/machine.ts';
import type { PressResult, WireButton } from '../../core/protocol.ts';
import { PressError } from '../backend/types.ts';
import { mono, nextTask } from '../lib/env.ts';
import { cue, haptic, unlockAudio } from '../lib/feedback.ts';
import { createStore } from '../lib/store.ts';

export const DOUBLE_TAP_MS = 400;
export const ACK_TIMEOUT_MS = 2000;
/** A tap held longer than this is a resting thumb, not a tap: letting go doesn't fire. */
export const TAP_MAX_MS = 1500;
const NO_RESPONSE_SHOW_MS = 2600;
/** After NO RESPONSE, a host state showing that the press did run counts as ours for this long. */
const OUTCOME_WINDOW_MS = 30_000;
const FLASH_MS = 1200;
/** After a 'started' ack, wait this long at most for the host's state broadcast. */
const STATE_GRACE_MS = 1500;
/** Backstop: a backend that has neither sent the press nor given up by now didn't send it. */
const SEND_DEADLINE_MS = 500;
/** A hold timer this late means the main thread stalled: let queued input land before deciding. */
const LATE_MS = 20;

/**
 * busy: pressed while running (or while the last press is still on its way). later: the host
 * refused to start it just now (rate limit, its last run still dying): try again. unknown: the
 * host has no such button. denied: offline. notsent: the press never left this device. ran: a
 * press that got no answer did run (it finished before the link came back).
 */
export type FlashKind = 'busy' | 'later' | 'unknown' | 'denied' | 'notsent' | 'ran';

export interface Local {
  input: 'idle' | 'arming' | 'pressed' | 'double';
  /** Date.now() when the hold began (the fill is synced to it). */
  armAt: number;
  armMs: number;
  /** Set on early release/drift so the face can drain the fill. */
  disarmAt: number;
  firedAt: number;
  confirmUntil: number;
  sending: { at: number; baseRunId: number; acked: boolean } | null;
  noResponse: { at: number; until: number; baseRunId: number } | null;
  flash: { kind: FlashKind; at: number } | null;
}

export interface ControllerCtx {
  button: WireButton;
  /** Live reads, never a copy from the last render. */
  host(): RunState;
  online(): boolean;
  press(onSent: () => void): Promise<PressResult>;
  kick(): void;
}

const idle = (): Local => ({ input: 'idle', armAt: 0, armMs: 0, disarmAt: 0, firedAt: 0, confirmUntil: 0, sending: null, noResponse: null, flash: null });

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
  fired: boolean;
  /** Second tap of a double. */
  second: boolean;
  /** Began inside the confirm window: firing runs the action (decided at the start). */
  confirmed: boolean;
  /** The confirm window this press took over, given back if the press comes to nothing. */
  window: number;
}

export class ButtonController {
  readonly local = createStore<Local>(idle());
  private ctx: ControllerCtx | null = null;
  private g: Gesture | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sendSeq = 0;
  /** runId below which a finished run is not "ours" (for success/failure haptics). */
  private mine: number | null = null;
  /** The first tap of a double: when it ended (mono()), and the confirm state it carries. */
  private tapAt = 0;
  private tapConfirmed = false;
  private tapWindow = 0;
  /** A press that got no answer: if the host turns out to have run it, show that. */
  private outcome: { baseRunId: number; until: number } | null = null;

  setCtx(ctx: ControllerCtx): void {
    this.ctx = ctx;
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

  private flash(kind: FlashKind) {
    this.patch({ flash: { kind, at: Date.now() } });
    this.after('flash', FLASH_MS, () => this.patch({ flash: null }));
  }

  /** Link dropped: a gesture in progress can't be sent, so let go of it (fill drains). */
  onLink(online: boolean): void {
    if (!online && this.g) this.cancelGesture(this.g, false);
  }

  /** Host state changed: settle SENDING, resolve an unanswered press, cue when our run finishes. */
  onHost(host: RunState): void {
    const s = this.l.sending;
    if (s && host.runId > s.baseRunId) this.patch({ sending: null });
    const o = this.outcome;
    if (o && Date.now() > o.until) this.outcome = null;
    else if (o && host.runId > o.baseRunId) {
      // The press that got no answer did reach the host: show what it did, not NO RESPONSE.
      this.outcome = null;
      this.clear('noResponse');
      this.patch({ noResponse: null });
      // Running, or its result still up: that shows by itself (and gets its cue below / on finish).
      // Already back to READY: all we know is that it ran.
      if (host.phase === 'ready') this.flash('ran');
      else this.mine = o.baseRunId;
    }
    if (this.mine !== null && host.runId > this.mine && (host.phase === 'success' || host.phase === 'failure')) {
      this.mine = null;
      cue(host.phase);
    }
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
    if (!ctx.online()) return (this.deny(), false);
    const b = ctx.button;
    const now = Date.now();
    const second = b.trigger === 'double' && this.tapAt > 0 && t - this.tapAt <= DOUBLE_TAP_MS;
    this.tapAt = 0;
    this.clear('double');
    // Confirm-or-fire is settled now, at the start: a window that runs out mid-hold doesn't re-ask.
    let confirmed = false;
    let window = 0;
    if (second) [confirmed, window] = [this.tapConfirmed, this.tapWindow];
    else if (this.l.confirmUntil > now) {
      [confirmed, window] = [true, this.l.confirmUntil];
      this.clear('confirm');
      this.patch({ confirmUntil: 0 });
    }
    const next: Gesture = { pointers: new Map([[src, { x0: x, y0: y }]]), t0: t, trigger: b.trigger, holdMs: b.holdMs, driftPx: b.driftPx, fired: false, second, confirmed, window };
    this.g = next;
    if (b.trigger === 'hold') {
      haptic('touch');
      this.patch({ input: 'arming', armAt: now - Math.max(0, mono() - t), armMs: b.holdMs });
      this.after('hold', Math.max(0, t + b.holdMs - mono()), () => this.holdDue(next, 0));
    } else this.patch({ input: 'pressed' });
    return true;
  }

  /** The hold timer. Late (a stalled main thread) → a pointerup may be queued behind it: yield first. */
  private holdDue(g: Gesture, yields: number) {
    if (this.g !== g || g.fired) return;
    const inputPending = (navigator as { scheduling?: { isInputPending?(): boolean } }).scheduling?.isInputPending?.() === true;
    const late = mono() - (g.t0 + g.holdMs) > LATE_MS;
    if (yields < 3 && (inputPending || (yields === 0 && late))) return nextTask(() => this.holdDue(g, yields + 1));
    this.fireGesture(g);
  }

  private fireGesture(g: Gesture) {
    g.fired = true;
    this.clear('hold');
    this.patch({ input: 'idle' });
    this.fire(g.confirmed);
  }

  /** The press came to nothing (released early, slid off, taken by the system, link lost). */
  private cancelGesture(g: Gesture, buzz: boolean) {
    if (this.g === g) this.g = null;
    this.clear('hold');
    if (g.fired) return;
    this.patch({ input: 'idle', disarmAt: this.l.input === 'arming' ? Date.now() : this.l.disarmAt });
    this.restoreWindow(g.window);
    if (buzz) cue('cancel');
  }

  /** Give back a confirm window that a press took over, if it hasn't run out meanwhile. */
  private restoreWindow(until: number) {
    const left = until - Date.now();
    if (left <= 0 || this.l.confirmUntil) return;
    this.patch({ confirmUntil: until });
    this.after('confirm', left, () => this.patch({ confirmUntil: 0 }));
  }

  move(src: string, x: number, y: number, t = mono()): void {
    const g = this.g;
    const p = g?.pointers.get(src);
    if (!g || !p || g.fired || Math.hypot(x - p.x0, y - p.y0) <= g.driftPx) return;
    // The hold was complete before this slide; its timer is just late.
    if (g.trigger === 'hold' && t - g.t0 >= g.holdMs) return this.fireGesture(g);
    // This contact slid away; another one may still hold the press.
    g.pointers.delete(src);
    if (!g.pointers.size) this.cancelGesture(g, true);
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
    if (g.trigger === 'hold') return held >= g.holdMs ? this.fireGesture(g) : this.cancelGesture(g, true);
    // Resting a thumb on a tap button and lifting it later isn't a tap.
    if (held > TAP_MAX_MS) return this.cancelGesture(g, true);
    if (g.trigger === 'tap' || g.second) return this.fireGesture(g);
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
    this.cancelGesture(g, true);
  }

  /**
   * A mapped key went down at `t` (auto-repeat already filtered out). Keys don't hold: clickers
   * send keydown and keyup together, so hold and tap buttons fire right away, and a double fires
   * on the second keydown within DOUBLE_TAP_MS. Confirm still applies.
   */
  key(t = mono()): void {
    const ctx = this.ctx;
    if (!ctx) return;
    unlockAudio();
    if (!ctx.online()) return this.deny();
    // A finger is on it already.
    if (this.g) return;
    const inWindow = this.l.confirmUntil > Date.now();
    if (ctx.button.trigger !== 'double') return this.fire(inWindow);
    if (this.tapAt > 0 && t - this.tapAt <= DOUBLE_TAP_MS) {
      this.tapAt = 0;
      this.clear('double');
      this.patch({ input: 'idle' });
      return this.fire(this.tapConfirmed);
    }
    [this.tapAt, this.tapConfirmed, this.tapWindow] = [t, inWindow, 0];
    this.patch({ input: 'double' });
    this.after('double', DOUBLE_TAP_MS, () => this.patch({ input: 'idle' }));
  }

  private deny() {
    this.flash('denied');
    cue('denied');
  }

  // ---- firing ---------------------------------------------------------------------------------

  private fire(confirmed: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    // The last press is still on its way: say so, rather than buzz "fired" and drop this one.
    if (this.l.sending) {
      this.flash('busy');
      cue('busy');
      return;
    }
    const now = Date.now();
    this.patch({ firedAt: now });
    const { button } = ctx;
    const starts = ctx.host().phase !== 'running' || button.whileRunning === 'queue';
    if (button.confirm && starts && !confirmed) {
      cue('confirm');
      this.patch({ confirmUntil: now + button.confirmWindowMs });
      this.after('confirm', button.confirmWindowMs, () => this.patch({ confirmUntil: 0 }));
      return;
    }
    this.clear('confirm');
    if (this.l.confirmUntil) this.patch({ confirmUntil: 0 });
    cue('fire');
    this.send();
  }

  private send() {
    const ctx = this.ctx;
    if (!ctx) return;
    const seq = ++this.sendSeq;
    const baseRunId = ctx.host().runId;
    this.outcome = null;
    this.clear('noResponse');
    this.patch({ sending: { at: Date.now(), baseRunId, acked: false }, noResponse: null, flash: null });
    let sent = false;
    // The backend sends at once or gives up; this only covers one that does neither.
    this.after('ack', SEND_DEADLINE_MS, () => seq === this.sendSeq && this.notSent());
    ctx
      .press(() => {
        if (seq !== this.sendSeq || sent) return;
        sent = true;
        // The 2 s NO RESPONSE clock starts when the press is on the wire.
        this.after('ack', ACK_TIMEOUT_MS, () => seq === this.sendSeq && this.noResponse(baseRunId));
      })
      .then(
        (r) => seq === this.sendSeq && this.onAck(r, baseRunId),
        (e: unknown) => {
          if (seq !== this.sendSeq) return;
          if (sent && !(e instanceof PressError && !e.sent)) this.noResponse(baseRunId);
          else this.notSent();
        },
      );
  }

  /** It never left this device: nothing ran. */
  private notSent() {
    if (!this.l.sending) return;
    this.clear('ack');
    this.sendSeq++;
    this.patch({ sending: null });
    this.flash('notsent');
    cue('denied');
  }

  /** Sent and not answered: it may or may not have run. The host's state will tell (onHost). */
  private noResponse(baseRunId: number) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    this.sendSeq++;
    const now = Date.now();
    this.patch({ sending: null, noResponse: { at: now, until: now + NO_RESPONSE_SHOW_MS, baseRunId } });
    this.outcome = { baseRunId, until: now + OUTCOME_WINDOW_MS };
    // Not the failure buzz: we don't know that it failed.
    cue('unknown');
    this.ctx?.kick();
    this.after('noResponse', NO_RESPONSE_SHOW_MS, () => this.patch({ noResponse: null }));
  }

  private onAck(result: PressResult, baseRunId: number) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    const host = this.ctx?.host();
    switch (result) {
      case 'started': {
        this.mine = baseRunId;
        if (host && host.runId > baseRunId) this.patch({ sending: null });
        else {
          const seq = this.sendSeq;
          this.patch({ sending: { ...s, acked: true } });
          this.after('grace', STATE_GRACE_MS, () => seq === this.sendSeq && this.patch({ sending: null }));
        }
        break;
      }
      case 'queued':
        this.mine = host?.runId ?? baseRunId;
        this.patch({ sending: null });
        break;
      case 'cancelling':
        this.mine = (host?.runId ?? baseRunId) - 1;
        this.patch({ sending: null });
        break;
      case 'ignored':
        this.patch({ sending: null });
        // Running: it's busy with that. Not running: refused for now (rate limit, last run still dying).
        this.flash(host?.phase === 'running' ? 'busy' : 'later');
        cue('busy');
        break;
      case 'unknown-button':
        this.patch({ sending: null });
        this.flash('unknown');
        cue('failure');
        break;
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.g = null;
  }
}
