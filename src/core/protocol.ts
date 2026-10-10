/** Wire protocol between a ButtPad host and its clients (WebSocket at /ws, JSON text frames). */
import type { Config } from './config.ts';
import type { RunState } from './machine.ts';

export type Role = 'press' | 'admin';

/** Keyed by `${padId}/${buttonId}`. */
export type StateMap = Record<string, RunState>;

export type ServerMsg =
  | { t: 'hello'; role: Role; config: Config; states: StateMap; serverNow: number; host: string }
  | { t: 'config'; config: Config }
  | { t: 'state'; key: string; state: RunState }
  | { t: 'error'; message: string };

export type ClientMsg = { t: 'press'; pad: string; button: string };

export const PROTOCOL_VERSION = 1;
