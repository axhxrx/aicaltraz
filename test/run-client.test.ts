/**
 * Run mode's client logic (src/web/run/session.ts, controller.ts) driven through a fake backend,
 * and the demo backend's host semantics (src/web/backend/demo.ts): whose run it is (a queued re-run
 * that gets dropped, a press with NO RESPONSE, run ids that start over), palms in rough mode, a
 * press carrying the gesture's own time, a key for a button on another pad, removed buttons, host
 * restarts.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { LastResult, RunState } from '../src/core/machine.ts';
import type { PressResult, StateMap, WireButton, WireConfig } from '../src/core/protocol.ts';
import { emptySnapshot, PressError, type Backend, type PressAck, type PressOpts, type Snapshot } from '../src/web/backend/types.ts';
import { createStore } from '../src/web/lib/store.ts';

// The modules below read navigator.vibrate and localStorage when they load: those come first.
const vib: string[] = [];
const storage = new Map<string, string>();
let RunSession: typeof import('../src/web/run/session.ts').RunSession;
let viewOf: typeof import('../src/web/run/view.ts').viewOf;
let settings: typeof import('../src/web/lib/settings.ts').settings;
let DemoBackend: typeof import('../src/web/backend/demo.ts').DemoBackend;
let mono: () => number;
let wall: () => number;
beforeAll(async () => {
  Object.defineProperty(globalThis.navigator, 'vibrate', { value: (p: unknown) => (vib.push(JSON.stringify(p)), true), configurable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    configurable: true,
  });
  ({ RunSession } = await import('../src/web/run/session.ts'));
  ({ viewOf } = await import('../src/web/run/view.ts'));
  ({ settings } = await import('../src/web/lib/settings.ts'));
  ({ DemoBackend } = await import('../src/web/backend/demo.ts'));
  ({ mono } = await import('../src/web/lib/env.ts'));
  ({ wall } = await import('../src/web/lib/clock.ts'));
});

const FIRE = '35';
const FAILURE = '[320]';
const SUCCESS = '[40,70,40]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (script: string) => ({ type: 'shell' as const, script });

/** A press the fake host got: answer it (`ack`), or let the link drop under it (`fail`). */
interface Got {
  button: string;
  opts: PressOpts;
  ack(a: PressAck): void;
  fail(e: Error): void;
}

/** A host as the client sees it: states, presses, and their answers, all by hand. */
class FakeBackend implements Backend {
  readonly kind = 'ws' as const;
  readonly snapshot;
  got: Got[] = [];
  constructor(config: WireConfig, states: StateMap) {
    this.snapshot = createStore<Snapshot>(emptySnapshot({ status: 'online', role: 'press', config, states }));
  }
  press(_pad: string, button: string, opts: PressOpts = {}): Promise<PressResult> {
    return new Promise((resolve, reject) => {
      this.got.push({ button, opts, ack: (a) => (opts.onAck?.(a), resolve(a.result)), fail: reject });
      opts.onSent?.();
    });
  }
  set(key: string, st: RunState) {
    this.snapshot.set((s) => ({ ...s, states: { ...s.states, [key]: st } }));
  }
  /** The link drops and comes back: a fresh hello with these states. */
  hello(states: StateMap) {
    this.snapshot.set((s) => ({ ...s, status: 'offline' }));
    this.snapshot.set((s) => ({ ...s, status: 'online', states }));
  }
  kick() {}
  async saveConfig(): Promise<never> {
    throw new Error('not here');
  }
  async getConfig(): Promise<never> {
    throw new Error('not here');
  }
  async runs() {
    return [];
  }
  dispose() {}
}

type ButtonIn = NonNullable<ConfigInput['pads'][number]['buttons']>[number];
const tapButton = (id: string, x: number, extra: Partial<ButtonIn> = {}): ButtonIn => ({ id, label: id, x, y: 0, trigger: 'tap', cooldownMs: 0, action: sh('true'), ...extra });

/** A session over one pad of these buttons; `ctl.<id>` is each button's controller, `vm(id)` what it shows. */
function setup(buttons: ButtonIn[], states: StateMap = {}) {
  const config = Config.parse({ version: 1, pads: [{ id: 'p', name: 'P', cols: 4, rows: 1, buttons }] }) as WireConfig;
  const be = new FakeBackend(config, states);
  const session = new RunSession(be);
  const pad = config.pads[0]!;
  const ctl: Record<string, import('../src/web/run/controller.ts').ButtonController> = {};
  for (const b of pad.buttons) ctl[b.id] = session.controller(pad, b);
  const vm = (id: string, now = wall()) => {
    const b = pad.buttons.find((x) => x.id === id) as WireButton;
    const s = be.snapshot.get();
    return viewOf(b, s.states[`p/${id}`] ?? { phase: 'ready', runId: 0 }, ctl[id]!.local.get(), s.status, 0, now);
  };
  return { be, session, ctl, vm, sent: () => be.got.map((g) => g.button) };
}

const running = (runId: number, extra: Partial<Extract<RunState, { phase: 'running' }>> = {}): RunState => ({ phase: 'running', runId, startedAt: wall(), ...extra });
const failed = (runId: number, extra: Partial<Extract<RunState, { phase: 'failure' }>> = {}): RunState => ({
  phase: 'failure',
  runId,
  startedAt: wall() - 200,
  endedAt: wall(),
  exitCode: 3,
  reason: 'exit',
  text: 'boom',
  ...extra,
});
const succeeded = (runId: number, extra: Partial<Extract<RunState, { phase: 'success' }>> = {}): RunState => ({ phase: 'success', runId, startedAt: wall() - 200, endedAt: wall(), exitCode: 0, ...extra });
const ready = (runId: number, last?: LastResult): RunState => ({ phase: 'ready', runId, ...(last ? { last } : {}) });

beforeEach(() => {
  vib.length = 0;
  settings.set((s) => ({ ...s, rough: false, haptics: true }));
});

describe('palms', () => {
  for (const rough of [false, true])
    test(`contacts landing on three buttons at once fire none of them (rough mode ${rough ? 'on' : 'off'})`, async () => {
      settings.set((s) => ({ ...s, rough }));
      const { ctl, sent, session } = setup([tapButton('a', 0), tapButton('b', 1), tapButton('c', 2)]);
      const t = mono();
      ctl.a!.down('p1', 10, 10, t);
      ctl.b!.down('p2', 110, 10, t);
      ctl.c!.down('p3', 210, 10, t);
      await sleep(120);
      const t2 = mono();
      for (const [id, src] of [['a', 'p1'], ['b', 'p2'], ['c', 'p3']] as const) ctl[id]!.up(src, t2);
      await sleep(20);
      expect(sent()).toEqual([]);
      session.dispose();
    });

  test('rough mode still takes one button at a time: of two contacts, only the first one fires', async () => {
    settings.set((s) => ({ ...s, rough: true }));
    const { ctl, sent, session } = setup([tapButton('a', 0), tapButton('b', 1)]);
    const t = mono();
    expect(ctl.a!.down('p1', 10, 10, t)).toBe(true);
    expect(ctl.b!.down('p2', 110, 10, t + 5)).toBe(false);
    await sleep(120);
    ctl.b!.up('p2', mono());
    ctl.a!.up('p1', mono());
    expect(sent()).toEqual(['a']);
    session.dispose();
  });
});

describe('a queued re-run', () => {
  test("stays this device's while it's coming: its outcome buzzes and a failure is kept", async () => {
    const { be, ctl, vm, session } = setup([tapButton('q', 0, { whileRunning: 'queue' })], { 'p/q': running(5) });
    ctl.q!.key(mono());
    // As on a host: the ack first, then the state that shows the queue.
    be.got[0]!.ack({ result: 'queued', runId: 5 });
    be.set('p/q', running(5, { queued: true }));
    be.set('p/q', succeeded(5, { queued: true }));
    be.set('p/q', running(6));
    expect(vm('q').other).toBeFalsy();
    be.set('p/q', failed(6));
    expect(ctl.q!.local.get().result?.kind).toBe('failure');
    expect(vib).toContain(FAILURE);
    session.dispose();
  });

  test('dropped by All off (cancelled without it): the next run, started by someone else, is theirs', async () => {
    const { be, ctl, vm, session } = setup([tapButton('q', 0, { whileRunning: 'queue' })], { 'p/q': running(5) });
    ctl.q!.key(mono());
    be.got[0]!.ack({ result: 'queued', runId: 5 });
    be.set('p/q', running(5, { queued: true }));
    // Another device's All off: the run is cancelled, its re-run dropped.
    be.set('p/q', running(5, { cancelling: true }));
    be.set('p/q', failed(5, { reason: 'cancelled', exitCode: null, text: 'Stopped by All off' }));
    be.set('p/q', ready(5, { runId: 5, ok: false, reason: 'cancelled', endedAt: wall() }));
    vib.length = 0;
    // Later a third device runs it.
    be.set('p/q', running(6));
    expect(vm('q').other).toBe(true);
    be.set('p/q', failed(6));
    be.set('p/q', ready(6, { runId: 6, ok: false, reason: 'exit', endedAt: wall() }));
    expect(ctl.q!.local.get().result).toBeNull();
    expect(vm('q').sticky).toBeFalsy();
    expect(vib).not.toContain(FAILURE);
    session.dispose();
  });

  test('dropped by a host restart (its run interrupted, no re-run): the next run is not this device’s', async () => {
    const { be, ctl, vm, session } = setup([tapButton('q', 0, { whileRunning: 'queue' })], { 'p/q': running(5) });
    ctl.q!.key(mono());
    be.got[0]!.ack({ result: 'queued', runId: 5 });
    be.set('p/q', running(5, { queued: true }));
    be.hello({ 'p/q': failed(5, { reason: 'interrupted', exitCode: null }) });
    be.set('p/q', ready(5));
    be.set('p/q', running(6));
    expect(vm('q').other).toBe(true);
    be.set('p/q', failed(6));
    expect(ctl.q!.local.get().result).toBeNull();
    expect(vib).not.toContain(FAILURE);
    session.dispose();
  });
});

describe('NO RESPONSE', () => {
  /** A press whose link drops before the answer: NO RESPONSE, at once. */
  async function unanswered(key = 'g', extra: Partial<ButtonIn> = {}, states: StateMap = { 'p/g': ready(0) }) {
    const s = setup([tapButton(key, 0, extra)], states);
    s.ctl[key]!.key(mono());
    s.be.got[0]!.fail(new PressError(true, 'the link to the host dropped before it answered'));
    await sleep(0);
    expect(s.ctl[key]!.local.get().result?.kind).toBe('noresponse');
    vib.length = 0;
    return s;
  }

  test("a run that starts more than 3 s after the press was made is someone else's (the host would have dropped the press)", async () => {
    const { be, ctl, vm, session } = await unanswered();
    be.set('p/g', running(1, { startedAt: wall() + 3500 }));
    expect(vm('g').other).toBe(true);
    be.set('p/g', failed(1));
    expect(ctl.g!.local.get().result).toBeNull();
    expect(vm('g').sticky).toBeFalsy();
    expect(vib).not.toContain(FAILURE);
    session.dispose();
  });

  test('a run that starts within 3 s of the press is what the press did', async () => {
    const { be, ctl, vm, session } = await unanswered();
    be.set('p/g', running(1, { startedAt: wall() + 1200 }));
    expect(vm('g').other).toBeFalsy();
    expect(vm('g').visual).toBe('running');
    be.set('p/g', failed(1));
    expect(ctl.g!.local.get().result?.kind).toBe('failure');
    expect(vib).toContain(FAILURE);
    session.dispose();
  });

  test('on a running queue button, the re-run that follows is what the press did, unless the run ended without one', async () => {
    let s = await unanswered('g', { whileRunning: 'queue' }, { 'p/g': running(5) });
    s.be.set('p/g', running(5, { queued: true }));
    s.be.set('p/g', succeeded(5, { queued: true }));
    s.be.set('p/g', running(6, { startedAt: wall() + 8000 }));
    expect(s.vm('g').other).toBeFalsy();
    s.be.set('p/g', succeeded(6));
    expect(vib).toContain(SUCCESS);
    s.session.dispose();

    s = await unanswered('g', { whileRunning: 'queue' }, { 'p/g': running(5) });
    s.be.set('p/g', running(5, { cancelling: true }));
    s.be.set('p/g', failed(5, { reason: 'cancelled', exitCode: null }));
    s.be.set('p/g', ready(5));
    s.be.set('p/g', running(6, { startedAt: wall() + 8000 }));
    expect(s.vm('g').other).toBe(true);
    s.be.set('p/g', failed(6));
    expect(vib).not.toContain(FAILURE);
    s.session.dispose();
  });
});

describe('run ids that start over', () => {
  /** This device runs #1 and #2 (both fine). */
  async function twoRuns() {
    const s = setup([tapButton('t', 0)], { 'p/t': ready(0) });
    for (const id of [1, 2]) {
      s.ctl.t!.key(mono());
      s.be.got.at(-1)!.ack({ result: 'started', runId: id });
      s.be.set('p/t', running(id));
      s.be.set('p/t', succeeded(id));
      s.be.set('p/t', ready(id, { runId: id, ok: true, endedAt: wall() }));
    }
    vib.length = 0;
    return s;
  }

  async function afterwards(s: Awaited<ReturnType<typeof twoRuns>>) {
    // Someone else's #1: marked as theirs.
    s.be.set('p/t', running(1));
    expect(s.vm('t').other).toBe(true);
    s.be.set('p/t', succeeded(1));
    s.be.set('p/t', ready(1, { runId: 1, ok: true, endedAt: wall() }));
    // This device's own #2: not marked; its failure buzzes and stays.
    s.ctl.t!.key(mono());
    s.be.got.at(-1)!.ack({ result: 'started', runId: 2 });
    s.be.set('p/t', running(2));
    expect(s.vm('t').other).toBeFalsy();
    s.be.set('p/t', failed(2));
    s.be.set('p/t', ready(2, { runId: 2, ok: false, reason: 'exit', endedAt: wall() }));
    expect(s.ctl.t!.local.get().result?.kind).toBe('failure');
    expect(s.vm('t').sticky).toBe(true);
    expect(vib).toContain(FAILURE);
    s.session.dispose();
  }

  test('a host that started without its state file (a hello with lower run ids): this device forgets its old runs', async () => {
    const s = await twoRuns();
    s.be.hello({ 'p/t': ready(0) });
    await afterwards(s);
  });

  test("the demo's Reset (the button's state is gone): the same", async () => {
    const s = await twoRuns();
    s.be.snapshot.set((x) => ({ ...x, states: {} }));
    await afterwards(s);
  });

  test('a failure kept on screen stays until touched, and the next run supersedes it', async () => {
    const s = setup([tapButton('t', 0)], { 'p/t': ready(0) });
    s.ctl.t!.key(mono());
    s.be.got[0]!.ack({ result: 'started', runId: 7 });
    s.be.set('p/t', running(7));
    s.be.set('p/t', failed(7));
    s.be.hello({ 'p/t': ready(0) });
    expect(s.vm('t').visual).toBe('failure');
    s.be.set('p/t', running(1));
    expect(s.vm('t').visual).toBe('running');
    s.session.dispose();
  });
});

describe('keys and presses', () => {
  test("a press carries when it was made (the gesture's own time), not when the page got to send it", () => {
    const { ctl, be, session } = setup([tapButton('k', 0), tapButton('t', 1), { id: 'h', label: 'h', x: 2, y: 0, holdMs: 500, cooldownMs: 0, action: sh('true') }]);
    const t = mono() - 700;
    ctl.k!.key(t);
    // A tap: when its finger lifted.
    const t0 = mono() - 900;
    ctl.t!.down('p1', 110, 10, t0);
    ctl.t!.up('p1', t0 + 100);
    // A hold: when it reached holdMs (the finger lifted later).
    ctl.h!.down('p2', 210, 10, t0);
    ctl.h!.up('p2', t0 + 650);
    expect(be.got.map((g) => [g.button, g.opts.at])).toEqual([
      ['k', t],
      ['t', t0 + 100],
      ['h', t0 + 500],
    ]);
    session.dispose();
  });

  test('a press on a failure kept on screen is a retry, a key too; the kept failure stays until then, and its ✕ clears it', async () => {
    const { ctl, be, sent, vm, session } = setup([tapButton('k', 0, { key: 'k' }), tapButton('c', 1, { key: 'c', confirm: true })], { 'p/k': ready(0), 'p/c': ready(0) });
    const fail = (id: string, runId: number) => {
      be.got.at(-1)!.ack({ result: 'started', runId });
      be.set(`p/${id}`, running(runId));
      be.set(`p/${id}`, failed(runId));
      be.set(`p/${id}`, ready(runId, { runId, ok: false, reason: 'exit', endedAt: wall() }));
      expect(vm(id).sticky).toBe(true);
    };
    ctl.k!.key(mono());
    fail('k', 1);
    // A key (a BLE remote): fires again.
    vib.length = 0;
    const what = ctl.k!.key(mono());
    expect(sent()).toEqual(['k', 'k']);
    expect(what).toBe('sent');
    expect(vib).toContain(FIRE);
    fail('k', 2);
    // A tap: fires on release like any tap; until then the failure stays.
    const t = mono();
    ctl.k!.down('p1', 10, 10, t);
    expect(vm('k').visual).toBe('failure');
    ctl.k!.up('p1', t + 80);
    expect(sent()).toEqual(['k', 'k', 'k']);
    fail('k', 3);
    // Its ✕: cleared, nothing sent.
    ctl.k!.dismiss();
    expect(vm('k').visual).toBe('ready');
    expect(sent()).toEqual(['k', 'k', 'k']);
    // A confirm button: the retry asks for the confirm step over the kept failure, which is back when the window runs out.
    ctl.c!.key(mono());
    expect(vm('c').visual).toBe('confirm');
    await sleep(450);
    ctl.c!.key(mono());
    fail('c', 1);
    expect(ctl.c!.key(mono())).toBe('confirm');
    expect(vm('c').visual).toBe('confirm');
    expect(vm('c', wall() + 3100).visual).toBe('failure');
    session.dispose();
  });

  test('a mouse or pen click fires a tap button however short; a finger needs 40 ms (shorter is a graze)', () => {
    const { ctl, sent, session } = setup([tapButton('a', 0), tapButton('b', 1), tapButton('c', 2)]);
    // (Contacts 100 ms apart: three within 60 ms would be a palm.)
    const t = mono() - 500;
    ctl.a!.down('p1', 10, 10, t, 'touch');
    ctl.a!.up('p1', t + 15);
    ctl.b!.down('p2', 110, 10, t + 100, 'mouse');
    ctl.b!.up('p2', t + 108);
    ctl.c!.down('p3', 210, 10, t + 200, 'pen');
    ctl.c!.up('p3', t + 212);
    expect(sent()).toEqual(['b', 'c']);
    session.dispose();
  });

  test("in a queued re-run's gap (its result says NEXT RUN QUEUED), a press says ALREADY QUEUED and sends nothing", () => {
    const gap = succeeded(4, { queued: true });
    const { ctl, sent, vm, session } = setup([tapButton('q', 0, { whileRunning: 'queue' }), tapButton('c', 1, { whileRunning: 'queue', confirm: true })], { 'p/q': gap, 'p/c': gap });
    const what = ctl.q!.key(mono());
    expect(sent()).toEqual([]);
    expect(vm('q').flash?.kind).toBe('queued');
    // Not a confirm step either: nothing can start yet.
    const t = mono();
    ctl.c!.down('p1', 110, 10, t);
    ctl.c!.up('p1', t + 80);
    expect(vm('c').visual).not.toBe('confirm');
    expect(vm('c').flash?.kind).toBe('queued');
    expect(sent()).toEqual([]);
    expect(what).toBe('queued');
    session.dispose();
  });

  test('a key says what it did: sent, confirm, again (a double), cooldown, busy, offline', () => {
    const { ctl, be, session } = setup([
      tapButton('c', 0, { confirm: true }),
      tapButton('d', 1, { trigger: 'double' }),
      tapButton('s', 2, { cooldownMs: 400 }),
    ]);
    const t = mono();
    expect(ctl.c!.key(t)).toBe('confirm');
    expect(ctl.d!.key(t)).toBe('again');
    expect(ctl.d!.key(t + 150)).toBe('sent');
    expect(ctl.s!.key(t)).toBe('sent');
    expect(ctl.s!.key(t + 30)).toBe('cooldown');
    be.snapshot.set((x) => ({ ...x, status: 'offline' }));
    expect(ctl.s!.key(t + 900)).toBe('offline');
    session.dispose();
  });
});

describe('the demo backend, like the host', () => {
  const CFG: ConfigInput = {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'rec', label: 'Rec', x: 0, y: 0, trigger: 'tap', action: sh("echo '@state REC'; echo ok") },
          { id: 'q', label: 'Q', x: 1, y: 0, trigger: 'tap', whileRunning: 'queue', resultHoldMs: 500, action: sh('sleep 0.3; echo q') },
        ],
      },
    ],
  };
  const demo = () => {
    storage.set('buttpad.demo.config', JSON.stringify(CFG));
    return new DemoBackend({ exact: true });
  };

  test('a removed button loses its @state: when it comes back, it has none', async () => {
    const d = demo();
    await d.press('p', 'rec');
    for (let i = 0; i < 100 && !d.snapshot.get().latched['p/rec']; i++) await sleep(10);
    expect(d.snapshot.get().latched['p/rec']).toBe('REC');
    const without: ConfigInput = { ...CFG, pads: [{ ...CFG.pads[0]!, buttons: [CFG.pads[0]!.buttons![1]!] }] };
    expect((await d.saveConfig(Config.parse(without), d.snapshot.get().rev!)).ok).toBe(true);
    expect(d.snapshot.get().latched['p/rec']).toBeUndefined();
    expect((await d.saveConfig(Config.parse(CFG), d.snapshot.get().rev!)).ok).toBe(true);
    expect(d.snapshot.get().latched['p/rec']).toBeUndefined();
    d.dispose();
  });

  test('a button removed while it runs leaves no state behind on devices (no ghost RUNNING), not even once its run ends', async () => {
    const d = demo();
    expect(await d.press('p', 'q')).toBe('started');
    expect(d.snapshot.get().states['p/q']?.phase).toBe('running');
    const without: ConfigInput = { ...CFG, pads: [{ ...CFG.pads[0]!, buttons: [CFG.pads[0]!.buttons![0]!] }] };
    expect((await d.saveConfig(Config.parse(without), d.snapshot.get().rev!)).ok).toBe(true);
    expect(d.snapshot.get().states['p/q']).toBeUndefined();
    await sleep(800);
    expect(d.snapshot.get().states['p/q']).toBeUndefined();
    // Back again: its state (and run ids) carry on.
    expect((await d.saveConfig(Config.parse(CFG), d.snapshot.get().rev!)).ok).toBe(true);
    expect(d.snapshot.get().states['p/q']).toMatchObject({ runId: 1 });
    d.dispose();
  });

  test("a host restart in a queued re-run's 800 ms gap loses the re-run (a host starting up shows READY)", async () => {
    const d = demo();
    expect(await d.press('p', 'q')).toBe('started');
    expect(await d.press('p', 'q')).toBe('queued');
    for (let i = 0; i < 100 && d.snapshot.get().states['p/q']?.phase !== 'success'; i++) await sleep(10);
    expect(d.snapshot.get().states['p/q']).toMatchObject({ phase: 'success', runId: 1, queued: true });
    d.restart();
    await sleep(1000);
    expect(d.snapshot.get().states['p/q']).toMatchObject({ phase: 'ready', runId: 1, last: { runId: 1, ok: true } });
    d.dispose();
  });
});
