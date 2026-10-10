/**
 * The real host: WebSocket `/ws?token=` for state, HTTP with a Bearer token for the rest.
 *
 * Liveness: a link can die without a TCP close (Wi-Fi gone, host asleep or hung) and the host
 * sends no heartbeats, so this side asks. A socket that has been quiet for IDLE_PROBE while the
 * page is visible gets a `{"t":"ping"}`; the host answers a message type it doesn't know with an
 * `error` frame, and any frame at all counts as the answer. Nothing back within PROBE_TIMEOUT →
 * the socket is dead: it is dropped on the spot (handlers detached, its unacked presses failed,
 * OFFLINE shown) and a new one is opened, without waiting for the browser's close handshake
 * (Chromium waits up to a minute for one on a dead link). The probe is quicker when there is
 * reason to doubt the link: back from the background, a network change, a press with no ack.
 *
 * Every socket has its own pending presses and timers (Conn), and every handler first checks that
 * its socket is still the current one: a stale socket's late events can't touch a newer one.
 */
import type { Config } from '../../core/config.ts';
import type { PressResult, RunRecord, ServerMsg, StateMap, WireConfig } from '../../core/protocol.ts';
import { mono, nextTask } from '../lib/env.ts';
import { KEYS, lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import { emptySnapshot, PressError, type Backend, type SaveResult, type Snapshot } from './types.ts';

const BACKOFF_MIN = 250;
const BACKOFF_MAX = 5000;
/**
 * Losing a connection that was up this long starts the backoff over. One that drops right after
 * its hello doesn't: a host (or proxy) that closes every socket must not be hammered.
 */
const STABLE_AFTER = 10_000;
/** No hello by then → dead. */
const HELLO_TIMEOUT = 5000;
/** Visible and not a single frame for this long → probe. */
const IDLE_PROBE = 5000;
/** How long a probe waits for a frame. */
const PROBE_TIMEOUT = 3000;
/** …when the link is in doubt already. */
const QUICK_PROBE_TIMEOUT = 1500;
/** A press with no ack and no other frame for this long puts the link in doubt. */
const PRESS_DOUBT_AFTER = 600;
/** Back from at least this long in the background → probe. */
const HIDDEN_DOUBT_AFTER = 1000;
/** The probe. Not part of the protocol: the host answers it with `error`, which is the point. */
const PING = JSON.stringify({ t: 'ping' });

interface Pending {
  resolve: (r: PressResult) => void;
  reject: (e: Error) => void;
}

/** One socket and everything that belongs to it. */
interface Conn {
  ws: WebSocket;
  greeted: boolean;
  /** mono() of the hello. */
  greetedAt: number;
  /** mono() of the last frame from the host. */
  lastFrame: number;
  pending: Map<string, Pending>;
  /** Pings whose `error` answer hasn't come yet (those errors are expected, not worth a warning). */
  pings: number;
  helloTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
  /** mono() by which the probe in flight must be answered. */
  probeDeadline: number;
  probeSentAt: number;
}

type Cached = { config: WireConfig; rev: string };

/** The cache is for showing the layout while offline; never keep actions (admin) on disk. */
const redact = (c: WireConfig): WireConfig => ({ ...c, pads: c.pads.map((p) => ({ ...p, buttons: p.buttons.map(({ action: _, ...b }) => b) })) });

export class WsBackend implements Backend {
  readonly kind = 'ws';
  readonly snapshot = createStore<Snapshot>(emptySnapshot());
  private conn: Conn | null = null;
  private failures = 0;
  private everGreeted = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private disposed = false;
  private hiddenAt = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly token: string,
    private readonly origin = location.origin,
  ) {
    const cached = lsJSON<Cached>(KEYS.configCache);
    if (cached?.config?.pads) this.patch({ config: cached.config, rev: cached.rev });
    const on = (target: EventTarget, type: string, fn: () => void) => {
      target.addEventListener(type, fn);
      this.offs.push(() => target.removeEventListener(type, fn));
    };
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') return void (this.hiddenAt = mono());
      const away = this.hiddenAt ? mono() - this.hiddenAt : 0;
      this.hiddenAt = 0;
      const c = this.conn;
      if (!c) this.connectNow();
      // The socket may have died while we were away (phones freeze background pages).
      else if (away >= HIDDEN_DOUBT_AFTER) this.probe(c, QUICK_PROBE_TIMEOUT);
      else this.armIdle(c);
    });
    // The network changed: whatever the socket says, check it (or connect now, not at the next retry).
    on(window, 'online', () => (this.conn?.greeted ? this.probe(this.conn, QUICK_PROBE_TIMEOUT) : this.connectNow()));
    on(window, 'offline', () => this.conn?.greeted && this.probe(this.conn, QUICK_PROBE_TIMEOUT));
    // Alongside the first socket: a rejected token shows at once, and if the socket hangs, the
    // pad still shows what the host is doing (a running action, not a dimmed READY).
    void this.probeHttp();
    this.connect();
  }

  /** The current socket (debugging and tests). */
  get ws(): WebSocket | null {
    return this.conn?.ws ?? null;
  }

  private patch(p: Partial<Snapshot>) {
    this.snapshot.set((s) => ({ ...s, ...p }));
  }

  private connect() {
    if (this.disposed || this.snapshot.get().status === 'unauthorized') return;
    clearTimeout(this.retryTimer);
    // Never two sockets: one already on its way (or up) wins.
    if (this.conn) return;
    const proto = this.origin.startsWith('https:') ? 'wss:' : 'ws:';
    const url = `${proto}//${this.origin.replace(/^https?:\/\//, '')}/ws?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.scheduleRetry(null);
    }
    const c: Conn = { ws, greeted: false, greetedAt: 0, lastFrame: mono(), pending: new Map(), pings: 0, probeDeadline: 0, probeSentAt: 0 };
    this.conn = c;
    c.helloTimer = setTimeout(() => this.lost(c), HELLO_TIMEOUT);
    ws.onmessage = (ev) => {
      if (this.conn === c) this.onFrame(c, ev.data);
    };
    ws.onclose = () => this.lost(c);
  }

  private onFrame(c: Conn, data: unknown) {
    // Any frame at all proves the link: a probe in flight is answered.
    c.lastFrame = mono();
    clearTimeout(c.probeTimer);
    c.probeTimer = undefined;
    this.armIdle(c);
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(data)) as ServerMsg;
    } catch {
      return;
    }
    if (msg.t === 'hello') {
      c.greeted = true;
      c.greetedAt = mono();
      this.everGreeted = true;
      clearTimeout(c.helloTimer);
    }
    this.onMessage(c, msg);
  }

  /** Visible and quiet for IDLE_PROBE → probe. Hidden pages don't (coming back does). */
  private armIdle(c: Conn) {
    clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => {
      if (this.conn === c && document.visibilityState === 'visible') this.probe(c, PROBE_TIMEOUT);
    }, IDLE_PROBE);
  }

  /** Ask the host for a frame; none within `timeout` → the socket is dead. */
  private probe(c: Conn, timeout: number) {
    if (this.conn !== c || !c.greeted) return;
    if (c.ws.readyState !== WebSocket.OPEN) return this.lost(c);
    const deadline = mono() + timeout;
    const inFlight = c.probeTimer !== undefined;
    if (inFlight && c.probeDeadline <= deadline) return;
    if (!inFlight) {
      try {
        c.ws.send(PING);
      } catch {
        return this.lost(c);
      }
      c.pings++;
      c.probeSentAt = mono();
    }
    clearTimeout(c.probeTimer);
    c.probeDeadline = deadline;
    c.probeTimer = setTimeout(
      // A stalled main thread fires this late, with the answer still queued: let it land first.
      () => nextTask(() => this.conn === c && c.lastFrame < c.probeSentAt && this.lost(c)),
      timeout,
    );
  }

  /** Done with a socket: detach it (its late events go nowhere), fail its unacked presses. */
  private drop(c: Conn) {
    if (this.conn === c) this.conn = null;
    const { ws } = c;
    ws.onmessage = null;
    ws.onclose = null;
    clearTimeout(c.helloTimer);
    clearTimeout(c.idleTimer);
    clearTimeout(c.probeTimer);
    try {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    } catch {
      /* already going */
    }
    const err = new PressError(true, 'the link to the host dropped before it answered');
    for (const p of c.pending.values()) p.reject(err);
    c.pending.clear();
  }

  /** The current socket died (closed, never greeted, or stopped answering): go offline, retry. */
  private lost(c: Conn) {
    if (this.conn !== c || this.disposed) return;
    this.drop(c);
    this.scheduleRetry(c);
  }

  /** Something says the network is back: give up on a socket still connecting, go again now. */
  private connectNow() {
    if (this.disposed || this.conn?.greeted) return;
    if (this.conn) this.drop(this.conn);
    this.failures = 0;
    this.connect();
  }

  private scheduleRetry(c: Conn | null) {
    if (this.disposed || this.snapshot.get().status === 'unauthorized') return;
    if (c?.greeted && mono() - c.greetedAt >= STABLE_AFTER) this.failures = 0;
    // Browsers hide the HTTP status of a refused upgrade: ask over HTTP whether it was a 401.
    if (!c?.greeted) void this.probeHttp();
    const attempt = this.failures++;
    const delay = attempt === 0 ? 0 : Math.round(Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));
    // Grace for the very first attempt at startup; after that, say it: offline.
    const status = !this.everGreeted && this.snapshot.get().status === 'connecting' && attempt === 0 ? 'connecting' : 'offline';
    this.patch({ status, retryAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * The HTTP side: a rejected token (401/403) means stop and say so. Otherwise, while the socket
   * isn't up, the host's states (and the layout, if none is cached) come from here.
   */
  private async probeHttp() {
    const live = () => this.disposed || this.snapshot.get().status === 'online';
    try {
      const r = await this.http('GET', '/api/state');
      if (r.status === 401 || r.status === 403) {
        clearTimeout(this.retryTimer);
        if (this.conn) this.drop(this.conn);
        this.patch({ status: 'unauthorized', retryAt: null });
        return;
      }
      if (!r.ok || live()) return;
      const j = (await r.json()) as { states?: StateMap; serverNow?: number };
      // The socket got there first: its picture is the fresher one.
      if (live() || !j.states) return;
      this.patch({ states: j.states, ...(typeof j.serverNow === 'number' ? { clockSkew: Date.now() - j.serverNow } : {}) });
      if (this.snapshot.get().config) return;
      const rc = await this.http('GET', '/api/config');
      const jc = rc.ok ? ((await rc.json()) as { config?: WireConfig; rev?: string }) : null;
      if (jc?.config?.pads && !live() && !this.snapshot.get().config) this.patch({ config: jc.config, rev: jc.rev ?? null });
    } catch {
      /* host unreachable: the retry loop carries on */
    }
  }

  private onMessage(c: Conn, m: ServerMsg) {
    switch (m.t) {
      case 'hello':
        // No backoff reset here: only a connection that holds (STABLE_AFTER) earns one.
        this.patch({
          status: 'online',
          role: m.role,
          config: m.config,
          rev: m.rev,
          states: m.states,
          clockSkew: Date.now() - m.serverNow,
          host: m.host,
          retryAt: null,
        });
        this.cache(m.config, m.rev);
        break;
      case 'state':
        this.snapshot.set((s) => ({ ...s, states: { ...s.states, [m.key]: m.state } }));
        break;
      case 'config':
        this.patch({ config: m.config, rev: m.rev, configErrors: null });
        this.cache(m.config, m.rev);
        break;
      case 'ack': {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        p?.resolve(m.result);
        break;
      }
      case 'configError':
        this.patch({ configErrors: m.errors });
        break;
      case 'error':
        if (c.pings > 0) c.pings--; // a probe's answer
        else console.warn('[buttpad] host error:', m.message);
        break;
    }
  }

  private cache(config: WireConfig, rev: string) {
    lsSet(KEYS.configCache, JSON.stringify({ config: redact(config), rev } satisfies Cached));
  }

  press(pad: string, button: string, onSent?: () => void): Promise<PressResult> {
    const c = this.conn;
    // Closed under us, its close event not in yet: that's offline now.
    if (c?.greeted && c.ws.readyState !== WebSocket.OPEN) this.lost(c);
    if (this.snapshot.get().status !== 'online' || this.conn !== c || !c?.greeted) return Promise.reject(new PressError(false, 'not connected to the host'));
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    return new Promise((resolve, reject) => {
      try {
        c.ws.send(JSON.stringify({ t: 'press', id, pad, button }));
      } catch (e) {
        return reject(new PressError(false, e instanceof Error ? e.message : String(e)));
      }
      c.pending.set(id, { resolve, reject });
      const sentAt = mono();
      onSent?.();
      // No ack, and not one frame since: check the link now rather than at the next idle probe.
      setTimeout(() => this.conn === c && c.pending.has(id) && c.lastFrame < sentAt && this.probe(c, QUICK_PROBE_TIMEOUT), PRESS_DOUBT_AFTER);
    });
  }

  kick(): void {
    // Never drops a socket that still answers (one that just said hello, say): it only checks.
    const c = this.conn;
    if (c?.greeted) this.probe(c, QUICK_PROBE_TIMEOUT);
    else if (!c) this.connectNow();
  }

  private async http(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  }

  async saveConfig(config: Config, baseRev: string): Promise<SaveResult> {
    try {
      const r = await this.http('PUT', '/api/config', { config, baseRev });
      const j = (await r.json().catch(() => ({}))) as { rev?: string; errors?: string[]; error?: string };
      if (r.ok && j.rev) return { ok: true, rev: j.rev };
      if (r.status === 400) return { ok: false, kind: 'invalid', errors: j.errors ?? ['invalid config'] };
      if (r.status === 409) return { ok: false, kind: 'conflict', rev: j.rev ?? '' };
      return { ok: false, kind: 'error', message: j.error ?? `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  async runs(q: { pad?: string; button?: string } = {}): Promise<RunRecord[]> {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();
    const r = await this.http('GET', `/api/runs${qs ? `?${qs}` : ''}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as RunRecord[];
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    for (const off of this.offs) off();
    if (this.conn) this.drop(this.conn);
  }
}
