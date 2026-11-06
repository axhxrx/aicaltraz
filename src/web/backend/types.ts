/**
 * What the UI talks to. Two implementations: `ws` (a real host) and `demo` (in-browser simulation).
 * Everything the UI renders comes from `snapshot`; the only other inputs are the async calls.
 */
import { buttonKey, type Config } from '../../core/config.ts';
import { PRESS_MAX_AGE_MS, type HostInfo, type PressResult, type Role, type RunRecord, type StateMap, type WireButton, type WireConfig } from '../../core/protocol.ts';
import type { Store } from '../lib/store.ts';

/**
 * How late a press of `b` may reach the host and still run: its maxLatenessMs (the host drops one
 * older than that as `expired`). A config from a host that predates the field (or a cached one)
 * has none: the old fixed 3 s.
 */
export function latenessOf(b: Pick<WireButton, 'maxLatenessMs'> | undefined): number {
  const v = b?.maxLatenessMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : PRESS_MAX_AGE_MS;
}

/** A button of a wire config, by pad and button id. */
export const wireButton = (config: WireConfig | null, pad: string, button: string): WireButton | undefined =>
  config?.pads.find((p) => p.id === pad)?.buttons.find((b) => b.id === button);

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
  /**
   * The host turns this page's address away (403: its Origin isn't the host's own, nor one it was
   * told about with --allow-origin): a reverse proxy, tunnel or preview pane in front of it.
   */
  originRefused: boolean;
  /** With `originRefused`: the exact `--allow-origin` value the host's 403 names (`OriginRefusal`); null: it didn't say. */
  allowOrigin: string | null;
  /** While not online: local (wall()) time of the last word from the host, if it ever spoke. */
  lastSeen: number | null;
  /**
   * Back from a long stretch in the background (or a frozen tab): what the screen showed may be
   * minutes old, and what the socket delivers first may be a backlog of them. Until the host's
   * current word is in (a fresh hello, or the answer to a ping sent on waking, which comes after
   * the backlog), nothing is shown as live and presses wait.
   */
  syncing: boolean;
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
  /**
   * How long a press that is on the wire should wait for its ack before the UI says NO RESPONSE,
   * from the round trips this link has been taking (absent: the UI's fixed 2 s).
   */
  ackTimeoutMs?(): number;
  /**
   * Admin: a one-time pairing code for another device (POST /api/pair-code). Rejects with a
   * message in words (not admin, an older host, unreachable).
   */
  pairCode?(): Promise<PairCode>;
  /**
   * The page hasn't been running for a while and doesn't know it yet (its heartbeat is overdue: a
   * frozen tab that just woke). Asked while rendering: the first render after a freeze (a running
   * clock's tick, say) must not show the minutes-old picture as live; `syncing` follows at once.
   */
  isStale?(): boolean;
  dispose(): void;
}

/** A one-time code another device can trade for a token (POST /api/pair-code → this; /api/pair takes it). */
export interface PairCode {
  code: string;
  /** Host clock, epoch ms. */
  expiresAt: number;
  role: Role;
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
  originRefused: false,
  allowOrigin: null,
  lastSeen: null,
  syncing: false,
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
