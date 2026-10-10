/** The real host: WebSocket `/ws?token=` for state, HTTP with a Bearer token for the rest. */
import type { Config } from '../../core/config.ts';
import type { PressResult, RunRecord, ServerMsg, WireConfig } from '../../core/protocol.ts';
import { KEYS, lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import { emptySnapshot, type Backend, type SaveResult, type Snapshot } from './types.ts';

const BACKOFF_MIN = 250;
const BACKOFF_MAX = 5000;
/** Socket open but no hello by then → treat as dead and retry. */
const HELLO_TIMEOUT = 5000;
/** Coming back from the background after this long → reconnect for a fresh hello. */
const STALE_AFTER_HIDDEN = 5000;
/** A deliberate reconnect (kick) that is back within this long doesn't flash OFFLINE. */
const QUIET_RECONNECT = 1500;
/** Presses made during a quiet reconnect wait this long for the new socket, then fail. */
const DEFER_PRESS = 1800;
/** While visible and online, check the host still answers (Wi-Fi can die without a TCP close). */
const LIVENESS_EVERY = 15_000;
const LIVENESS_TIMEOUT = 4000;

interface Pending {
  resolve: (r: PressResult) => void;
  reject: (e: Error) => void;
}

type Cached = { config: WireConfig; rev: string };

/** The cache is for showing the layout while offline; never keep actions (admin) on disk. */
const redact = (c: WireConfig): WireConfig => ({ ...c, pads: c.pads.map((p) => ({ ...p, buttons: p.buttons.map(({ action: _, ...b }) => b) })) });

export class WsBackend implements Backend {
  readonly kind = 'ws';
  readonly snapshot = createStore<Snapshot>(emptySnapshot());
  private ws: WebSocket | null = null;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private disposed = false;
  private hiddenAt = 0;
  private lastKick = 0;
  private quietUntil = 0;
  private deferred: (() => void)[] = [];
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly token: string,
    private readonly origin = location.origin,
  ) {
    const cached = lsJSON<Cached>(KEYS.configCache);
    if (cached?.config?.pads) this.patch({ config: cached.config, rev: cached.rev });
    const on = <K extends keyof WindowEventMap>(t: K, fn: () => void) => {
      window.addEventListener(t, fn);
      this.offs.push(() => window.removeEventListener(t, fn));
    };
    const vis = () => {
      if (document.visibilityState === 'hidden') this.hiddenAt = Date.now();
      else if (!this.isOpen()) this.connectNow();
      else if (this.hiddenAt && Date.now() - this.hiddenAt > STALE_AFTER_HIDDEN) this.kick();
    };
    document.addEventListener('visibilitychange', vis);
    this.offs.push(() => document.removeEventListener('visibilitychange', vis));
    on('online', () => this.connectNow());
    this.livenessTimer = setInterval(() => void this.checkLiveness(), LIVENESS_EVERY);
    this.connect();
  }

  private async checkLiveness() {
    if (document.visibilityState !== 'visible' || !this.isOpen()) return;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), LIVENESS_TIMEOUT);
    try {
      const r = await fetch(`${this.origin}/api/health`, { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      if (this.isOpen()) this.ws?.close();
    } finally {
      clearTimeout(t);
    }
  }

  private patch(p: Partial<Snapshot>) {
    this.snapshot.set((s) => ({ ...s, ...p }));
  }

  private isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.disposed || this.snapshot.get().status === 'unauthorized') return;
    clearTimeout(this.retryTimer);
    // Never two sockets: one already on its way (or up) wins.
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const proto = this.origin.startsWith('https:') ? 'wss:' : 'ws:';
    const url = `${proto}//${this.origin.replace(/^https?:\/\//, '')}/ws?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.scheduleRetry(false);
    }
    this.ws = ws;
    let greeted = false;
    this.helloTimer = setTimeout(() => ws.close(), HELLO_TIMEOUT);
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        greeted = true;
        clearTimeout(this.helloTimer);
      }
      this.onMessage(msg);
      if (msg.t === 'hello') for (const send of this.deferred.splice(0)) send();
    };
    ws.onclose = () => {
      clearTimeout(this.helloTimer);
      if (this.ws === ws) this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('connection lost'));
      this.pending.clear();
      if (this.disposed) return;
      this.scheduleRetry(greeted);
    };
  }

  private connectNow() {
    if (this.disposed || this.ws?.readyState === WebSocket.CONNECTING || this.isOpen()) return;
    this.failures = 0;
    this.connect();
  }

  private scheduleRetry(wasGreeted: boolean) {
    if (this.snapshot.get().status === 'unauthorized') return;
    if (wasGreeted) this.failures = 0;
    else void this.probeAuth();
    const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.failures);
    const delay = wasGreeted ? 0 : Math.round(base * (0.8 + Math.random() * 0.4));
    this.failures++;
    const s = this.snapshot.get();
    if (s.status === 'online' && Date.now() < this.quietUntil) {
      // Deliberate reconnect: stay "online" unless the new socket fails to greet in time.
      setTimeout(() => !this.isOpen() && this.snapshot.get().status === 'online' && this.patch({ status: 'offline' }), this.quietUntil - Date.now());
    } else {
      // Grace for the very first attempt; after that, say it: offline.
      this.patch({ status: s.status === 'connecting' && this.failures < 2 ? 'connecting' : 'offline', retryAt: Date.now() + delay });
    }
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Browsers hide the HTTP status of a refused upgrade, so ask over HTTP whether it was a 401. */
  private async probeAuth() {
    try {
      const r = await fetch(`${this.origin}/api/state`, { headers: { authorization: `Bearer ${this.token}` }, cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        clearTimeout(this.retryTimer);
        this.ws?.close();
        this.patch({ status: 'unauthorized', retryAt: null });
      }
    } catch {
      /* host unreachable: the retry loop carries on */
    }
  }

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'hello':
        this.failures = 0;
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
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve(m.result);
        break;
      }
      case 'configError':
        this.patch({ configErrors: m.errors });
        break;
      case 'error':
        console.warn('[buttpad] host error:', m.message);
        break;
    }
  }

  private cache(config: WireConfig, rev: string) {
    lsSet(KEYS.configCache, JSON.stringify({ config: redact(config), rev } satisfies Cached));
  }

  press(pad: string, button: string): Promise<PressResult> {
    if (this.snapshot.get().status !== 'online') return Promise.reject(new Error('offline'));
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    return new Promise((resolve, reject) => {
      const send = () => {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('offline'));
        this.pending.set(id, { resolve, reject });
        try {
          ws.send(JSON.stringify({ t: 'press', id, pad, button }));
        } catch (e) {
          this.pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      if (this.isOpen()) return send();
      // Mid quiet reconnect: send on the next hello, unless that takes too long.
      this.deferred.push(send);
      setTimeout(() => {
        const i = this.deferred.indexOf(send);
        if (i >= 0) (this.deferred.splice(i, 1), reject(new Error('offline')));
      }, DEFER_PRESS);
    });
  }

  kick(): void {
    if (Date.now() - this.lastKick < 2000) return;
    this.lastKick = Date.now();
    this.quietUntil = Date.now() + QUIET_RECONNECT;
    this.failures = 0;
    if (this.ws) this.ws.close();
    else this.connectNow();
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
    clearTimeout(this.helloTimer);
    clearInterval(this.livenessTimer);
    for (const off of this.offs) off();
    this.ws?.close();
    this.ws = null;
  }
}
