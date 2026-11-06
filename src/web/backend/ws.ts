/**
 * The real host: a WebSocket for state, HTTP with a Bearer token for the rest.
 *
 * The token never goes in a URL: reverse proxies and preview panes log URLs (QA found the admin
 * token in one, a line a second while a probe ran). Each connection attempt first trades it for a
 * one-time ticket (`POST /api/ws-ticket`, Bearer header) and opens `/ws?ticket=…` with that; a
 * reconnect gets a fresh one. Browsers don't show why an upgrade was refused, so a socket that
 * never got its hello is followed by `POST /api/ws-check` (Bearer header again): 503 host full, 403
 * this page's origin refused (a proxy the host wasn't told about), 401 token rejected.
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
import type { ClientMsg, PressResult, RunRecord, SaveConfigBody, ServerMsg, StateMap, WireConfig, WsTicket } from '../../core/protocol.ts';
import { wall } from '../lib/clock.ts';
import { afterQueuedInput, mono } from '../lib/env.ts';
import { allowOriginOf } from '../lib/pairing.ts';
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
/** The one-way delay a socket's opening alone suggests, at most (see oneWay); and the most it is ever taken to be. */
const ONE_WAY_GUESS_MAX = 1000;
const ONE_WAY_MAX = 4000;
/** Resource Timing keeps a few hundred entries, then drops new ones: the ticket's must get in. */
const RT_ENTRIES_MAX = 150;
/** A spare ticket is used only until this long before it expires on the host (and renewed then); a failed try at one is retried after SPARE_RETRY. */
const SPARE_MARGIN = 10_000;
const SPARE_RETRY = 5000;
/** A ticket the host gave no lifetime for lives this long (the host's WS_TICKET_TTL_MS). */
const TICKET_TTL = 30_000;
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

/** One connection attempt (its ticket, then its socket) and everything that belongs to it. */
interface Conn {
  /** null while its ticket is on the way. */
  ws: WebSocket | null;
  /** Gives up on the ticket request (the attempt was dropped). */
  ticket: AbortController;
  greeted: boolean;
  /** mono() when the attempt began (ticket included). */
  startedAt: number;
  /** mono() when the socket was created, when it opened (the upgrade's answer), and of the hello. */
  openedAt: number;
  upAt: number;
  greetedAt: number;
  /**
   * The ticket request's round trip as the network stack timed it (Resource Timing: from sending
   * the request to the first byte of its answer, no connecting, unaffected by the page stalling).
   */
  ticketRtt?: number;
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

/**
 * A request's round trip as the network stack timed it (Resource Timing): from sending it to the
 * first byte of the answer — no connecting, no page stalls in it. Undefined where there is none.
 */
function requestRtt(e: PerformanceResourceTiming | undefined): number | undefined {
  return e && e.requestStart > 0 && e.responseStart >= e.requestStart ? e.responseStart - e.requestStart : undefined;
}

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
   * The last ticket request's round trip (Conn.ticketRtt): what the link is like until enough of
   * the above are in. QA: on a link 2 s each way, a fresh socket's first press waited the fast-link
   * 0.6 s + 1.5 s for a frame, was declared dead, and so on with every press; no round trip was
   * ever measured.
   */
  private linkHint: number | null = null;
  /**
   * A one-time ticket fetched while a socket was up, for the next attempt: a reconnect then opens
   * its socket at once, on a new connection, as before tickets. A ticket fetched only then can go
   * out on a pooled HTTP connection that died with the socket (a NAT forgetting it while the phone
   * slept), and hang. `until`: mono() it is used by.
   */
  private spare: { ticket: string; until: number } | null = null;
  /** The spare's request on its way; mono() before which no other starts. */
  private spareCtl: AbortController | null = null;
  private spareNext = 0;
  /** Ticket requests in a row that got no answer in time: the next one waits longer (a slow link, not a dead connection). */
  private ticketMisses = 0;
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
    // Until a ticket request has timed the link: the page's own request did (it came over the same link).
    this.linkHint = requestRtt(performance.getEntriesByType?.('navigation')?.[0] as PerformanceResourceTiming | undefined) ?? null;
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

  /** The 90th percentile of the recent round trips; too few of them: the ticket's (null: none either). */
  private rttP90(): number | null {
    if (this.rtts.length < RTT_MIN_SAMPLES) return this.linkHint;
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

  /** How long an attempt, and then its socket, may take to say hello: 5 s, doubled after each that didn't make it (≤ 60 s). */
  private helloWait(): number {
    return Math.min(HELLO_TIMEOUT_MAX, HELLO_TIMEOUT * 2 ** this.helloMisses);
  }

  /** Gives `c` until helloWait() from now, then it is dead (and the next attempt waits longer). */
  private armHello(c: Conn) {
    clearTimeout(c.helloTimer);
    c.helloTimer = setTimeout(() => {
      this.helloMisses++;
      this.lost(c);
    }, this.helloWait());
  }

  /**
   * A connection attempt: a one-time ticket of its own, then the socket. The hello's wait bounds
   * the whole attempt (a ticket request has a shorter wait of its own: openWithTicket); the socket
   * gets it afresh from when it is made, as before tickets.
   */
  private connect() {
    if (this.disposed || this.snapshot.get().status === 'unauthorized') return;
    clearTimeout(this.retryTimer);
    // Never two sockets: one already on its way (or up) wins.
    if (this.conn) return;
    const c: Conn = {
      ws: null,
      ticket: new AbortController(),
      greeted: false,
      startedAt: mono(),
      openedAt: 0,
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
    this.armHello(c);
    void this.openWithTicket(c);
  }

  /**
   * A ticket (the spare, or POST /api/ws-ticket with the token in its header), then
   * `/ws?ticket=…`: the token itself never goes in a URL. A ticket request gets the quick probe's
   * wait (1.5 s on a fast link), doubled after each one in a row that didn't answer in time: given
   * up on, its connection is closed, and the next attempt gets another.
   */
  private async openWithTicket(c: Conn) {
    const live = () => this.conn === c && !this.disposed;
    let ticket: string | undefined = this.takeSpare() ?? undefined;
    if (!ticket) {
      const timer = setTimeout(() => {
        this.ticketMisses++;
        c.ticket.abort();
      }, Math.min(HELLO_TIMEOUT_MAX, this.probeTimeout(true) * 2 ** this.ticketMisses));
      try {
        const r = await this.http('POST', '/api/ws-ticket', undefined, c.ticket.signal);
        if (!live()) return;
        if (r.status === 401) return this.rejected();
        if (r.status === 403) {
          // This page's origin is turned away (a proxy the host wasn't told about): say so, keep trying.
          const allowOrigin = (await allowOriginOf(r)) ?? null;
          if (live() && this.snapshot.get().status !== 'online') this.patch({ originRefused: true, allowOrigin, hostFull: false });
        } else if (r.ok) ticket = ((await r.json()) as Partial<WsTicket> | null)?.ticket;
        if (ticket) this.ticketMisses = 0;
      } catch {
        /* unreachable, or given up on: below */
      } finally {
        clearTimeout(timer);
      }
    }
    if (!live()) return;
    if (typeof ticket !== 'string' || !ticket) return this.lost(c);
    const proto = this.origin.startsWith('https:') ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${this.origin.replace(/^https?:\/\//, '')}/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      return this.lost(c);
    }
    c.ws = ws;
    c.openedAt = mono();
    this.armHello(c);
    ws.onmessage = (ev) => {
      if (this.conn === c) this.onFrame(c, ev.data);
    };
    ws.onopen = () => void (c.upAt = mono());
    ws.onclose = () => this.lost(c);
  }

  /** The spare ticket, if it is still good (it is used once either way). */
  private takeSpare(): string | null {
    const s = this.spare;
    this.spare = null;
    return s && mono() < s.until ? s.ticket : null;
  }

  /**
   * While socket `c` is up (a frame just came) and the page visible: a spare ticket for the next
   * attempt, renewed when it is about to expire (frames come every few seconds at least: the idle
   * probe). Not while one is on its way, nor sooner than SPARE_RETRY after the last try.
   */
  private keepSpare(c: Conn) {
    if (this.disposed || this.spareCtl || mono() < this.spareNext || (this.spare && mono() < this.spare.until)) return;
    if (this.conn !== c || !c.greeted || document.visibilityState !== 'visible') return;
    void this.fetchSpare();
  }

  private async fetchSpare() {
    const ctl = new AbortController();
    this.spareCtl = ctl;
    this.spareNext = mono() + SPARE_RETRY;
    const timer = setTimeout(() => ctl.abort(), GET_TIMEOUT);
    try {
      const r = await this.http('POST', '/api/ws-ticket', undefined, ctl.signal);
      const j = r.ok ? ((await r.json()) as Partial<WsTicket> | null) : null;
      if (typeof j?.ticket !== 'string' || !j.ticket || this.disposed) return;
      const ttl = typeof j.expiresInMs === 'number' && j.expiresInMs > SPARE_MARGIN ? j.expiresInMs : TICKET_TTL;
      this.spare = { ticket: j.ticket, until: mono() + ttl - SPARE_MARGIN };
    } catch {
      /* the socket's own checks say what the link is like */
    } finally {
      clearTimeout(timer);
      if (this.spareCtl === ctl) this.spareCtl = null;
    }
  }

  /** The host turned the token down (401): stop, and say so. */
  private rejected() {
    clearTimeout(this.retryTimer);
    if (this.conn) this.drop(this.conn);
    this.patch({ status: 'unauthorized', retryAt: null });
  }

  /**
   * How long the upgrade's answer took to get here from when the host stamped serverNow: about half
   * a round trip. Opening the socket took the upgrade's round trip, plus one for connecting unless
   * that was free (a proxy or tunnel on this machine): the one-way delay is between a quarter and
   * half of it. A quarter (at most 1 s) unless the ticket's request timed the round trip on its own:
   * then half of that, within those bounds (QA: through a proxy 2 s each way, the quarter came out
   * at half the real delay, and every press looked a second older to the host than it was).
   */
  private oneWay(c: Conn): number {
    const opening = Math.max(0, (c.upAt || c.greetedAt) - c.openedAt);
    const quarter = Math.min(ONE_WAY_GUESS_MAX, opening / 4);
    if (c.ticketRtt === undefined) return quarter;
    return Math.min(ONE_WAY_MAX, Math.max(quarter, Math.min(opening / 2, c.ticketRtt / 2)));
  }

  /**
   * Conn.ticketRtt from Resource Timing: the last ticket request of the past minute, this socket's
   * or the spare it used (an entry is in by the hello: the socket took a round trip at least);
   * undefined where the browser has none.
   */
  private ticketTiming(): number | undefined {
    try {
      const all = performance.getEntriesByName(`${this.origin}/api/ws-ticket`, 'resource') as PerformanceResourceTiming[];
      const e = all.filter((x) => x.startTime >= mono() - 60_000 && x.responseStart > 0).at(-1);
      if (performance.getEntriesByType('resource').length > RT_ENTRIES_MAX) performance.clearResourceTimings();
      return requestRtt(e);
    } catch {
      return undefined;
    }
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
      c.ticketRtt = this.ticketTiming();
      if (c.ticketRtt !== undefined) this.linkHint = c.ticketRtt;
    }
    this.onMessage(c, msg);
    // The next attempt's ticket, while the link is up.
    if (c.greeted) this.keepSpare(c);
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
      if (!c.ws) throw new Error('no socket yet');
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
    if (c.ws?.readyState !== WebSocket.OPEN) return this.lost(c);
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
    c.ticket.abort();
    clearTimeout(c.helloTimer);
    clearTimeout(c.idleTimer);
    clearTimeout(c.probeTimer);
    const { ws } = c;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onopen = null;
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      } catch {
        /* already going */
      }
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
   * that never got its hello (`failed`): why was it turned away?
   */
  private async probeHttp(failed = false) {
    const live = () => this.disposed || this.snapshot.get().status === 'online';
    try {
      const t0 = mono();
      const r = await this.http('GET', '/api/state');
      // serverNow was taken about half the round trip ago.
      const half = Math.min(1000, (mono() - t0) / 2);
      if (r.status === 401 || r.status === 403) return this.rejected();
      if (!r.ok || live()) return;
      // What an upgrade from this page gets now, asked over HTTP (the token in the header, nothing in
      // the URL): 204 there's room; 503 the host is full; 403 it turns this page's address away (a
      // proxy, tunnel or preview in front of it that it wasn't told about: --allow-origin). A POST,
      // because a browser sends a same-origin GET without its Origin.
      if (failed) {
        const rc = await this.http('POST', '/api/ws-check').catch(() => null);
        const full = rc?.status === 503;
        const refused = rc?.status === 403;
        const allowOrigin = rc && refused ? ((await allowOriginOf(rc)) ?? null) : null;
        if (rc?.status === 401) return this.rejected();
        const s = this.snapshot.get();
        if (!live() && (full !== s.hostFull || refused !== s.originRefused || allowOrigin !== s.allowOrigin)) this.patch({ hostFull: full, originRefused: refused, allowOrigin });
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
          allowOrigin: null,
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
    if (c?.greeted && c.ws?.readyState !== WebSocket.OPEN) this.lost(c);
    const ws = c?.ws;
    if (this.snapshot.get().status !== 'online' || this.conn !== c || !c?.greeted || !ws) return Promise.reject(new PressError(false, 'not connected to the host'));
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    // When it was made (the gesture's time: a stalled page gets here late), in the host's clock:
    // the host drops it if it got there too late (the button's maxLatenessMs).
    const made = Math.min(mono(), opts.at ?? Infinity);
    const at = Math.round(wall() - (mono() - made) - this.snapshot.get().clockSkew);
    const lateness = latenessOf(wireButton(this.snapshot.get().config, pad, button));
    const msg: ClientMsg = { t: 'press', id, pad, button, at, ...(opts.confirm ? { confirm: true } : {}) };
    return new Promise((resolve, reject) => {
      try {
        ws.send(JSON.stringify(msg));
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
    // Offline, waiting for the next retry, or stuck getting a ticket or opening a socket that should
    // be open by now (one that is open and waiting for a slow hello is left to it): go now.
    else if (!c || ((!c.ws || c.ws.readyState === WebSocket.CONNECTING) && mono() - (c.ws ? c.openedAt : c.startedAt) > KICK_STALE_CONNECT)) this.connectNow();
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
    this.spareCtl?.abort();
    this.spare = null;
    for (const off of this.offs) off();
    if (this.conn) this.drop(this.conn);
  }
}
