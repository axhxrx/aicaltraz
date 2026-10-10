/**
 * What the UI talks to. Two implementations: `ws` (a real host) and `demo` (in-browser simulation).
 * Everything the UI renders comes from `snapshot`; the only other inputs are the async calls.
 */
import type { Config } from '../../core/config.ts';
import type { HostInfo, PressResult, Role, RunRecord, StateMap, WireConfig } from '../../core/protocol.ts';
import type { Store } from '../lib/store.ts';

/** connecting: never reached the host yet. offline: lost it, retrying. unauthorized: token rejected. */
export type ConnStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface Snapshot {
  status: ConnStatus;
  role: Role | null;
  /** Last known config (may be a cached copy while offline). */
  config: WireConfig | null;
  rev: string | null;
  states: StateMap;
  /** Add to a host timestamp to get a local `Date.now()` timestamp. */
  clockSkew: number;
  host: HostInfo | null;
  /** Hand-edited config file on the host is invalid (admins only). */
  configErrors: string[] | null;
  /** While not online: local time of the next connection attempt. */
  retryAt: number | null;
}

export type SaveResult =
  | { ok: true; rev: string }
  | { ok: false; kind: 'invalid'; errors: string[] }
  | { ok: false; kind: 'conflict'; rev: string }
  | { ok: false; kind: 'error'; message: string };

export interface Backend {
  readonly kind: 'ws' | 'demo';
  readonly snapshot: Store<Snapshot>;
  /**
   * Send a press; resolves with the host's ack. Rejects when not connected or the link drops.
   * It never times out on its own: the UI owns the 2 s "NO RESPONSE" rule.
   */
  press(pad: string, button: string): Promise<PressResult>;
  /** The link looks dead (e.g. a press went unacknowledged): reconnect right away. */
  kick(): void;
  /** Admin: replace the config (PUT /api/config semantics). */
  saveConfig(config: Config, baseRev: string): Promise<SaveResult>;
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
  ...over,
});
