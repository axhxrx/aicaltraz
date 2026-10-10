/**
 * Protocol v2 against a real host (one per spec file and project): presses carry `at` and
 * `confirm`; a press held up in a dead link is dropped, never run late; two devices pressing at
 * once (only the winner hears success); `@state` latched device state; "host is full"; a touch
 * while offline reconnects at once; a slow hello still connects; blocked storage.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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

async function open(page: Page, via: Proxy | null = null) {
  await page.goto(`${via?.url ?? host.url}/?pad=main#token=${host.pressToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
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
