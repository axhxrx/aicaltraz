/**
 * What the UI talks to. Two implementations: `ws` (a real host) and `demo` (in-browser simulation).
 * Everything the UI renders comes from `snapshot`; the only other inputs are the async calls.
 */
import { buttonKey, type Config } from '../../core/config.ts';
import type { HostInfo, PressResult, Role, RunRecord, StateMap, WireConfig } from '../../core/protocol.ts';
import type { Store } from '../lib/store.ts';

/** connecting: never reached the host yet. offline: lost it, retrying. unauthorized: token rejected. */
export type ConnStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

/**
 * Host semantics (src/server/state-store.ts): a `cancel` press this soon after its run started is
 * taken as a double press and ignored. The demo mirrors it; the UI holds back the cancel hint.
 */
export const CANCEL_GRACE_MS = 700;

export interface Snapshot {
  status: ConnStatus;
  role: Role | null;
  /** Last known config (may be a cached copy while offline). */
  config: WireConfig | null;
  rev: string | null;
  states: StateMap;
  /**
   * Add to a host timestamp to get a local one (lib/clock.ts `wall()`, which is `Date.now()` unless
   * the device's clock was set meanwhile). Learned from every hello.
   */
  clockSkew: number;
  host: HostInfo | null;
  /** Hand-edited config file on the host is invalid (admins only). */
  configErrors: string[] | null;
  /** While not online: local time of the next connection attempt. */
  retryAt: number | null;
  /** Latched device state per button key (`@state` lines), e.g. "REC ●". */
  latched: Record<string, string>;
  /** The host turns connections away (503: too many devices connected). */
  hostFull: boolean;
  /** While not online: local (wall()) time of the last word from the host, if it ever spoke. */
  lastSeen: number | null;
}

export type SaveResult =
  /** `warnings`: saved, but the host has doubts (e.g. a program it can't find); paths like errors'. */
  | { ok: true; rev: string; warnings?: string[] }
  | { ok: false; kind: 'invalid'; errors: string[] }
  /** The config on the host isn't `baseRev` any more; `invalid`: its file is broken right now (`errors`). */
  | { ok: false; kind: 'conflict'; rev: string; invalid?: boolean; errors?: string[] }
  /** `unsure`: no answer (timeout, link dropped): the host may have saved it all the same. */
  | { ok: false; kind: 'error'; message: string; unsure?: boolean };

/** Max PUT /api/config body, as the host enforces it. */
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const TOO_LARGE = 'config too large (max 1 MB)';

export interface PressOpts {
  /** The user went through the button's confirm step (the host requires it for `confirm` buttons). */
  confirm?: boolean;
  /**
   * When the press was made: mono() (lib/env.ts), the clock of input events' own time stamps. A
   * stalled page sends it late; the press still says when the user made it (the `at` it carries,
   * in the host's clock), so the host drops it if that was too long ago. Absent: now.
   */
  at?: number;
  /** Runs when the press is on the wire. */
  onSent?: () => void;
  /** The host's whole answer, right before the promise resolves with its `result`. */
  onAck?: (ack: PressAck) => void;
}

/** `runId`: for started/queued/cancelling, the run the press started, queued behind or is cancelling. */
export interface PressAck {
  result: PressResult;
  runId?: number;
}

/**
 * Why a press has no ack. `sent: false`: it never left this device (not connected), so it surely
 * didn't run. `sent: true`: it went out but the link dropped before the ack, so it may have run.
 */
export class PressError extends Error {
  constructor(
    readonly sent: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'PressError';
  }
}

export interface Backend {
  readonly kind: 'ws' | 'demo';
  readonly snapshot: Store<Snapshot>;
  /**
   * Send a press; resolves with the host's ack, rejects with a PressError. A press is sent right
   * away or not at all (never queued for later: a press that fires late is worse than none), and
   * carries when it was made (`at`, host clock) so the host drops one that took too long to get
   * there (`expired`). `onSent` runs when it is on the wire. It never times out on its own: the UI
   * owns the 2 s "NO RESPONSE" rule, counted from `onSent`.
   */
  press(pad: string, button: string, opts?: PressOpts): Promise<PressResult>;
  /**
   * The link looks dead (e.g. a press went unacknowledged): check it now; reconnect if it is.
   * Offline (someone touched a button): try to connect now, not at the next retry.
   */
  kick(): void;
  /**
   * Admin: replace the config (PUT /api/config semantics; `force` replaces whatever is there). Gives
   * up after a while without an answer (`unsure`): it never hangs.
   */
  saveConfig(config: Config, baseRev: string, opts?: { force?: boolean }): Promise<SaveResult>;
  /** The host's config as it is right now (asked for, not the last broadcast, which may lag). Rejects when unreachable. */
  getConfig(): Promise<{ config: WireConfig; rev: string }>;
  /** Admin: recent runs, newest first. */
  runs(q?: { pad?: string; button?: string }): Promise<RunRecord[]>;
  dispose(): void;
}

export const emptySnapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  status: 'connecting',
  role: null,
  config: null,
  rev: null,
  states: {},
  clockSkew: 0,
  host: null,
  configErrors: null,
  retryAt: null,
  latched: {},
  hostFull: false,
  lastSeen: null,
  ...over,
});

/**
 * The states of the buttons `config` has (the same object when that's all of them). A button a
 * config change drops (or renames) gets no last word from the host: its state goes with it.
 */
export function statesIn(states: StateMap, config: WireConfig): StateMap {
  const keys = new Set(config.pads.flatMap((p) => p.buttons.map((b) => buttonKey(p.id, b.id))));
  if (Object.keys(states).every((k) => keys.has(k))) return states;
  return Object.fromEntries(Object.entries(states).filter(([k]) => keys.has(k)));
}
