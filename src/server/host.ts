/**
 * The host: config store + state store + HTTP API + WebSocket, on one Bun.serve.
 * See docs/DESIGN.md ("Host") for the API.
 */
import type { Server, ServerWebSocket } from 'bun';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '../core/machine.ts';
import {
  PROTOCOL_VERSION,
  type ClientMsg,
  type ConfigConflict,
  type HostInfo,
  type OriginRefusal,
  type PairResponse,
  type Role,
  type ServerMsg,
  type WsTicket,
} from '../core/protocol.ts';
import webApp from '../web/index.html';
import pkg from '../../package.json';
import { ConfigStore } from './config-store.ts';
import { configWarnings } from './config-warnings.ts';
import { errnoText, listenError } from './errors.ts';
import { WriteError } from './files.ts';
import { ThrottledLog } from './limits.ts';
import { Pairing, type PairCode, type PairLimits } from './pairing.ts';
import { STATE_FILE } from './persist.ts';
import { sanitizeLog } from './runner.ts';
import { bearerToken, loadSecrets, makeAuth, WsTickets, type Secrets } from './secrets.ts';
import { starterConfigText } from './starter.ts';
import { runEndLine, StateStore, type PressReply, type StartLimits } from './state-store.ts';
import { WebAssets } from './web-assets.ts';

export const VERSION: string = pkg.version;
const MAX_BODY = 1024 * 1024;
/** WebSocket connections, all roles together; more are refused with 503. */
export const MAX_CLIENTS = 64;
/** Of those, slots only admin connections may use. */
export const ADMIN_RESERVED = 8;
/** WebSocket connections from one client address, all roles together. */
export const MAX_CLIENTS_PER_ADDRESS = 16;
/** Bodies of 503 responses: the web app says "Host is full". */
export const HOST_FULL = {
  connections: { error: 'host full', reason: 'too many connections' },
  rate: { error: 'host full', reason: 'rate limited' },
  busy: { error: 'host full', reason: 'too many running actions' },
} as const;

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
  /**
   * Build and compress the web app right after listening (the CLI does), so the first page load
   * doesn't wait for it. Otherwise that happens on the first request for the page.
   */
  preloadWebApp?: boolean;
  /** Run state that survives restarts. Default: buttpad.state.json next to the config. */
  statePath?: string;
  /** Override connection, press, pairing-attempt and WebSocket-ticket limits (tests). */
  limits?: {
    maxClients?: number;
    adminReserved?: number;
    clientsPerAddress?: number;
    presses?: Partial<StartLimits>;
    pairing?: Partial<PairLimits>;
    tickets?: { ttlMs?: number; perToken?: number };
  };
  /**
   * Origins (exact `scheme://host:port`, see parseOrigin) whose pages may open a WebSocket and
   * pair, besides the host's own: a reverse proxy in front of it (an HTTPS preview, a tunnel).
   */
  allowOrigins?: readonly string[];
}

interface WsData {
  role: Role;
  /** Client address, for the per-address connection cap. */
  address: string;
  /** Its presses' own rate limit. */
  source: ReturnType<StateStore['newSource']>;
}

export interface Host {
  readonly server: Server<WsData>;
  readonly port: number;
  /** Address the server is bound to. */
  readonly hostname: string;
  readonly scheme: 'http' | 'https';
  readonly configPath: string;
  readonly secretsPath: string;
  readonly statePath: string;
  readonly secrets: Secrets;
  readonly config: ConfigStore;
  readonly state: StateStore;
  readonly created: { config: boolean; secrets: boolean; rotatedTokens: boolean; fixedSecretsMode: boolean };
  readonly info: HostInfo;
  /** One-time pairing codes (POST /api/pair-code makes them, POST /api/pair takes them). */
  readonly pairing: Pairing;
  /** One-time WebSocket tickets (POST /api/ws-ticket makes them, `/ws?ticket=` takes them). */
  readonly tickets: WsTickets;
  /** What `allowOrigins` admits, normalized. */
  readonly allowOrigins: readonly string[];
  stop(): Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const unauthorized = () => json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
const forbidden = () => json({ error: 'admin token required' }, 403);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON body of at most `max` bytes (default 1 MB); `optional`: an empty one is `undefined`. */
async function readJson(req: Request, o: { optional?: boolean; max?: number } = {}): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const max = o.max ?? MAX_BODY;
  const tooLarge = { ok: false as const, status: 413, error: `body too large (max ${max >= 1024 * 1024 ? `${max / 1024 / 1024} MB` : `${max / 1024} KB`})` };
  if (Number(req.headers.get('content-length') ?? 0) > max) return tooLarge;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: 'could not read body' };
  }
  if (Buffer.byteLength(text) > max) return tooLarge;
  if (o.optional && !text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
}

/**
 * An exact origin as `--allow-origin` takes it — scheme (http/https), host, port; no path, query,
 * credentials or wildcard — normalized (`https://x.example:443/` → `https://x.example`), or
 * undefined when `s` isn't one.
 */
export function parseOrigin(s: string): string | undefined {
  const t = s.trim();
  if (!/^https?:\/\/[^/?#*@\s]+\/?$/i.test(t)) return undefined;
  try {
    const u = new URL(t);
    return u.origin === 'null' ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

/**
 * A page from another origin must not open a socket (cross-site WebSocket hijacking) or pair.
 * Browsers always send Origin on WebSocket upgrades and POSTs; other clients (curl, scripts) send
 * none and are allowed. Allowed: the host's own origin (Origin's host:port is the Host header), and
 * the exact origins in `allowed` (a reverse proxy in front of the host: see `--allow-origin`).
 */
export function originAllowed(req: Request, allowed: ReadonlySet<string> = new Set()): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    const u = new URL(origin);
    return u.host === (req.headers.get('host') ?? '').toLowerCase() || allowed.has(u.origin);
  } catch {
    return false;
  }
}

/** The host's own origin only: originAllowed without an allowlist. */
export const sameOrigin = (req: Request): boolean => originAllowed(req);

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
  const msg: ClientMsg = { t: 'press', id: m.id as string, pad: m.pad as string, button: m.button as string };
  if (m.at !== undefined && m.at !== null) {
    if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return 'press: "at" must be a number (when it was pressed, host clock, epoch ms)';
    msg.at = m.at;
  }
  if (m.confirm !== undefined && m.confirm !== null) {
    if (typeof m.confirm !== 'boolean') return 'press: "confirm" must be true or false';
    if (m.confirm) msg.confirm = true;
  }
  return msg;
}

/**
 * `at` and `confirm` of an HTTP press, from the query string (`?at=…&confirm=1`) or a JSON body
 * (`{"at": …, "confirm": true}`); both optional. A string says what's malformed.
 */
export async function pressOptions(req: Request): Promise<{ at?: number; confirm?: boolean } | string> {
  const q = new URL(req.url).searchParams;
  const out: { at?: number; confirm?: boolean } = {};
  const at = q.get('at');
  if (at !== null) {
    if (!/^\d+(\.\d+)?$/.test(at)) return '"at" must be a number (when it was pressed, host clock, epoch ms)';
    out.at = Number(at);
  }
  const confirm = q.get('confirm');
  if (confirm !== null) {
    if (['', '1', 'true', 'yes'].includes(confirm)) out.confirm = true;
    else if (['0', 'false', 'no'].includes(confirm)) out.confirm = false;
    else return '"confirm" must be 1 or 0';
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return 'could not read body';
  }
  if (!text.trim()) return out;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'body must be JSON, e.g. {"confirm": true}';
  }
  if (!isRecord(body)) return 'body must be a JSON object, e.g. {"confirm": true}';
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'number' || !Number.isFinite(body.at)) return '"at" must be a number (when it was pressed, host clock, epoch ms)';
    out.at = body.at;
  }
  if (body.confirm !== undefined && body.confirm !== null) {
    if (typeof body.confirm !== 'boolean') return '"confirm" must be true or false';
    out.confirm = body.confirm;
  }
  return out;
}

/** HTTP status and body for a press result (POST /api/press). */
export function pressResponse(r: PressReply): { status: number; body: Record<string, unknown> } {
  switch (r.result) {
    case 'unknown-button':
      return { status: 404, body: { result: r.result, error: `unknown button ${r.key}` } };
    case 'needs-confirm':
      return { status: 428, body: { result: r.result, error: `${r.key} asks for confirmation: press with ?confirm=1 or {"confirm": true}` } };
  }
  if (r.refused) return { status: 503, body: { ...HOST_FULL[r.refused], result: r.result } };
  return { status: 200, body: { result: r.result, ...(r.runId !== undefined ? { runId: r.runId } : {}), state: r.state } };
}

/** The client's address; an IPv4-mapped IPv6 one as plain IPv4. */
function addressOf(server: Server<WsData>, req: Request): string {
  const a = server.requestIP(req)?.address ?? 'unknown';
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

/** Where the bundle's files are: the page at `/`, the rest (hashed chunks) one level down. */
const ASSET_PATH = /^\/[\w.-]+$/;

const KNOWN_PATHS: [RegExp, string][] = [
  [/^\/api\/(health|state|runs)$/, 'GET'],
  [/^\/api\/config$/, 'GET, PUT'],
  [/^\/api\/press\/[^/]+\/[^/]+$/, 'POST'],
  [/^\/api\/pair(-code)?$/, 'POST'],
  // POST, not GET: a browser sends Origin on a same-origin POST, never on a same-origin GET.
  [/^\/api\/ws-(ticket|check)$/, 'POST'],
  [/^\/ws$/, 'GET'],
];

/** 403 `error`s of an origin refusal: the WebSocket (and its ticket and probe), pairing. */
const WS_REFUSED = 'cross-origin WebSocket refused';
const REQUEST_REFUSED = 'cross-origin request refused';

export async function startHost(opts: HostOptions): Promise<Host> {
  const sink = opts.log ?? ((m: string) => console.log(m));
  // The log goes to a terminal, and its lines quote the config and files (labels, paths, #! lines,
  // parse errors): no escape sequences or control characters get through.
  const log = (m: string) => sink(sanitizeLog(m));
  const { store: config, created: createdConfig } = ConfigStore.open(opts.configPath, opts.createConfig === false ? undefined : starterConfigText);
  const secretsPath = opts.secretsPath ?? join(config.dir, 'buttpad.secrets.json');
  const sec = loadSecrets(secretsPath, { rotate: opts.rotateTokens });
  const auth = makeAuth(sec.secrets);
  const info: HostInfo = { name: osHostname(), version: VERSION, platform: process.platform };
  const allowOrigins = [
    ...new Set(
      (opts.allowOrigins ?? []).map((o) => {
        const exact = parseOrigin(o);
        if (!exact) throw new Error(`not an origin: "${o}" (an exact one like https://buttpad.example.com, scheme, host and port; no path, no wildcard)`);
        return exact;
      }),
    ),
  ];
  const allowed = new Set(allowOrigins);
  const pairing = new Pairing({ log, limits: opts.limits?.pairing });
  const tickets = new WsTickets(opts.limits?.tickets);
  /**
   * A request refused for its Origin: logged with what the operator would change to allow it (at
   * most once per 10 s), and answered 403 with the same to the page (OriginRefusal).
   */
  const originRefusals = new ThrottledLog(log, () => performance.now());
  const refuseOrigin = (req: Request, what: string, error: string) => {
    const raw = req.headers.get('origin') ?? '';
    const origin = raw.slice(0, 200);
    const exact = raw.length <= 2048 ? parseOrigin(raw) : undefined;
    originRefusals.note(
      `refused ${what} from a page at ${origin} (the request's Host is ${(req.headers.get('host') ?? 'missing').slice(0, 200)}): not this host's own address. ` +
        (exact
          ? `If that is ButtPad through your reverse proxy (or a preview pane), start ButtPad with --allow-origin ${exact}`
          : 'An origin like that (opaque or malformed) can never be allowed'),
    );
    return json({ error, origin, ...(exact ? { allowOrigin: exact } : {}) } satisfies OriginRefusal, 403);
  };

  const clients = new Set<ServerWebSocket<WsData>>();
  /** Open connections per client address. */
  const perAddress = new Map<string, number>();
  const maxClients = opts.limits?.maxClients ?? MAX_CLIENTS;
  const adminReserved = opts.limits?.adminReserved ?? ADMIN_RESERVED;
  const clientsPerAddress = opts.limits?.clientsPerAddress ?? MAX_CLIENTS_PER_ADDRESS;
  const send = (ws: ServerWebSocket<WsData>, msg: ServerMsg) => ws.send(JSON.stringify(msg));
  const broadcast = (msg: ServerMsg, role?: Role) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (!role || ws.data.role === role) ws.send(text);
  };
  const broadcastState = (key: string, state: RunState) => broadcast({ t: 'state', key, state });

  const statePath = opts.statePath ?? join(config.dir, STATE_FILE);
  const state = new StateStore(config.config, {
    baseDir: config.dir,
    log,
    statePath,
    limits: opts.limits?.presses,
    onState: broadcastState,
    onLatched: (key, text) => broadcast({ t: 'latched', key, text }),
    onRunStart: (key, runId) => log(`▶ ${key} #${runId}`),
    onRunEnd: (key, rec, o, run) => log(runEndLine(key, rec, o, run.stopSource)),
  });

  config.subscribe({
    change: (cfg, rev, prev) => {
      const added = state.setConfig(cfg);
      broadcast({ t: 'config', config: config.wire('admin'), rev }, 'admin');
      broadcast({ t: 'config', config: config.wire('press'), rev }, 'press');
      for (const key of added) broadcastState(key, state.get(key)!);
      log(`config reloaded (rev ${rev})`);
      for (const w of configWarnings(cfg, config.dir)) log(`⚠ ${w}`);
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

  const refusingClients = new ThrottledLog(log, () => performance.now());
  /**
   * Why a WebSocket of `role` from `address` would be refused now (the host is full); undefined
   * when there's room. Press tokens get handed out freely (QR codes), so they can't take the slots
   * admins need; and one device (address) can't take them all.
   */
  const noRoom = (role: Role, address: string): string | undefined => {
    const fromAddress = perAddress.get(address) ?? 0;
    if (clients.size >= maxClients) return `${clients.size} open (max ${maxClients})`;
    if (role === 'press' && [...clients].filter((c) => c.data.role === 'press').length >= maxClients - adminReserved)
      return `${maxClients - adminReserved} open with the press token (the last ${adminReserved} are kept for admins)`;
    if (fromAddress >= clientsPerAddress) return `${fromAddress} open from ${address} (max ${clientsPerAddress} per address)`;
    return undefined;
  };

  // The web app, compressed (web-assets.ts); built on first use, and again after a failure.
  let assets: Promise<WebAssets> | undefined;
  const loadAssets = () =>
    (assets ??= WebAssets.load(webApp).catch((e: Error) => {
      assets = undefined;
      log(`the web app could not be built: ${e.message}`);
      throw e;
    }));
  /** The bundle's file at `path`, or undefined when there is none. */
  const serveAsset = async (req: Request, path: string): Promise<Response | undefined> => {
    let w: WebAssets;
    try {
      w = await loadAssets();
    } catch {
      return json({ error: 'the web app could not be built (see the host log)' }, 500);
    }
    const a = w.get(path);
    if (!a) return undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
    return w.respond(req, a);
  };
  const listenAt = { hostname: opts.host ?? config.config.server.host, port: opts.port ?? config.config.server.port };
  // Bun.serve's errors don't say which address (`ENOENT … listen` for a host name that doesn't resolve).
  const serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    try {
      return Bun.serve(options);
    } catch (e) {
      const from = { host: opts.host !== undefined ? '--host' : 'server.host in the config', port: opts.port !== undefined ? '--port' : 'server.port in the config' };
      throw listenError(listenAt.hostname, listenAt.port, e, from);
    }
  }) as typeof Bun.serve;
  const server: Server<WsData> = serve({
    ...listenAt,
    development: opts.development ?? false,
    // Bun turns SO_REUSEPORT on when `development: false`; a second host on the same port must fail instead.
    reusePort: false,
    maxRequestBodySize: MAX_BODY,
    ...(opts.tls ? { tls: { cert: Bun.file(opts.tls.cert), key: Bun.file(opts.tls.key) } } : {}),
    routes: {
      // Dev mode: Bun's own serving (HMR, on-the-fly rebuilds). Otherwise compressed, from the cache.
      '/': opts.development ? webApp : async (req) => (await serveAsset(req, '/')) ?? json({ error: 'not found' }, 404),
      // Browsers: `?ticket=` (POST /api/ws-ticket), so no token is in a URL a proxy logs; scripts: `?token=`.
      '/ws': (req, srv) => {
        const q = new URL(req.url).searchParams;
        const ticket = q.get('ticket');
        // Used up by the first request that shows it, whatever becomes of that request: a ticket a
        // proxy logged (or a refused page sent) is worthless.
        const ticketRole = ticket === null ? undefined : tickets.redeem(ticket);
        if (!originAllowed(req, allowed)) return refuseOrigin(req, 'a WebSocket', WS_REFUSED);
        const role = ticket === null ? auth(q.get('token')) : ticketRole;
        if (!role) return unauthorized();
        const address = addressOf(srv, req);
        const full = noRoom(role, address);
        if (full) {
          refusingClients.note(`refusing WebSocket connections: ${full}`);
          return json(HOST_FULL.connections, 503);
        }
        // open() runs inside upgrade(), so `clients` is up to date for the next request.
        if (srv.upgrade(req, { data: { role, address, source: state.newSource(`ws ${address}`, address) } })) return;
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
            // WriteError says what happened to the file (left as it was, normally).
            const error = e instanceof WriteError ? e.message : `could not write ${config.path}: ${errnoText(e)}`;
            log(error);
            return json({ error, errors: [error] }, 500);
          }
          // Saved; what would fail when pressed (a command that isn't there, say) doesn't block a save.
          if (r.ok) return json({ rev: r.rev, warnings: configWarnings(config.config, config.dir) });
          if (r.status === 400) return json({ errors: r.errors }, 400);
          return json(r.invalid ? ({ rev: r.rev, invalid: true, errors: r.errors } satisfies ConfigConflict) : ({ rev: r.rev } satisfies ConfigConflict), 409);
        }),
      },
      '/api/state': { GET: withRole('any', () => json({ states: state.states(), serverNow: Date.now() })) },
      '/api/press/:pad/:button': {
        POST: withRole('any', async (req) => {
          const o = await pressOptions(req);
          if (typeof o === 'string') return json({ error: o }, 400);
          const r = state.press(req.params.pad, req.params.button, { ...o, source: state.addressSource(addressOf(server, req)) });
          const { status, body } = pressResponse(r);
          return json(body, status, r.refused ? { 'retry-after': '1' } : {});
        }),
      },
      '/api/runs': {
        GET: withRole('admin', (req) => {
          const q = new URL(req.url).searchParams;
          return json(state.runs({ pad: q.get('pad') || undefined, button: q.get('button') || undefined }));
        }),
      },
      // No token: the code is the credential. See pairing.ts (and DESIGN.md, Pairing) for the limits.
      '/api/pair': {
        POST: async (req) => {
          if (!originAllowed(req, allowed)) return refuseOrigin(req, 'a pairing request', REQUEST_REFUSED);
          // No token here: anyone can send this, so it is kept small.
          const body = await readJson(req, { max: 4096 });
          if (!body.ok) return json({ error: body.error }, body.status);
          const b = body.value;
          if (!isRecord(b) || (typeof b.code !== 'string' && typeof b.code !== 'number')) return json({ error: 'body must be {"code": "123456"}' }, 400);
          const r = pairing.redeem(String(b.code), addressOf(server, req));
          if (r.ok) return json({ token: r.role === 'admin' ? sec.secrets.adminToken : sec.secrets.pressToken, role: r.role } satisfies PairResponse);
          // The words say what Retry-After says (QA: "wait a minute" next to Retry-After: 7).
          if (r.why === 'limited')
            return json({ error: `too many attempts: try again in ${r.retryAfterSec} s` }, 429, { 'retry-after': String(r.retryAfterSec) });
          return json({ error: 'wrong or expired code' }, 401);
        },
      },
      // How a browser gets onto /ws without its token in the URL (DESIGN.md, Auth). Origin first,
      // as /ws checks it: a page the socket would turn away gets no ticket either.
      '/api/ws-ticket': {
        POST: (req) => {
          if (!originAllowed(req, allowed)) return refuseOrigin(req, 'a WebSocket ticket request', WS_REFUSED);
          const role = auth(bearerToken(req));
          if (!role) return unauthorized();
          return json(tickets.mint(role) satisfies WsTicket);
        },
      },
      // The client's probe: what /ws would answer this page now, with the token in a header.
      '/api/ws-check': {
        POST: (req) => {
          if (!originAllowed(req, allowed)) return refuseOrigin(req, 'a WebSocket check', WS_REFUSED);
          const role = auth(bearerToken(req));
          if (!role) return unauthorized();
          if (noRoom(role, addressOf(server, req))) return json(HOST_FULL.connections, 503);
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        },
      },
      '/api/pair-code': {
        POST: withRole('admin', async (req) => {
          const body = await readJson(req, { optional: true });
          if (!body.ok) return json({ error: body.error }, body.status);
          const b = body.value ?? {};
          if (!isRecord(b) || (b.role !== undefined && b.role !== 'press' && b.role !== 'admin'))
            return json({ error: 'body must be {} or {"role": "admin" | "press"}' }, 400);
          const code: PairCode = pairing.mint(b.role === 'press' ? 'press' : 'admin');
          log(`a pairing code for ${code.role} was made (by ${addressOf(server, req)}), valid until ${new Date(code.expiresAt).toTimeString().slice(0, 8)}`);
          return json(code);
        }),
      },
    },
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const allow = KNOWN_PATHS.find(([re]) => re.test(path))?.[1];
      if (allow) return json({ error: 'method not allowed' }, 405, { allow });
      const asset = !opts.development && ASSET_PATH.test(path) ? await serveAsset(req, path) : undefined;
      return asset ?? json({ error: 'not found' }, 404);
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
        perAddress.set(ws.data.address, (perAddress.get(ws.data.address) ?? 0) + 1);
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
          latched: state.latched(),
        });
        if (role === 'admin' && config.fileErrors) send(ws, { t: 'configError', errors: config.fileErrors });
      },
      message(ws, raw) {
        const msg = parseClientMsg(raw);
        if (typeof msg === 'string') return void send(ws, { t: 'error', message: msg });
        state.press(msg.pad, msg.button, {
          at: msg.at,
          confirm: msg.confirm,
          source: ws.data.source,
          onResult: (r) => send(ws, { t: 'ack', id: msg.id, key: r.key, result: r.result, ...(r.runId !== undefined ? { runId: r.runId } : {}) }),
        });
      },
      close(ws) {
        if (!clients.delete(ws)) return;
        const n = (perAddress.get(ws.data.address) ?? 1) - 1;
        if (n > 0) perAddress.set(ws.data.address, n);
        else perAddress.delete(ws.data.address);
      },
    },
  });

  // Listening, so no other host has this port: take over what a previous host left running.
  state.recover();
  if (opts.preloadWebApp && !opts.development) void loadAssets().catch(() => {});
  config.watch(opts.debounceMs);

  let stopping: Promise<void> | undefined;
  return {
    server,
    port: server.port ?? 0,
    hostname: server.hostname ?? '',
    scheme: opts.tls ? 'https' : 'http',
    configPath: config.path,
    secretsPath,
    statePath,
    secrets: sec.secrets,
    config,
    state,
    created: { config: createdConfig, secrets: sec.created, rotatedTokens: sec.rotated, fixedSecretsMode: sec.fixedMode },
    info,
    pairing,
    tickets,
    allowOrigins,
    stop: () =>
      (stopping ??= (async () => {
        config.close();
        refusingClients.close();
        originRefusals.close();
        pairing.close();
        for (const ws of clients) ws.close(1001, 'host shutting down');
        await Promise.all([state.shutdown(), server.stop(true)]);
      })()),
  };
}
