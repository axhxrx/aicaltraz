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
 *
 * Every press carries `at`: when it was made (the gesture's own time), in the host's clock. The
 * offset is learned from each hello's serverNow, which the host stamps when it takes the socket (so
 * it is taken as of the socket's opening, not as of the hello's arrival: a big config over a slow
 * link takes seconds more), corrected for the link's one-way delay as the handshake measured it,
 * and kept with a clock the device's clock setting can't move (lib/clock.ts). A press that sat in
 * a dead link (or a stalled page) for seconds is dropped by the host (`expired`) instead of running
 * late. One that comes back `expired` too soon after being made to have been held up (a second, or
 * a third of the button's maxLatenessMs) means the offset is wrong (the host's clock was set, say),
 * so a new socket (and hello) gets a fresh one.
 *
 * Round trips are measured (pings answered, presses acked): on a link that has been slow, a press
 * waits longer for its ack before the UI says NO RESPONSE (4 × the 90th percentile, 2–6 s), and the
 * liveness checks give the link as long (OFFLINE is not shown for a link that is merely slow).
 *
 * Back from a long stretch in the background (hidden ≥ 5 s), from a frozen tab, or after the page
 * didn't get to run for a while (a heartbeat that comes ≥ 8 s late): `syncing`. What the screen
 * showed may be minutes old, and a socket that stayed up delivers the frames it queued meanwhile
 * first, a backlog of runs that started and ended long ago. A ping goes out at once; the host
 * answers it after everything it sent before, so its answer (or a fresh hello, if the socket
 * turned out dead) ends `syncing`.
 */
import type { Config } from '../../core/config.ts';
import type { ClientMsg, PressResult, RunRecord, SaveConfigBody, ServerMsg, StateMap, WireConfig } from '../../core/protocol.ts';
import { wall } from '../lib/clock.ts';
import { afterQueuedInput, mono } from '../lib/env.ts';
import { KEYS, lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import {
  emptySnapshot,
  latenessOf,
  MAX_CONFIG_BYTES,
  PressError,
  statesIn,
  TOO_LARGE,
  wireButton,
  type Backend,
  type PairCode,
  type PressAck,
  type PressOpts,
  type SaveResult,
  type Snapshot,
} from './types.ts';

const BACKOFF_MIN = 250;
const BACKOFF_MAX = 5000;
/**
 * Losing a connection that was up this long starts the backoff over. One that drops right after
 * its hello doesn't: a host (or proxy) that closes every socket must not be hammered.
 */
const STABLE_AFTER = 10_000;
/**
 * No hello by then → dead. Doubles after each socket that died waiting (up to HELLO_TIMEOUT_MAX):
 * a big config over a slow link takes longer than 5 s to arrive, and must get there eventually.
 */
const HELLO_TIMEOUT = 5000;
const HELLO_TIMEOUT_MAX = 60_000;
/** Offline and someone touched a button: a connection attempt older than this is given up for a new one. */
const KICK_STALE_CONNECT = 1500;
/** A press answered `expired` quicker than this after it was made wasn't held up anywhere: the clock offset is off. */
const FRESH_PRESS_MS = 1000;
/** Visible and not a single frame for this long → probe. */
const IDLE_PROBE = 5000;
/** How long a probe waits for a frame (at least; up to PROBE_MAX on a link whose round trips are slow). */
const PROBE_TIMEOUT = 3000;
const PROBE_MAX = 8000;
/** …when the link is in doubt already. */
const QUICK_PROBE_TIMEOUT = 1500;
const QUICK_PROBE_MAX = 5000;
/** A press with no ack and no other frame for this long puts the link in doubt (longer on a slow link, up to PRESS_DOUBT_MAX). */
const PRESS_DOUBT_AFTER = 600;
const PRESS_DOUBT_MAX = 3000;
/** How long a press waits for its ack before NO RESPONSE: 4 × the p90 round trip, within these. */
const ACK_TIMEOUT = 2000;
const ACK_TIMEOUT_MAX = 6000;
/** Round trips kept, and how many it takes to trust their p90. A "round trip" longer than RTT_SAMPLE_MAX was a page that didn't run. */
const RTT_WINDOW = 20;
const RTT_MIN_SAMPLES = 3;
const RTT_SAMPLE_MAX = 15_000;
/** Back from at least this long in the background → probe. */
const HIDDEN_DOUBT_AFTER = 1000;
/** …this long → syncing (the screen may be minutes old). */
const SYNC_AFTER_HIDDEN = 5000;
/** A heartbeat this late: the page didn't get to run (frozen, asleep) → syncing. (A 4 s stalled main thread isn't that.) */
const BEAT_MS = 1000;
const STALE_GAP = 8000;
/** The probe. Not part of the protocol: the host answers it with `error`, which is the point. */
const PING = JSON.stringify({ t: 'ping' });
/** A config save with no answer by then is given up on (it may have landed: the caller checks). */
const SAVE_TIMEOUT = 10_000;
/** GET /api/config when asked for it (merges, checks). */
const GET_TIMEOUT = 5000;

interface Pending {
  resolve: (a: PressAck) => void;
  reject: (e: Error) => void;
}

/** One socket and everything that belongs to it. */
interface Conn {
  ws: WebSocket;
  greeted: boolean;
  /** mono() when it was created, when it opened (the upgrade's answer), and of the hello. */
  openedAt: number;
  upAt: number;
  greetedAt: number;
  /** mono() of the last frame from the host. */
  lastFrame: number;
  pending: Map<string, Pending>;
  /** Pings whose `error` answer hasn't come yet (those errors are expected, not worth a warning). */
  pings: number;
  /** When each of those went out (mono()) and in which stretch of the page's life (WsBackend.epoch): their round trips. */
  pingTimes: { at: number; epoch: number }[];
  /** Pings sent on this socket, and answers to them so far (they come in order). */
  pingsSent: number;
  answers: number;
  /** Syncing: the ping whose answer means the backlog is in (its number; 0: none). */
  syncPing: number;
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
  /** Sockets in a row that died waiting for their hello. */
  private helloMisses = 0;
  private readonly offs: (() => void)[] = [];
  /** Recent round trips (ms): pings answered, presses acked. */
  private rtts: number[] = [];
  /**
   * Bumped whenever the page may not have run for a while (hidden, frozen, asleep): a "round trip"
   * that spans one measures the page, not the link.
   */
  private epoch = 0;
  /** mono() of the last heartbeat (or frame): a page that doesn't get to run misses them. */
  private beat = mono();
  private beatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly token: string,
    private readonly origin = location.origin,
  ) {
    const cached = lsJSON<Cached>(KEYS.configCache);
    if (cached?.config?.pads) this.patch({ config: cached.config, rev: cached.rev });
    const on = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      target.addEventListener(type, fn);
      this.offs.push(() => target.removeEventListener(type, fn));
    };
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.epoch++;
        return void (this.hiddenAt = mono());
      }
      const away = this.hiddenAt ? mono() - this.hiddenAt : 0;
      this.hiddenAt = 0;
      const c = this.conn;
      // Long enough for the picture on screen to be stale: nothing shown as live until the host's word is in.
      if (away >= SYNC_AFTER_HIDDEN) this.startSync();
      else if (!c) this.connectNow();
      // The socket may have died while we were away (phones freeze background pages).
      else if (away >= HIDDEN_DOUBT_AFTER) this.probe(c, this.probeTimeout(true));
      else this.armIdle(c);
    });
    // Page Lifecycle (Chrome): a frozen page that resumes, a page restored from the back/forward cache.
    on(document, 'freeze', () => void this.epoch++);
    on(document, 'resume', () => this.startSync());
    on(window, 'pageshow', (e) => (e as PageTransitionEvent).persisted && this.startSync());
    // The network changed: whatever the socket says, check it (or connect now, not at the next retry).
    on(window, 'online', () => (this.conn?.greeted ? this.probe(this.conn, this.probeTimeout(true)) : this.connectNow()));
    on(window, 'offline', () => this.conn?.greeted && this.probe(this.conn, this.probeTimeout(true)));
    // A page that didn't get to run for a while (frozen without the events above, a device asleep).
    this.beatTimer = setInterval(() => this.awake(), BEAT_MS);
    // Alongside the first socket: a rejected token shows at once, and if the socket hangs, the
    // pad still shows what the host is doing (a running action, not a dimmed READY).
    void this.probeHttp();
    this.connect();
  }

  isStale(): boolean {
    return this.everGreeted && mono() - this.beat > STALE_GAP;
  }

  /**
   * The page is running now (a heartbeat, a frame): if it hadn't for STALE_GAP, what is on screen
   * and what the socket has queued up are old news (syncing).
   */
  private awake() {
    const now = mono();
    const gap = now - this.beat;
    this.beat = now;
    if (gap > STALE_GAP) this.startSync();
  }

  // ---- round trips --------------------------------------------------------------------------

  private noteRtt(ms: number, epoch: number) {
    if (epoch !== this.epoch || !(ms >= 0) || ms > RTT_SAMPLE_MAX) return;
    this.rtts.push(ms);
    if (this.rtts.length > RTT_WINDOW) this.rtts.shift();
  }

  /** The 90th percentile of the recent round trips; null: too few to say. */
  private rttP90(): number | null {
    if (this.rtts.length < RTT_MIN_SAMPLES) return null;
    const s = [...this.rtts].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]!;
  }

  /** `k` × the p90 round trip, within [min, max] (min while there is nothing to go by). */
  private scaled(k: number, min: number, max: number): number {
    const p = this.rttP90();
    return p === null ? min : Math.round(Math.min(max, Math.max(min, k * p)));
  }

  /** NO RESPONSE after this long without an ack: 2 s, more on a link that has been slow (≤ 6 s). */
  ackTimeoutMs(): number {
    return this.scaled(4, ACK_TIMEOUT, ACK_TIMEOUT_MAX);
  }

  private probeTimeout(quick: boolean): number {
    return quick ? this.scaled(3, QUICK_PROBE_TIMEOUT, QUICK_PROBE_MAX) : this.scaled(4, PROBE_TIMEOUT, PROBE_MAX);
  }

  /** Recent round trips (debugging and tests). */
  get roundTrips(): readonly number[] {
    return this.rtts;
  }

  // ---- syncing ------------------------------------------------------------------------------

  /** Back from a long stretch away: nothing is live until the host's current word is in. */
  private startSync() {
    if (this.disposed || this.snapshot.get().status === 'unauthorized') return;
    this.epoch++;
    const c = this.conn;
    // Nothing was ever shown from the host: there is no stale picture to hold back.
    if (this.everGreeted && !this.snapshot.get().syncing) this.patch({ syncing: true });
    // No socket, or one still opening: its hello settles it.
    if (!c) return this.connectNow();
    if (!c.greeted) return;
    this.probe(c, this.probeTimeout(true), true);
  }

  private endSync() {
    if (this.snapshot.get().syncing) this.patch({ syncing: false });
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
    const c: Conn = {
      ws,
      greeted: false,
      openedAt: mono(),
      upAt: 0,
      greetedAt: 0,
      lastFrame: mono(),
      pending: new Map(),
      pings: 0,
      pingTimes: [],
      pingsSent: 0,
      answers: 0,
      syncPing: 0,
      probeDeadline: 0,
      probeSentAt: 0,
    };
    this.conn = c;
    c.helloTimer = setTimeout(
      () => {
        this.helloMisses++;
        this.lost(c);
      },
      Math.min(HELLO_TIMEOUT_MAX, HELLO_TIMEOUT * 2 ** this.helloMisses),
    );
    ws.onmessage = (ev) => {
      if (this.conn === c) this.onFrame(c, ev.data);
    };
    ws.onopen = () => void (c.upAt = mono());
    ws.onclose = () => this.lost(c);
  }

  /**
   * How long the upgrade's answer took to get here from when the host stamped serverNow: about half
   * a round trip. Opening the socket took about two (TCP connect, then the upgrade), so a quarter of
   * that (at most 1 s).
   */
  private oneWay(c: Conn): number {
    const opening = (c.upAt || c.greetedAt) - c.openedAt;
    return Math.min(1000, Math.max(0, opening / 4));
  }

  private onFrame(c: Conn, data: unknown) {
    // A page that didn't get to run for a while: this frame may be the start of a backlog.
    this.awake();
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
      this.helloMisses = 0;
      clearTimeout(c.helloTimer);
    }
    this.onMessage(c, msg);
  }

  /** Visible and quiet for IDLE_PROBE → probe. Hidden pages don't (coming back does). */
  private armIdle(c: Conn) {
    clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => {
      if (this.conn === c && document.visibilityState === 'visible') this.probe(c, this.probeTimeout(false));
    }, IDLE_PROBE);
  }

  /** `sample`: its answer's round trip says how the link is (not one sent behind a backlog). */
  private sendPing(c: Conn, sample = true): boolean {
    try {
      c.ws.send(PING);
    } catch {
      this.lost(c);
      return false;
    }
    c.pings++;
    c.pingsSent++;
    c.pingTimes.push({ at: mono(), epoch: sample ? this.epoch : -1 });
    return true;
  }

  /**
   * Ask the host for a frame; none within `timeout` → the socket is dead. `sync`: a ping of its
   * own even with one in flight, whose answer (it comes after everything the host sent before it)
   * ends syncing.
   */
  private probe(c: Conn, timeout: number, sync = false) {
    if (this.conn !== c || !c.greeted) return;
    if (c.ws.readyState !== WebSocket.OPEN) return this.lost(c);
    const deadline = mono() + timeout;
    const inFlight = c.probeTimer !== undefined;
    if (sync) {
      if (!this.sendPing(c, false)) return;
      c.syncPing = c.pingsSent;
      c.probeSentAt = mono();
    } else if (inFlight && c.probeDeadline <= deadline) return;
    else if (!inFlight) {
      if (!this.sendPing(c)) return;
      c.probeSentAt = mono();
    }
    clearTimeout(c.probeTimer);
    c.probeDeadline = deadline;
    c.probeTimer = setTimeout(
      // A stalled main thread fires this late, with the answer still queued: let it land first.
      () => afterQueuedInput(() => this.conn === c && c.lastFrame < c.probeSentAt && this.lost(c)),
      timeout,
    );
  }

  /** Done with a socket: detach it (its late events go nowhere), fail its unacked presses. */
  private drop(c: Conn) {
    if (this.conn === c) this.conn = null;
    const { ws } = c;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onopen = null;
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
    // What the host was last seen doing is as of its last frame (the OFFLINE look freezes there).
    if (c.greeted) this.patch({ lastSeen: wall() - (mono() - c.lastFrame) });
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
    // Browsers hide the HTTP status of a refused upgrade: ask over HTTP whether it was a 401 (or a 503).
    if (!c?.greeted) void this.probeHttp(true);
    const attempt = this.failures++;
    const delay = attempt === 0 ? 0 : Math.round(Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));
    // Grace for the very first attempt at startup; after that, say it: offline.
    const status = !this.everGreeted && this.snapshot.get().status === 'connecting' && attempt === 0 ? 'connecting' : 'offline';
    this.patch({ status, retryAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * The HTTP side: a rejected token (401/403) means stop and say so. Otherwise, while the socket
   * isn't up, the host's states (and the layout, if none is cached) come from here. After a socket
   * that never got its hello (`failed`): was it turned away because the host is full (503)?
   */
  private async probeHttp(failed = false) {
    const live = () => this.disposed || this.snapshot.get().status === 'online';
    try {
      const t0 = mono();
      const r = await this.http('GET', '/api/state');
      // serverNow was taken about half the round trip ago.
      const half = Math.min(1000, (mono() - t0) / 2);
      if (r.status === 401 || r.status === 403) {
        clearTimeout(this.retryTimer);
        if (this.conn) this.drop(this.conn);
        this.patch({ status: 'unauthorized', retryAt: null });
        return;
      }
      if (!r.ok || live()) return;
      // A plain request to /ws gets the answer the upgrade got: 426 "expected a WebSocket upgrade"
      // when there's room, 503 when the host is full. A POST carries this page's Origin (a GET from
      // the same origin doesn't), so a 403 says the host turns this address away: a proxy, tunnel or
      // preview in front of it that the host wasn't told about (--allow-origin).
      if (failed) {
        const status = (await this.http('POST', `/ws?token=${encodeURIComponent(this.token)}`).catch(() => null))?.status;
        const full = status === 503;
        const refused = status === 403;
        if (!live() && (full !== this.snapshot.get().hostFull || refused !== this.snapshot.get().originRefused)) this.patch({ hostFull: full, originRefused: refused });
      }
      const j = (await r.json()) as { states?: StateMap; serverNow?: number };
      // The socket got there first: its picture is the fresher one.
      if (live() || !j.states) return;
      this.patch({ states: j.states, ...(typeof j.serverNow === 'number' ? { clockSkew: wall() - (j.serverNow + half) } : {}) });
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
          // The host stamps serverNow when it takes the socket, and the hello can take seconds more
          // (a big config, a slow link): the offset is as of the socket's opening (its upgrade
          // answer), a moment after the stamp.
          clockSkew: wall() - (mono() - (c.upAt || mono())) - (m.serverNow + this.oneWay(c)),
          host: m.host,
          retryAt: null,
          // A v1 host has no latched state.
          latched: m.latched ?? {},
          hostFull: false,
          originRefused: false,
          lastSeen: null,
          // The host's word as it is now: whatever this device was catching up on, it has.
          syncing: false,
        });
        this.cache(m.config, m.rev);
        break;
      case 'state':
        this.snapshot.set((s) => ({ ...s, states: { ...s.states, [m.key]: m.state } }));
        break;
      case 'latched':
        this.snapshot.set((s) => {
          const latched = { ...s.latched };
          if (m.text === null || m.text === '') delete latched[m.key];
          else latched[m.key] = m.text;
          return { ...s, latched };
        });
        break;
      case 'config':
        // A button the config dropped (or renamed) gets no last word from the host: its state goes
        // with it, or it would look RUNNING forever (and every save would offer to "stop" it).
        this.snapshot.set((s) => ({ ...s, config: m.config, rev: m.rev, configErrors: null, states: statesIn(s.states, m.config) }));
        this.cache(m.config, m.rev);
        break;
      case 'ack': {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        p?.resolve(m.runId === undefined ? { result: m.result } : { result: m.result, runId: m.runId });
        break;
      }
      case 'configError':
        this.patch({ configErrors: m.errors });
        break;
      case 'error': {
        // A probe's answer (in order: the host answers each ping after what it sent before it).
        if (c.pings <= 0) return void console.warn('[buttpad] host error:', m.message);
        c.pings--;
        c.answers++;
        const sent = c.pingTimes.shift();
        if (sent) this.noteRtt(mono() - sent.at, sent.epoch);
        if (c.syncPing && c.answers >= c.syncPing) {
          c.syncPing = 0;
          this.endSync();
        }
        break;
      }
    }
  }

  private cache(config: WireConfig, rev: string) {
    lsSet(KEYS.configCache, JSON.stringify({ config: redact(config), rev } satisfies Cached));
  }

  press(pad: string, button: string, opts: PressOpts = {}): Promise<PressResult> {
    const c = this.conn;
    // Closed under us, its close event not in yet: that's offline now.
    if (c?.greeted && c.ws.readyState !== WebSocket.OPEN) this.lost(c);
    if (this.snapshot.get().status !== 'online' || this.conn !== c || !c?.greeted) return Promise.reject(new PressError(false, 'not connected to the host'));
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    // When it was made (the gesture's time: a stalled page gets here late), in the host's clock:
    // the host drops it if it got there too late (the button's maxLatenessMs).
    const made = Math.min(mono(), opts.at ?? Infinity);
    const at = Math.round(wall() - (mono() - made) - this.snapshot.get().clockSkew);
    const lateness = latenessOf(wireButton(this.snapshot.get().config, pad, button));
    const msg: ClientMsg = { t: 'press', id, pad, button, at, ...(opts.confirm ? { confirm: true } : {}) };
    return new Promise((resolve, reject) => {
      try {
        c.ws.send(JSON.stringify(msg));
      } catch (e) {
        return reject(new PressError(false, e instanceof Error ? e.message : String(e)));
      }
      const sentAt = mono();
      const epoch = this.epoch;
      c.pending.set(id, {
        resolve: (ack) => {
          this.noteRtt(mono() - sentAt, epoch);
          opts.onAck?.(ack);
          resolve(ack.result);
          // Too old by the host's clock, yet answered too soon after it was made to have been held
          // up that long: our idea of the host's clock is off.
          if (ack.result === 'expired' && mono() - made < Math.min(FRESH_PRESS_MS, lateness / 3) && this.conn === c) {
            console.warn('[buttpad] a fresh press was dropped as too old: the clock offset is off; reconnecting for a new one');
            this.lost(c);
          }
        },
        reject,
      });
      opts.onSent?.();
      // No ack, and not one frame since: check the link now rather than at the next idle probe (on
      // a link whose round trips have been slow, a little later, and with more patience).
      const doubt = this.scaled(2, PRESS_DOUBT_AFTER, PRESS_DOUBT_MAX);
      setTimeout(() => this.conn === c && c.pending.has(id) && c.lastFrame < sentAt && this.probe(c, this.probeTimeout(true)), doubt);
    });
  }

  kick(): void {
    // Never drops a socket that still answers (one that just said hello, say): it only checks.
    const c = this.conn;
    if (c?.greeted) this.probe(c, QUICK_PROBE_TIMEOUT);
    // Offline, waiting for the next retry, or stuck opening a socket that should be open by now (one
    // that is open and waiting for a slow hello is left to it): go now.
    else if (!c || (c.ws.readyState === WebSocket.CONNECTING && mono() - c.openedAt > KICK_STALE_CONNECT)) this.connectNow();
  }

  private async http(method: string, path: string, body?: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body,
      cache: 'no-store',
      signal,
    });
  }

  async saveConfig(config: Config, baseRev: string, { force = false } = {}): Promise<SaveResult> {
    const body = JSON.stringify({ config, baseRev, ...(force ? { force: true } : {}) } satisfies SaveConfigBody);
    if (new Blob([body]).size > MAX_CONFIG_BYTES) return { ok: false, kind: 'error', message: TOO_LARGE };
    // A PUT on a link that died without a reset would wait for minutes: give up, the caller checks.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SAVE_TIMEOUT);
    try {
      const r = await this.http('PUT', '/api/config', body, ctl.signal);
      const j = (await r.json().catch((e: unknown) => {
        if (ctl.signal.aborted) throw e;
        return {};
      })) as { rev?: string; errors?: string[]; error?: string; invalid?: boolean; warnings?: unknown };
      if (r.ok && j.rev) return { ok: true, rev: j.rev, ...(Array.isArray(j.warnings) && j.warnings.length ? { warnings: j.warnings.map(String) } : {}) };
      if (r.status === 400) return { ok: false, kind: 'invalid', errors: j.errors ?? ['invalid config'] };
      if (r.status === 409) return { ok: false, kind: 'conflict', rev: j.rev ?? '', ...(j.invalid ? { invalid: true, errors: j.errors ?? [] } : {}) };
      if (r.status === 413) return { ok: false, kind: 'error', message: TOO_LARGE };
      return { ok: false, kind: 'error', message: j.error ?? `HTTP ${r.status}` };
    } catch (e) {
      const message = ctl.signal.aborted ? `the host didn't answer within ${SAVE_TIMEOUT / 1000} s` : e instanceof Error ? e.message : String(e);
      return { ok: false, kind: 'error', message, unsure: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async getConfig(): Promise<{ config: WireConfig; rev: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GET_TIMEOUT);
    try {
      const r = await this.http('GET', '/api/config', undefined, ctl.signal);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { config?: WireConfig; rev?: string };
      if (!j.config?.pads || typeof j.rev !== 'string') throw new Error('unexpected answer from the host');
      return { config: j.config, rev: j.rev };
    } catch (e) {
      throw ctl.signal.aborted ? new Error(`the host didn't answer within ${GET_TIMEOUT / 1000} s`) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  async runs(q: { pad?: string; button?: string } = {}): Promise<RunRecord[]> {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();
    const r = await this.http('GET', `/api/runs${qs ? `?${qs}` : ''}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as RunRecord[];
  }

  async pairCode(): Promise<PairCode> {
    let r: Response;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GET_TIMEOUT);
    try {
      r = await this.http('POST', '/api/pair-code', '{}', ctl.signal);
    } catch {
      throw new Error('Can’t reach the host.');
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 401 || r.status === 403) throw new Error('Only an admin device can make pairing codes.');
    if (r.status === 404 || r.status === 405) throw new Error('This host doesn’t make pairing codes (it runs an older ButtPad).');
    if (r.status === 429 || r.status === 503) throw new Error('Too many codes just now: try again in a minute.');
    if (!r.ok) throw new Error(`The host answered HTTP ${r.status}.`);
    const j = (await r.json().catch(() => null)) as Partial<PairCode> | null;
    if (!j || (typeof j.code !== 'string' && typeof j.code !== 'number') || typeof j.expiresAt !== 'number') throw new Error('Unexpected answer from the host.');
    return { code: String(j.code), expiresAt: j.expiresAt, role: j.role === 'press' ? 'press' : 'admin' };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    for (const off of this.offs) off();
    if (this.conn) this.drop(this.conn);
  }
}
