/**
 * Protocol v2 against a real host (one per spec file and project): presses carry `at` and
 * `confirm`; a press held up in a dead link (or a stalled page) is dropped, never run late; two
 * devices pressing at once (only the winner hears success); `@state` latched device state; "host
 * is full"; a touch while offline reconnects at once; a slow hello still connects, and its clock
 * offset holds; a queued re-run that gets dropped stops being this device's; a host that lost its
 * state file (run ids start over); blocked storage.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, expectVisual, Fingers, recordPressFrames, recordVibrations, VIB } from './helpers.ts';
import { startHost, type Host } from './host.ts';
import { startProxy, type Proxy } from './proxy.ts';

test.describe.configure({ mode: 'default' });

const sh = (script: string) => ({ type: 'shell' as const, script });
const CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 2,
      rows: 2,
      buttons: [
        { id: 'tap', label: 'Tap', x: 0, y: 0, trigger: 'tap', resultHoldMs: 2000, key: 't', action: sh('echo ran >> ran.log; sleep 0.4; echo tapped') },
        { id: 'conf', label: 'Danger', color: '#4338ca', x: 1, y: 0, trigger: 'tap', confirm: true, confirmWindowMs: 3000, resultHoldMs: 800, action: sh('echo confirmed') },
        {
          id: 'rec',
          label: 'REC',
          color: '#dc2626',
          x: 0,
          y: 1,
          trigger: 'tap',
          resultHoldMs: 600,
          action: sh("if [ -f rec.on ]; then rm rec.on; echo '@state'; echo stopped; else touch rec.on; echo '@state REC ●'; echo recording; fi"),
        },
        { id: 'quick', label: 'Quick', color: '#0d9488', x: 1, y: 1, trigger: 'tap', resultHoldMs: 600, action: sh('echo quick') },
      ],
    },
    {
      id: 'bg',
      name: 'Background',
      cols: 1,
      rows: 1,
      // Keeps frames coming from the host (progress every 100 ms): a socket with traffic isn't probed.
      buttons: [{ id: 'ticker', label: 'Ticker', x: 0, y: 0, trigger: 'tap', action: sh('i=0; while [ $i -lt 300 ]; do echo "@progress $((i / 3))"; i=$((i + 1)); sleep 0.1; done') }],
    },
    {
      id: 'work',
      name: 'Work',
      cols: 3,
      rows: 1,
      // Each fails while its flag file exists (in the host's folder).
      buttons: [
        { id: 'render', label: 'Render', x: 0, y: 0, trigger: 'tap', key: 'r', whileRunning: 'queue', resultHoldMs: 600, action: sh('if [ -f render.fail ]; then sleep 0.6; echo "render failed" >&2; exit 3; fi; sleep 1.5; echo rendered') },
        { id: 'off', label: 'All off', x: 1, y: 0, trigger: 'tap', stops: ['work/*'], action: { type: 'none' } },
        { id: 'upload', label: 'Upload', x: 2, y: 0, trigger: 'tap', key: 'u', cooldownMs: 0, resultHoldMs: 600, action: sh('if [ -f upload.fail ]; then sleep 0.4; echo "upload failed" >&2; exit 1; fi; sleep 0.3; echo uploaded') },
      ],
    },
  ],
};

let host: Host;
let proxy: Proxy | null = null;
const sockets: WebSocket[] = [];

test.beforeAll(async () => {
  host = await startHost(CONFIG);
});
test.afterAll(async () => {
  await host?.dispose();
});
test.afterEach(async () => {
  await proxy?.close();
  proxy = null;
  for (const s of sockets.splice(0)) s.close();
});

const conn = (page: Page) => page.getByTestId('conn');
/** How many times the host ran "tap". */
const runs = () => {
  const log = path.join(path.dirname(host.configPath), 'ran.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
};

async function open(page: Page, via: Proxy | null = null, pad = 'main') {
  await page.goto(`${via?.url ?? host.url}/?pad=${pad}#token=${host.pressToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
}

/** A file in the host's folder (its actions run there). */
const hostFile = (name: string) => path.join(path.dirname(host.configPath), name);

/** Another device presses (the HTTP API): no ack for this page. */
async function pressElsewhere(request: APIRequestContext, pad: string, button: string) {
  const r = await request.post(`${host.url}/api/press/${pad}/${button}`, { headers: { authorization: `Bearer ${host.pressToken}` } });
  return ((await r.json()) as { result?: string }).result;
}

test('presses carry `at` (the host clock) and `confirm` only after the confirm step', async ({ page, hasTouch }) => {
  const frames = await recordPressFrames(page);
  await open(page);
  const f = new Fingers(page, hasTouch);
  await f.tap('tap');
  await expectVisual(page, 'tap', 'success');
  await f.tap('conf');
  await expectVisual(page, 'conf', 'confirm');
  await page.waitForTimeout(450);
  await f.tap('conf');
  await expectVisual(page, 'conf', 'success');
  const sent = await frames();
  expect(sent.map((x) => `${x.button}:${x.confirm ? 'confirm' : '-'}`)).toEqual(['tap:-', 'conf:confirm']);
  // Host and browser share a clock here: `at` is when it was sent, give or take the offset estimate.
  for (const x of sent) expect(Math.abs((x.at ?? 0) - x.sentAt)).toBeLessThan(1500);
});

test('a press held up on the way reaches the host too late: dropped, never run; NO RESPONSE, then NOT SENT (too late)', async ({ page, hasTouch, request }) => {
  proxy = await startProxy(host.port);
  await open(page, proxy);
  await expectVisual(page, 'tap', 'ready', 8000);
  // Frames keep coming from the host meanwhile (so the socket isn't given up on).
  await request.post(`${host.url}/api/press/bg/ticker`, { headers: { authorization: `Bearer ${host.pressToken}` } });
  const before = runs();
  // The way to the host turns very slow: the press gets there 3.5 s after it was made.
  proxy.upLatency = 3500;
  await new Fingers(page, hasTouch).tap('tap');
  await expectVisual(page, 'tap', 'unknown', 4000);
  await expect(btn(page, 'tap')).toContainText('NO RESPONSE');
  await expect(btn(page, 'tap')).toContainText('NOT SENT', { timeout: 6000 });
  await expect(btn(page, 'tap')).toContainText('too late');
  proxy.upLatency = 0;
  await page.waitForTimeout(800);
  expect(runs()).toBe(before);
  await expect(btn(page, 'tap')).toHaveAttribute('data-visual', 'failure');
  expect(host.log()).toContain('dropped a stale press');
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
});

test('two devices press at once: one run; the device that lost says ALREADY RUNNING and never buzzes success', async ({ page, browser }) => {
  const other = await browser.newPage();
  const vibA = await recordVibrations(page);
  const vibB = await recordVibrations(other);
  await open(page);
  await open(other);
  await expectVisual(page, 'tap', 'ready', 8000);
  await expectVisual(other, 'tap', 'ready', 8000);
  const before = runs();
  await Promise.all([page.keyboard.press('t'), other.keyboard.press('t')]);
  await expectVisual(page, 'tap', 'success', 5000);
  await expectVisual(other, 'tap', 'success', 5000);
  await page.waitForTimeout(500);
  expect(runs()).toBe(before + 1);
  const a = (await vibA()).filter((v) => v === VIB.success).length;
  const b = (await vibB()).filter((v) => v === VIB.success).length;
  expect([a, b].sort()).toEqual([0, 1]);
  // The device whose press lost marks the run as another device's; the winner doesn't.
  const [winner, loser] = a === 1 ? [page, other] : [other, page];
  await expect(loser.getByTestId('other-tap')).toBeVisible();
  await expect(winner.getByTestId('other-tap')).toHaveCount(0);
  await other.close();
});

test('@state lines latch device state on the button, on every device and across reloads; `@state` alone clears it', async ({ page, browser, hasTouch }) => {
  await open(page);
  const f = new Fingers(page, hasTouch);
  await f.tap('rec');
  await expect(page.getByTestId('latched-rec')).toHaveText('REC ●');
  const other = await browser.newPage();
  await open(other);
  await expect(other.getByTestId('latched-rec')).toHaveText('REC ●');
  await expectVisual(page, 'rec', 'ready', 4000);
  await f.tap('rec');
  await expect(page.getByTestId('latched-rec')).toHaveCount(0);
  await expect(other.getByTestId('latched-rec')).toHaveCount(0);
  await other.close();
});

test('a host that turns devices away (too many connected) says so, and lets this one in when there is room', async ({ page }) => {
  // Fill this address's share of connections (16) with other "devices".
  for (let i = 0; i < 16; i++) sockets.push(new WebSocket(`ws://127.0.0.1:${host.port}/ws?token=${host.pressToken}`));
  await Promise.all(sockets.map((s) => new Promise((r) => (s.onmessage = r))));
  await page.goto(`${host.url}/?pad=main#token=${host.pressToken}`);
  await expect(page.getByTestId('host-full')).toContainText('Host is full (too many devices connected)', { timeout: 10_000 });
  sockets.pop()!.close();
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
});

test('offline, a touch tries to reconnect at once (not at the next retry, seconds away)', async ({ page, hasTouch }) => {
  await open(page);
  await host.stop();
  await expect(conn(page)).toHaveAttribute('data-status', 'offline');
  // Failed attempts space the retries out (0.25, 0.5, 1, 2, 4 s).
  await page.waitForTimeout(6000);
  await host.start();
  const t0 = Date.now();
  await new Fingers(page, hasTouch).tap('quick');
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 5000 });
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('a hello slower than 5 s (a big config, a slow link) still gets through: the wait grows with each try', async ({ page }) => {
  test.setTimeout(60_000);
  proxy = await startProxy(host.port);
  // WebSocket chunks take 3 s each way: the upgrade's answer and the hello arrive ~6 s after the
  // socket opens (the page itself loads fast). A fixed 5 s wait for the hello never connected.
  proxy.wsLatency = 3000;
  await page.goto(`${proxy.url}/?pad=main#token=${host.pressToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 40_000 });
});

test('a hello that arrives seconds after its socket opened (a big config): the clock offset is right, presses run', async ({ page }) => {
  proxy = await startProxy(host.port);
  // The upgrade's answer comes at once; the hello behind it 3.5 s later. The host stamped its
  // serverNow before that: an offset taken when the hello arrived was 3.5 s off, and every press
  // went out "made 3.5 s ago" (dropped as too old, and the socket renewed, again and again).
  proxy.helloDelayMs = 3500;
  const frames = await recordPressFrames(page);
  await open(page, proxy);
  await expectVisual(page, 'tap', 'ready', 8000);
  const before = runs();
  await page.keyboard.press('t');
  await expectVisual(page, 'tap', 'success', 5000);
  expect(runs()).toBe(before + 1);
  const [sent] = await frames();
  expect(Math.abs(sent!.at! - sent!.sentAt)).toBeLessThan(1000);
});

/** A config whose hello, as a press device gets it (labels; no actions), is about 5 KB a pad. */
function bigConfig(pads: number): ConfigInput {
  return {
    version: 1,
    pads: Array.from({ length: pads }, (_, p) => ({
      id: `pad${p}`,
      name: `Pad ${p}`,
      cols: 3,
      rows: 4,
      buttons: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, label: `Pad ${p} button ${i} `.repeat(12).trim().slice(0, 200), x: i % 3, y: Math.floor(i / 3), trigger: 'tap' as const, action: sh('echo ok') })),
    })),
  };
}

test('a big hello over a slow link (about 40 KB at 150 kbps, 600 ms): the clock offset is still right, presses run', async ({ page, hasTouch }) => {
  test.setTimeout(90_000);
  const big = await startHost(bigConfig(8));
  try {
    const frames = await recordPressFrames(page);
    await page.goto(`${big.url}/?pad=pad0#token=${big.pressToken}`);
    await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
    // The link turns slow, and the socket is opened again over it: its hello takes seconds now.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 600, downloadThroughput: (150 * 1024) / 8, uploadThroughput: (150 * 1024) / 8 });
    const first = await page.evaluateHandle(() => (window.__buttpad!.backend as unknown as { ws: WebSocket | null }).ws);
    await page.evaluate(() => (window.__buttpad!.backend as unknown as { ws: WebSocket }).ws.close());
    await expect
      .poll(
        () =>
          page.evaluate((w) => {
            const b = window.__buttpad!.backend as unknown as { ws: WebSocket | null; snapshot: { get(): { status: string } } };
            return b.ws !== w && b.snapshot.get().status === 'online';
          }, first),
        { timeout: 40_000 },
      )
      .toBe(true);
    // Host and browser share a clock here: the offset learned from that hello is about 0, not its delay.
    expect(Math.abs(await page.evaluate(() => window.__buttpad!.backend.snapshot.get().clockSkew))).toBeLessThan(1500);
    await new Fingers(page, hasTouch).tap('b0');
    await expectVisual(page, 'b0', 'success', 8000);
    const sent = (await frames()).at(-1)!;
    expect(Math.abs(sent.at! - sent.sentAt)).toBeLessThan(1500);
  } finally {
    await big.dispose();
  }
});

test('a running button a config change removes leaves no state behind (no ghost RUNNING for later saves to "stop")', async ({ page, request }) => {
  // A host of its own: this changes its config.
  const h = await startHost({
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'slow', label: 'Slow', x: 0, y: 0, trigger: 'tap', action: sh('sleep 30') },
          { id: 'quick', label: 'Quick', x: 1, y: 0, trigger: 'tap', action: sh('echo quick') },
        ],
      },
    ],
  });
  try {
    await page.goto(`${h.url}/?pad=p#token=${h.pressToken}`);
    await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
    const headers = { authorization: `Bearer ${h.adminToken}` };
    await request.post(`${h.url}/api/press/p/slow`, { headers });
    await expectVisual(page, 'slow', 'running');
    const got = (await (await request.get(`${h.url}/api/config`, { headers })).json()) as { config: { pads: { buttons: { id: string }[] }[] }; rev: string };
    const without = structuredClone(got.config);
    without.pads[0]!.buttons = without.pads[0]!.buttons.filter((b) => b.id !== 'slow');
    expect((await request.put(`${h.url}/api/config`, { headers, data: { config: without, baseRev: got.rev } })).ok()).toBe(true);
    await expect(btn(page, 'slow')).toHaveCount(0);
    // Its run is stopped meanwhile; the host says no more about a button that's gone.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__buttpad!.backend.snapshot.get().states['p/slow'] ?? null)).toBeNull();
  } finally {
    await h.dispose();
  }
});

test('a tap made right before the page stalled says when it was made: the host drops it (too late) rather than run it 4 s late', async ({ page, hasTouch }) => {
  const frames = await recordPressFrames(page);
  await open(page);
  await expectVisual(page, 'quick', 'ready', 8000);
  const socket = await page.evaluateHandle(() => (window.__buttpad!.backend as unknown as { ws: WebSocket | null }).ws);
  // Busy from 20 ms after the touch for 4 s; the finger lifted at 80 ms (stamped events).
  await page.evaluate(() =>
    document.querySelector('[data-testid="btn-quick"]')!.addEventListener(
      'pointerdown',
      () =>
        setTimeout(() => {
          const end = performance.now() + 4000;
          while (performance.now() < end);
        }, 20),
      { once: true },
    ),
  );
  const f = new Fingers(page, hasTouch);
  const t0 = Date.now();
  await f.downAt('quick', t0);
  await page.waitForTimeout(150);
  await f.upAt(t0 + 80);
  await expect(btn(page, 'quick')).toContainText('NOT SENT', { timeout: 8000 });
  await expect(btn(page, 'quick')).toContainText('too late');
  const [sent] = await frames();
  expect(Math.abs(sent!.at! - (t0 + 80))).toBeLessThan(400);
  expect(sent!.sentAt - t0).toBeGreaterThan(3500);
  expect(host.log()).toMatch(/dropped a stale press of main\/quick/);
  // The offset was fine (the press was old already when it went out): the socket is kept.
  expect(await page.evaluate((ws) => ws === (window.__buttpad!.backend as unknown as { ws: WebSocket | null }).ws, socket)).toBe(true);
});

test('a queued re-run that All off drops is no longer this device’s: a later run by someone else is marked, and its failure not kept here', async ({ page, request }) => {
  const vib = await recordVibrations(page);
  await open(page, null, 'work');
  rmSync(hostFile('render.fail'), { force: true });
  // Someone else's render runs; this device queues a re-run behind it.
  expect(await pressElsewhere(request, 'work', 'render')).toBe('started');
  await expectVisual(page, 'render', 'running');
  await page.keyboard.press('r');
  await expect(btn(page, 'render')).toContainText('QUEUED');
  // Another device's All off: the run is stopped and its re-run dropped.
  expect(await pressElsewhere(request, 'work', 'off')).toBe('started');
  await expectVisual(page, 'render', 'stopped');
  await expectVisual(page, 'render', 'ready', 4000);
  // Later, a third device runs it, and it fails.
  writeFileSync(hostFile('render.fail'), '');
  const failures = (await vib()).filter((v) => v === VIB.failure).length;
  expect(await pressElsewhere(request, 'work', 'render')).toBe('started');
  await expectVisual(page, 'render', 'running');
  await expect(page.getByTestId('other-render')).toBeVisible();
  await expectVisual(page, 'render', 'failure', 4000);
  // Past its resultHoldMs: READY here too (it isn't this device's failure to keep).
  await expectVisual(page, 'render', 'ready', 4000);
  expect((await vib()).filter((v) => v === VIB.failure).length).toBe(failures);
  rmSync(hostFile('render.fail'), { force: true });
});

test('a host that comes back without its state file (run ids start over): whose run it is, is told afresh', async ({ page, request }) => {
  const vib = await recordVibrations(page);
  rmSync(hostFile('upload.fail'), { force: true });
  await open(page, null, 'work');
  // This device runs it twice (run ids 1 and 2, or more).
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('u');
    await expectVisual(page, 'upload', 'success', 4000);
    await expectVisual(page, 'upload', 'ready', 4000);
  }
  await host.stop();
  rmSync(hostFile('buttpad.state.json'), { force: true });
  await host.start();
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
  // Someone else's run 1: theirs.
  expect(await pressElsewhere(request, 'work', 'upload')).toBe('started');
  await expectVisual(page, 'upload', 'running');
  await expect(page.getByTestId('other-upload')).toBeVisible();
  await expectVisual(page, 'upload', 'ready', 4000);
  // This device's own run 2 fails: buzzed, and kept until touched.
  writeFileSync(hostFile('upload.fail'), '');
  const failures = (await vib()).filter((v) => v === VIB.failure).length;
  await page.keyboard.press('u');
  await expectVisual(page, 'upload', 'running');
  await expect(page.getByTestId('other-upload')).toHaveCount(0);
  await expectVisual(page, 'upload', 'failure', 4000);
  await page.waitForTimeout(1200);
  await expectVisual(page, 'upload', 'failure');
  await expect(btn(page, 'upload')).toHaveAttribute('data-sticky', '');
  expect((await vib()).filter((v) => v === VIB.failure).length).toBe(failures + 1);
  rmSync(hostFile('upload.fail'), { force: true });
});

test('storage blocked (private mode): the pairing works for this tab, with a warning that it won’t be remembered', async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, k, {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
  });
  await open(page);
  await expect(page.getByTestId('storage-warning')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('pairing')).toBeVisible();
});
