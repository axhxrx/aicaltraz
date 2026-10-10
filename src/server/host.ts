/**
 * The host: config store + state store + HTTP API + WebSocket, on one Bun.serve.
 * See docs/DESIGN.md ("Host") for the API.
 */
import type { Server, ServerWebSocket } from 'bun';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '../core/machine.ts';
import { PROTOCOL_VERSION, type ClientMsg, type ConfigConflict, type HostInfo, type Role, type ServerMsg } from '../core/protocol.ts';
import webApp from '../web/index.html';
import pkg from '../../package.json';
import { ConfigStore } from './config-store.ts';
import { bearerToken, loadSecrets, makeAuth, type Secrets } from './secrets.ts';
import { starterConfigText } from './starter.ts';
import { StateStore } from './state-store.ts';

export const VERSION: string = pkg.version;
const MAX_BODY = 1024 * 1024;
/** WebSocket connections, all roles together; more are refused with 503. */
export const MAX_CLIENTS = 64;
/** Of those, slots only admin connections may use. */
export const ADMIN_RESERVED = 8;

export interface HostOptions {
  configPath: string;
  /** Default: buttpad.secrets.json next to the config. */
  secretsPath?: string;
  /** Override config.server.host / config.server.port. Port 0 picks a free port. */
  host?: string;
  port?: number;
  rotateTokens?: boolean;
  tls?: { cert: string; key: string };
  /** Write the starter config when the config file is missing (default true). */
  createConfig?: boolean;
  log?: (msg: string) => void;
  /** File-watch debounce. */
  debounceMs?: number;
  /** Bun dev mode (HMR socket, source maps with absolute paths): local development only. Default false. */
  development?: boolean;
}

interface WsData {
  role: Role;
}

export interface Host {
  readonly server: Server<WsData>;
  readonly port: number;
  /** Address the server is bound to. */
  readonly hostname: string;
  readonly scheme: 'http' | 'https';
  readonly configPath: string;
  readonly secretsPath: string;
  readonly secrets: Secrets;
  readonly config: ConfigStore;
  readonly state: StateStore;
  readonly created: { config: boolean; secrets: boolean; rotatedTokens: boolean; fixedSecretsMode: boolean };
  readonly info: HostInfo;
  stop(): Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const unauthorized = () => json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
const forbidden = () => json({ error: 'admin token required' }, 403);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return { ok: false, status: 413, error: 'body too large (max 1 MB)' };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: 'could not read body' };
  }
  if (Buffer.byteLength(text) > MAX_BODY) return { ok: false, status: 413, error: 'body too large (max 1 MB)' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
}

/**
 * A page from another origin must not open a socket (cross-site WebSocket hijacking). Browsers always
 * send Origin on WebSocket upgrades; other clients (curl, scripts) send none and are allowed.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === (req.headers.get('host') ?? '').toLowerCase();
  } catch {
    return false;
  }
}

/** Validates a client frame; returns an error message for anything malformed. */
export function parseClientMsg(raw: string | Buffer): ClientMsg | string {
  if (typeof raw !== 'string') return 'expected a JSON text frame';
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return 'invalid JSON';
  }
  if (!isRecord(m)) return 'expected a JSON object';
  if (m.t !== 'press') return `unknown message type ${JSON.stringify(m.t ?? null)}`;
  for (const k of ['id', 'pad', 'button'] as const)
    if (typeof m[k] !== 'string' || !m[k] || m[k].length > 200) return `press: "${k}" must be a non-empty string`;
  return { t: 'press', id: m.id as string, pad: m.pad as string, button: m.button as string };
}

const KNOWN_PATHS: [RegExp, string][] = [
  [/^\/api\/(health|state|runs)$/, 'GET'],
  [/^\/api\/config$/, 'GET, PUT'],
  [/^\/api\/press\/[^/]+\/[^/]+$/, 'POST'],
  [/^\/ws$/, 'GET'],
];

export async function startHost(opts: HostOptions): Promise<Host> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { store: config, created: createdConfig } = ConfigStore.open(opts.configPath, opts.createConfig === false ? undefined : starterConfigText);
  const secretsPath = opts.secretsPath ?? join(config.dir, 'buttpad.secrets.json');
  const sec = loadSecrets(secretsPath, { rotate: opts.rotateTokens });
  const auth = makeAuth(sec.secrets);
  const info: HostInfo = { name: osHostname(), version: VERSION, platform: process.platform };

  const clients = new Set<ServerWebSocket<WsData>>();
  const send = (ws: ServerWebSocket<WsData>, msg: ServerMsg) => ws.send(JSON.stringify(msg));
  const broadcast = (msg: ServerMsg, role?: Role) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (!role || ws.data.role === role) ws.send(text);
  };
  const broadcastState = (key: string, state: RunState) => broadcast({ t: 'state', key, state });

  const state = new StateStore(config.config, {
    baseDir: config.dir,
    log,
    onState: broadcastState,
    onRunStart: (key, runId) => log(`▶ ${key} #${runId}`),
    onRunEnd: (key, rec, o) => {
      const secs = (o.durationMs / 1000).toFixed(1);
      const how = rec.reason === 'exit' ? (o.exitCode === 0 ? '✓' : `✗ exit ${o.exitCode ?? o.signal}`) : `✗ ${rec.reason}`;
      log(`${how} ${key} #${rec.runId} ${secs}s${o.text ? `: ${o.text}` : ''}`);
    },
  });

  config.subscribe({
    change: (cfg, rev, prev) => {
      const added = state.setConfig(cfg);
      broadcast({ t: 'config', config: config.wire('admin'), rev }, 'admin');
      broadcast({ t: 'config', config: config.wire('press'), rev }, 'press');
      for (const key of added) broadcastState(key, state.get(key)!);
      log(`config reloaded (rev ${rev})`);
      if (cfg.server.host !== prev.server.host || cfg.server.port !== prev.server.port)
        log('config "server" changed: restart ButtPad to listen on the new host/port');
    },
    error: (errors) => {
      log(`config file is invalid; keeping the previous config:\n  ${errors.join('\n  ')}`);
      broadcast({ t: 'configError', errors }, 'admin');
    },
  });

  const withRole =
    <R extends Request>(need: Role | 'any', handler: (req: R, role: Role) => Response | Promise<Response>) =>
    (req: R) => {
      const role = auth(bearerToken(req));
      if (!role) return unauthorized();
      if (need === 'admin' && role !== 'admin') return forbidden();
      return handler(req, role);
    };

  let refusingClients = false;
  const server = Bun.serve({
    hostname: opts.host ?? config.config.server.host,
    port: opts.port ?? config.config.server.port,
    development: opts.development ?? false,
    // Bun turns SO_REUSEPORT on when `development: false`; a second host on the same port must fail instead.
    reusePort: false,
    maxRequestBodySize: MAX_BODY,
    ...(opts.tls ? { tls: { cert: Bun.file(opts.tls.cert), key: Bun.file(opts.tls.key) } } : {}),
    routes: {
      '/': webApp,
      '/ws': (req, srv) => {
        if (!sameOrigin(req)) return json({ error: 'cross-origin WebSocket refused' }, 403);
        const role = auth(new URL(req.url).searchParams.get('token'));
        if (!role) return unauthorized();
        // Press tokens get handed out freely (QR codes), so they can't take the slots admins need.
        const full =
          clients.size >= MAX_CLIENTS ||
          (role === 'press' && [...clients].filter((c) => c.data.role === 'press').length >= MAX_CLIENTS - ADMIN_RESERVED);
        if (full) {
          if (!refusingClients) log(`refusing WebSocket connections: ${clients.size} open (max ${MAX_CLIENTS})`);
          refusingClients = true;
          return json({ error: `too many connections (max ${MAX_CLIENTS})` }, 503);
        }
        refusingClients = false;
        // open() runs inside upgrade(), so `clients` is up to date for the next request.
        if (srv.upgrade(req, { data: { role } })) return;
        return json({ error: 'expected a WebSocket upgrade' }, 426);
      },
      // No hostname here: anyone (even a DNS-rebinding page) can call this. `hello` carries it.
      '/api/health': { GET: () => json({ ok: true, version: VERSION, protocol: PROTOCOL_VERSION }) },
      '/api/config': {
        GET: withRole('any', (_req, role) => json({ config: config.wire(role), rev: config.rev })),
        PUT: withRole('admin', async (req) => {
          const body = await readJson(req);
          if (!body.ok) return json({ errors: [body.error] }, body.status);
          const b = body.value;
          if (!isRecord(b) || typeof b.baseRev !== 'string' || !('config' in b) || (b.force !== undefined && typeof b.force !== 'boolean'))
            return json({ errors: ['body must be {"config": {…}, "baseRev": "…", "force"?: true}'] }, 400);
          let r;
          try {
            r = config.save(b.config, b.baseRev, { force: b.force === true });
          } catch (e) {
            const error = `could not write ${config.path}: ${(e as Error).message}`;
            log(error);
            return json({ error, errors: [error] }, 500);
          }
          if (r.ok) return json({ rev: r.rev });
          if (r.status === 400) return json({ errors: r.errors }, 400);
          return json(r.invalid ? ({ rev: r.rev, invalid: true, errors: r.errors } satisfies ConfigConflict) : ({ rev: r.rev } satisfies ConfigConflict), 409);
        }),
      },
      '/api/state': { GET: withRole('any', () => json({ states: state.states(), serverNow: Date.now() })) },
      '/api/press/:pad/:button': {
        POST: withRole('any', (req) => {
          const r = state.press(req.params.pad, req.params.button);
          if (r.result === 'unknown-button') return json({ result: r.result, error: `unknown button ${r.key}` }, 404);
          return json({ result: r.result, state: r.state });
        }),
      },
      '/api/runs': {
        GET: withRole('admin', (req) => {
          const q = new URL(req.url).searchParams;
          return json(state.runs({ pad: q.get('pad') || undefined, button: q.get('button') || undefined }));
        }),
      },
    },
    fetch(req) {
      const path = new URL(req.url).pathname;
      const allow = KNOWN_PATHS.find(([re]) => re.test(path))?.[1];
      if (allow) return json({ error: 'method not allowed' }, 405, { allow });
      return json({ error: 'not found' }, 404);
    },
    error(e) {
      log(`request failed: ${e.stack ?? e.message}`);
      return json({ error: 'internal error' }, 500);
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: 64 * 1024,
      open(ws) {
        clients.add(ws);
        const role = ws.data.role;
        send(ws, {
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          role,
          config: config.wire(role),
          rev: config.rev,
          states: state.states(),
          serverNow: Date.now(),
          host: info,
        });
        if (role === 'admin' && config.fileErrors) send(ws, { t: 'configError', errors: config.fileErrors });
      },
      message(ws, raw) {
        const msg = parseClientMsg(raw);
        if (typeof msg === 'string') return void send(ws, { t: 'error', message: msg });
        state.press(msg.pad, msg.button, (result, key) => send(ws, { t: 'ack', id: msg.id, key, result }));
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  config.watch(opts.debounceMs);

  let stopping: Promise<void> | undefined;
  return {
    server,
    port: server.port ?? 0,
    hostname: server.hostname ?? '',
    scheme: opts.tls ? 'https' : 'http',
    configPath: config.path,
    secretsPath,
    secrets: sec.secrets,
    config,
    state,
    created: { config: createdConfig, secrets: sec.created, rotatedTokens: sec.rotated, fixedSecretsMode: sec.fixedMode },
    info,
    stop: () =>
      (stopping ??= (async () => {
        config.close();
        for (const ws of clients) ws.close(1001, 'host shutting down');
        await Promise.all([state.shutdown(), server.stop(true)]);
      })()),
  };
}
