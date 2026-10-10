/**
 * Client-side half of a button: turns pointer/key input into fires (hold/tap/double, drift,
 * confirm) and owns the client-only states (ARMING, CONFIRM, SENDING, NO RESPONSE, BUSY flash).
 * Host state stays authoritative; this only decorates it. Framework-free; RunButton wires it up.
 */
import type { RunState } from '../../core/machine.ts';
import type { PressResult, WireButton } from '../../core/protocol.ts';
import { cue, haptic, unlockAudio } from '../lib/feedback.ts';
import { createStore } from '../lib/store.ts';

export const DOUBLE_TAP_MS = 400;
export const ACK_TIMEOUT_MS = 2000;
const NO_RESPONSE_SHOW_MS = 2600;
const FLASH_MS = 1200;
/** After a 'started' ack, wait this long at most for the host's state broadcast. */
const STATE_GRACE_MS = 1500;

export type FlashKind = 'busy' | 'unknown' | 'denied';

export interface Local {
  input: 'idle' | 'arming' | 'pressed' | 'double';
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
  host: RunState;
  online: boolean;
  press(): Promise<PressResult>;
  kick(): void;
}

const idle = (): Local => ({ input: 'idle', armAt: 0, armMs: 0, disarmAt: 0, firedAt: 0, confirmUntil: 0, sending: null, noResponse: null, flash: null });

interface Active {
  src: string;
  x0: number;
  y0: number;
  fired: boolean;
  /** Second tap of a double. */
  second: boolean;
}

export class ButtonController {
  readonly local = createStore<Local>(idle());
  private ctx: ControllerCtx | null = null;
  private active: Active | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sendSeq = 0;
  /** runId below which a finished run is not "ours" (for success/failure haptics). */
  private mine: number | null = null;

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

  /** Host state changed: settle SENDING, and give feedback when our run finishes. */
  onHost(host: RunState): void {
    const s = this.l.sending;
    if (s && host.runId > s.baseRunId) this.patch({ sending: null });
    const nr = this.l.noResponse;
    if (nr && host.runId > nr.baseRunId) this.patch({ noResponse: null });
    if (this.mine !== null && host.runId > this.mine && (host.phase === 'success' || host.phase === 'failure')) {
      this.mine = null;
      cue(host.phase);
    }
  }

  // ---- input ----------------------------------------------------------------------------------

  /** Returns false if the button is already busy with another pointer/key. */
  down(src: string, x: number, y: number): boolean {
    const ctx = this.ctx;
    if (!ctx || this.active) return false;
    unlockAudio();
    if (!ctx.online) {
      this.patch({ flash: { kind: 'denied', at: Date.now() } });
      cue('denied');
      this.after('flash', FLASH_MS, () => this.patch({ flash: null }));
      return false;
    }
    const second = this.l.input === 'double';
    this.clear('double');
    this.active = { src, x0: x, y0: y, fired: false, second };
    const { trigger, holdMs } = ctx.button;
    if (trigger === 'hold') {
      haptic('touch');
      this.patch({ input: 'arming', armAt: Date.now(), armMs: holdMs });
      this.after('hold', holdMs, () => {
        if (!this.active || this.active.src !== src) return;
        this.active.fired = true;
        this.patch({ input: 'idle' });
        this.fire();
      });
    } else this.patch({ input: 'pressed' });
    return true;
  }

  move(src: string, x: number, y: number): void {
    const a = this.active;
    if (!a || a.src !== src || a.fired || !this.ctx) return;
    if (Math.hypot(x - a.x0, y - a.y0) > this.ctx.button.driftPx) this.abort(src);
  }

  up(src: string): void {
    const a = this.active;
    if (!a || a.src !== src || !this.ctx) return;
    this.active = null;
    this.clear('hold');
    const { trigger } = this.ctx.button;
    if (trigger === 'hold') {
      if (!a.fired) this.patch({ input: 'idle', disarmAt: Date.now() });
    } else if (trigger === 'tap' || a.second) {
      this.patch({ input: 'idle' });
      this.fire();
    } else {
      this.patch({ input: 'double' });
      this.after('double', DOUBLE_TAP_MS, () => this.patch({ input: 'idle' }));
    }
  }

  /** Drift, pointercancel, lost capture, window blur. */
  abort(src: string): void {
    const a = this.active;
    if (!a || a.src !== src) return;
    this.active = null;
    this.clear('hold');
    if (a.fired) return;
    this.patch({ input: 'idle', disarmAt: this.l.input === 'arming' ? Date.now() : this.l.disarmAt });
  }

  // ---- firing ---------------------------------------------------------------------------------

  private fire() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = Date.now();
    this.patch({ firedAt: now });
    const { button, host } = ctx;
    const starts = host.phase !== 'running' || button.whileRunning === 'queue';
    if (button.confirm && starts) {
      if (now < this.l.confirmUntil) {
        this.clear('confirm');
        this.patch({ confirmUntil: 0 });
      } else {
        cue('confirm');
        this.patch({ confirmUntil: now + button.confirmWindowMs });
        this.after('confirm', button.confirmWindowMs, () => this.patch({ confirmUntil: 0 }));
        return;
      }
    }
    cue('fire');
    this.send();
  }

  private send() {
    const ctx = this.ctx;
    if (!ctx || this.l.sending) return;
    const seq = ++this.sendSeq;
    const baseRunId = ctx.host.runId;
    this.clear('noResponse');
    this.patch({ sending: { at: Date.now(), baseRunId, acked: false }, noResponse: null, flash: null });
    this.after('ack', ACK_TIMEOUT_MS, () => seq === this.sendSeq && this.noResponse(baseRunId));
    ctx.press().then(
      (r) => seq === this.sendSeq && this.onAck(r, baseRunId),
      () => seq === this.sendSeq && this.noResponse(baseRunId),
    );
  }

  private noResponse(baseRunId: number) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    this.sendSeq++;
    const now = Date.now();
    this.patch({ sending: null, noResponse: { at: now, until: now + NO_RESPONSE_SHOW_MS, baseRunId } });
    if (this.ctx?.online) cue('failure');
    this.ctx?.kick();
    this.after('noResponse', NO_RESPONSE_SHOW_MS, () => this.patch({ noResponse: null }));
  }

  private onAck(result: PressResult, baseRunId: number) {
    const s = this.l.sending;
    if (!s || s.acked) return;
    this.clear('ack');
    const host = this.ctx?.host;
    switch (result) {
      case 'started':
        this.mine = baseRunId;
        if (host && host.runId > baseRunId) this.patch({ sending: null });
        else {
          this.patch({ sending: { ...s, acked: true } });
          this.after('grace', STATE_GRACE_MS, () => this.patch({ sending: null }));
        }
        break;
      case 'queued':
        this.mine = host?.runId ?? baseRunId;
        this.patch({ sending: null });
        break;
      case 'cancelling':
        this.mine = (host?.runId ?? baseRunId) - 1;
        this.patch({ sending: null });
        break;
      case 'ignored':
      case 'unknown-button':
        this.patch({ sending: null, flash: { kind: result === 'ignored' ? 'busy' : 'unknown', at: Date.now() } });
        cue(result === 'ignored' ? 'busy' : 'failure');
        this.after('flash', FLASH_MS, () => this.patch({ flash: null }));
        break;
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.active = null;
  }
}
