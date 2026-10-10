/**
 * Wire protocol between a ButtPad host and its clients. WebSocket at /ws?token=…, JSON text frames.
 * HTTP endpoints are documented in docs/DESIGN.md.
 */
import type { Action, Button, Config, Pad } from './config.ts';
import type { RunState } from './machine.ts';

export const PROTOCOL_VERSION = 1;

/** press: can see pads and press buttons. admin: can also see actions and edit config. */
export type Role = 'press' | 'admin';

/** Buttons as a press-role client sees them: `action` is stripped (admins get the full Config). */
export type WireButton = Omit<Button, 'action'> & { action?: Action };
export type WirePad = Omit<Pad, 'buttons'> & { buttons: WireButton[] };
export type WireConfig = Omit<Config, 'pads'> & { pads: WirePad[] };

/** Keyed by buttonKey(padId, buttonId) = `${padId}/${buttonId}`. */
export type StateMap = Record<string, RunState>;

/** How the host handled a press. */
export type PressResult = 'started' | 'ignored' | 'cancelling' | 'queued' | 'unknown-button';

export interface HostInfo {
  name: string;
  version: string;
  platform: string;
}

export type ServerMsg =
  | {
      t: 'hello';
      protocol: number;
      role: Role;
      config: WireConfig;
      /** Opaque config revision; PUT /api/config must send it back as baseRev. */
      rev: string;
      states: StateMap;
      /** Host clock (ms epoch), so clients can compute elapsed time with an offset. */
      serverNow: number;
      host: HostInfo;
    }
  | { t: 'config'; config: WireConfig; rev: string }
  | { t: 'state'; key: string; state: RunState }
  | { t: 'ack'; id: string; key: string; result: PressResult }
  /** Config file on disk was edited by hand and is invalid; the host keeps running the old one. Admins only. */
  | { t: 'configError'; errors: string[] }
  | { t: 'error'; message: string };

export type ClientMsg = {
  t: 'press';
  /** Client-generated id, echoed in the ack. */
  id: string;
  pad: string;
  button: string;
};

/** PUT /api/config (admin). */
export interface SaveConfigBody {
  config: unknown;
  /** The rev the edit is based on: the host refuses (409) unless it names the config file's bytes as they are now. */
  baseRev: string;
  /** Replace the file whatever is there now (the user chose to overwrite, e.g. a broken file). */
  force?: boolean;
}

/** PUT /api/config → 409. */
export interface ConfigConflict {
  /** Rev of the config file's bytes now. */
  rev: string;
  /** Those bytes aren't a valid config (the host still runs the previous one); `errors` says why. */
  invalid?: true;
  errors?: string[];
}

/** One finished (or running) execution, as returned by GET /api/runs (admin). */
export interface RunRecord {
  runId: number;
  pad: string;
  button: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  reason?: 'exit' | 'timeout' | 'spawn' | 'cancelled';
  /** Tails, capped (see DESIGN.md). */
  stdout: string;
  stderr: string;
}
