/**
 * Run mode for one backend: a controller per button on every pad, fed the host's state as it
 * arrives. They outlive pad switches, so a run's outcome still buzzes after switching pads, and a
 * key can press a button on a pad that isn't on screen. Also the pad-wide input rules (rough mode's
 * one button at a time, palms), toasts, and the marks pad tabs show for other pads.
 */
import { buttonKey } from '../../core/config.ts';
import type { RunState } from '../../core/machine.ts';
import type { WireButton, WirePad } from '../../core/protocol.ts';
import type { Backend, PressAck, Snapshot } from '../backend/types.ts';
import { wall } from '../lib/clock.ts';
import { eventTime } from '../lib/env.ts';
import { settings } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import { ButtonController, resultShown } from './controller.ts';
import { keyName, READY } from './view.ts';

/** Contacts landing on this many buttons within PALM_MS: a palm or a sleeve, not presses. */
const PALM_BUTTONS = 3;
const PALM_MS = 60;
const TOAST_MS = 2600;

export interface Toast {
  text: string;
  at: number;
  tone: 'info' | 'warn';
}

/** What a pad's tab shows about its buttons: something failed (or needs a look), or is running. */
export type PadMark = 'failure' | 'running';

interface Entry {
  key: string;
  ctrl: ButtonController;
  pad: WirePad;
  button: WireButton;
  off: () => void;
}

const ALIASES: Record<string, string> = { space: ' ', spacebar: ' ', esc: 'Escape', return: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const norm = (k: string) => ALIASES[k.toLowerCase()] ?? k;

/** The button on `buttons` that `key` (KeyboardEvent.key) presses: an exact name, else a letter in either case. */
export function matchKey(buttons: WireButton[], key: string): WireButton | undefined {
  return (
    buttons.find((b) => b.key !== undefined && norm(b.key) === key) ??
    (key.length === 1 ? buttons.find((b) => b.key !== undefined && b.key.length === 1 && b.key.toLowerCase() === key.toLowerCase()) : undefined)
  );
}

const typing = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]');
/** Enter/Space on a focused control (menu button, tabs, switches) belong to that control. */
const control = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a[href], summary, [role=switch], [role=tab]');

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export class RunSession {
  readonly toast = createStore<Toast | null>(null);
  readonly marks = createStore<Record<string, PadMark>>({});
  private entries = new Map<string, Entry>();
  private visible: string | null = null;
  /** Recent press starts (event time), for palm detection. */
  private starts: { key: string; t: number }[] = [];
  private palmUntil = -Infinity;
  private prev: Snapshot;
  private readonly offs: (() => void)[] = [];
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly backend: Backend) {
    this.prev = backend.snapshot.get();
    this.sync(this.prev);
    this.offs.push(backend.snapshot.subscribe((s) => this.onSnapshot(s)));
    this.updateMarks();
  }

  private onSnapshot(s: Snapshot) {
    const p = this.prev;
    this.prev = s;
    if (s.config !== p.config) this.sync(s);
    // A hello (or the demo coming back) brings states whose runs this device didn't see start.
    const live = p.status === 'online' && s.status === 'online';
    if (s.states !== p.states)
      for (const e of this.entries.values()) {
        const st = s.states[e.key];
        if (st && st !== p.states[e.key]) e.ctrl.onHost(st, live);
      }
    if (s.status !== p.status) for (const e of this.entries.values()) e.ctrl.onLink(s.status === 'online');
    this.updateMarks();
  }

  /** Controllers for every button in the config; a button that moved under a finger lets go. */
  private sync(s: Snapshot) {
    const cfg = s.config;
    if (!cfg) return;
    const seen = new Set<string>();
    for (const pad of cfg.pads)
      for (const b of pad.buttons) {
        const key = buttonKey(pad.id, b.id);
        seen.add(key);
        const e = this.entries.get(key);
        if (!e) {
          this.add(pad, b);
          continue;
        }
        // The finger would now be on another button, or none: that press is off (I11).
        const moved = b.x !== e.button.x || b.y !== e.button.y || b.w !== e.button.w || b.h !== e.button.h || pad.cols !== e.pad.cols || pad.rows !== e.pad.rows;
        if (moved && e.ctrl.pressing) e.ctrl.letGo('moved');
        e.button = b;
        e.pad = pad;
      }
    for (const [key, e] of this.entries) {
      if (seen.has(key)) continue;
      e.ctrl.letGo('moved');
      e.off();
      e.ctrl.dispose();
      this.entries.delete(key);
    }
  }

  private add(pad: WirePad, button: WireButton): Entry {
    const key = buttonKey(pad.id, button.id);
    const ctrl = new ButtonController();
    const e: Entry = { key, ctrl, pad, button, off: () => {} };
    this.entries.set(key, e);
    const snap = () => this.backend.snapshot.get();
    ctrl.setCtx({
      button: () => e.button,
      host: (): RunState => snap().states[key] ?? READY,
      online: () => snap().status === 'online',
      rough: () => settings.get().rough,
      press: (opts) => {
        let acked = false;
        const onAck = (a: PressAck) => {
          acked = true;
          opts.onAck(a);
        };
        // A backend that only resolves (no onAck) still gets its answer through.
        return this.backend.press(e.pad.id, e.button.id, { confirm: opts.confirm, onSent: opts.onSent, onAck }).then((result) => acked || onAck({ result }));
      },
      kick: () => this.backend.kick(),
      mayStart: (t) => this.mayStart(e, t),
      started: (t) => this.starts.push({ key, t }),
    });
    e.off = ctrl.local.subscribe(() => this.updateMarks());
    return e;
  }

  /** The controller of a button (made on the spot for one the config doesn't list yet). */
  controller(pad: WirePad, button: WireButton): ButtonController {
    return (this.entries.get(buttonKey(pad.id, button.id)) ?? this.add(pad, button)).ctrl;
  }

  /** The pad on screen (null: none). Presses on buttons that left the screen let go. */
  setVisible(padId: string | null): void {
    if (padId === this.visible) return;
    this.visible = padId;
    for (const e of this.entries.values()) if (e.pad.id !== padId && e.ctrl.pressing) e.ctrl.letGo('hidden');
  }

  private mayStart(e: Entry, t: number): boolean {
    // A palm (or a sleeve) lands on several buttons at once: none of those contacts is a press.
    if (t < this.palmUntil) return false;
    this.starts = this.starts.filter((s) => t - s.t < 1000);
    const recent = this.starts.filter((s) => s.key !== e.key && Math.abs(t - s.t) <= PALM_MS && this.entries.get(s.key)?.ctrl.pressing);
    if (new Set(recent.map((s) => s.key)).size >= PALM_BUTTONS - 1) {
      for (const s of recent) this.entries.get(s.key)?.ctrl.drop();
      this.palmUntil = t + PALM_MS;
      this.starts = [];
      return false;
    }
    // Rough mode: one button at a time per pad; a second contact on another button is ignored.
    if (settings.get().rough) for (const o of this.entries.values()) if (o !== e && o.pad.id === e.pad.id && o.ctrl.pressing) return false;
    return true;
  }

  private updateMarks() {
    const s = this.backend.snapshot.get();
    const now = wall();
    const out: Record<string, PadMark> = {};
    for (const e of this.entries.values()) {
      const host = s.states[e.key] ?? READY;
      const l = e.ctrl.local.get();
      const kept = resultShown(l, host, now) && l.result!.kind !== 'ran';
      if (kept || (host.phase === 'failure' && host.reason !== 'cancelled')) out[e.pad.id] = 'failure';
      else if (host.phase === 'running' && !out[e.pad.id]) out[e.pad.id] = 'running';
    }
    if (!same(out, this.marks.get())) this.marks.set(out);
  }

  say(text: string, tone: Toast['tone'] = 'info'): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ text, at: wall(), tone });
    this.toastTimer = setTimeout(() => this.toast.set(null), TOAST_MS);
  }

  /**
   * Keys are global (BLE remotes pair as keyboards). A key presses the button on the pad on screen
   * that has it; else the one button on any other pad that has it (with a toast saying which); when
   * several other pads have it, nothing (a toast says so). `onKey` runs when a key fires a button
   * (the app closes its menu: keys keep working while it's open). Returns the cleanup.
   */
  listenKeys(onKey: () => void): () => void {
    const held = new Set<string>();
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if ((e.key === 'Enter' || e.key === ' ') && control(e.target)) return;
      const cfg = this.prev.config;
      if (!cfg) return;
      const visible = cfg.pads.find((p) => p.id === this.visible);
      let pad = visible;
      let b = visible ? matchKey(visible.buttons, e.key) : undefined;
      if (!b) {
        const elsewhere = cfg.pads.flatMap((p) => {
          const m = p === visible ? undefined : matchKey(p.buttons, e.key);
          return m ? [{ p, m }] : [];
        });
        if (!elsewhere.length) return;
        e.preventDefault();
        if (e.repeat) return;
        if (elsewhere.length > 1) {
          this.say(`${keyName(e.key)} is on ${elsewhere.length} pads (${elsewhere.map((x) => x.p.name).join(', ')}): open the one you mean`, 'warn');
          return;
        }
        [pad, b] = [elsewhere[0]!.p, elsewhere[0]!.m];
      }
      e.preventDefault();
      const code = e.code || e.key;
      if (e.repeat || held.has(code) || !pad) return;
      held.add(code);
      onKey();
      if (pad !== visible) this.say(`▶ ${b.label || b.id} (${pad.name})`);
      this.controller(pad, b).key(eventTime(e));
    };
    const up = (e: KeyboardEvent) => {
      if (held.delete(e.code || e.key)) e.preventDefault();
    };
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }

  dispose(): void {
    clearTimeout(this.toastTimer);
    for (const off of this.offs) off();
    for (const e of this.entries.values()) {
      e.off();
      e.ctrl.dispose();
    }
    this.entries.clear();
  }
}
