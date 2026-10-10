/**
 * The link to a real host failing the way real links fail, through a TCP proxy (e2e/proxy.ts):
 * dead without a TCP close, dead while in the background, an old socket closing late, an ack lost
 * after the press ran, a host that drops every socket, a slow link, a WebSocket that hangs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, expectVisual, Fingers, recordVibrations, VIB } from './helpers.ts';
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
        { id: 'tap', label: 'Tap', x: 0, y: 0, trigger: 'tap', resultHoldMs: 4000, action: sh('echo ran >> ran.log; echo tapped') },
        { id: 'slow', label: 'Slow', color: '#0891b2', x: 1, y: 0, trigger: 'tap', action: sh("echo '@status busy'; sleep 30") },
        { id: 'quick', label: 'Quick', color: '#db2777', x: 0, y: 1, trigger: 'tap', resultHoldMs: 2000, action: sh('echo quick') },
      ],
    },
  ],
};

let host: Host;
let proxy: Proxy | null = null;

test.beforeAll(async () => {
  host = await startHost(CONFIG);
});
test.afterAll(async () => {
  await host?.dispose();
});
test.afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

const conn = (page: Page) => page.getByTestId('conn');
/** How many times the host ran "tap". */
const runs = () => {
  const log = path.join(path.dirname(host.configPath), 'ran.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
};

async function open(page: Page, via: Proxy | null = null) {
  await page.goto(`${via?.url ?? host.url}/?pad=main#token=${host.pressToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
}

/** Counts the WebSockets the page opens from now on. */
function countSockets(page: Page) {
  let n = 0;
  page.on('websocket', () => n++);
  return () => n;
}

test('a link that dies without a TCP close shows OFFLINE within seconds, and comes back by itself', async ({ page, hasTouch }) => {
  proxy = await startProxy(host.port);
  await open(page, proxy);
  // The link dies: nothing moves on it any more, and new connections go nowhere.
  proxy.freezeAll();
  proxy.setMode('blackhole');
  const t0 = Date.now();
  await expect(conn(page)).toHaveAttribute('data-status', 'offline', { timeout: 12_000 });
  // An idle probe within 5 s, answered within 3 s, or the socket is dropped.
  expect(Date.now() - t0).toBeLessThan(9_500);
  await expectVisual(page, 'tap', 'offline');
  proxy.setMode('pass');
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 12_000 });
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success');
});

test('back from the background with a dead socket: a quick check, a new socket, LIVE again in seconds', async ({ page, hasTouch }) => {
  await page.addInitScript(() => {
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
    (window as unknown as { __setVis(v: DocumentVisibilityState): void }).__setVis = (v) => {
      vis = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  proxy = await startProxy(host.port);
  await open(page, proxy);
  const sockets = countSockets(page);
  await page.evaluate(() => (window as unknown as { __setVis(v: string): void }).__setVis('hidden'));
  // While away, the connection died (no FIN or RST will ever arrive); the network itself is fine.
  proxy.freezeAll();
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __setVis(v: string): void }).__setVis('visible'));
  const t0 = Date.now();
  await expect.poll(sockets, { timeout: 6000 }).toBeGreaterThan(0);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(Date.now() - t0).toBeLessThan(4000);
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success');
});

test('an old socket that closes late (after a new one is up) changes nothing; network events are handled', async ({ page, hasTouch }) => {
  proxy = await startProxy(host.port);
  await open(page, proxy);
  proxy.freezeAll();
  proxy.setMode('blackhole');
  // The OS says the network went away: check now (1.5 s), not at the next idle probe.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(conn(page)).toHaveAttribute('data-status', 'offline', { timeout: 3500 });
  // …and it's back: connect now, not at the next retry.
  proxy.setMode('pass');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 3000 });
  // The old (frozen) connections finally die: their close events land now.
  proxy.killFrozen();
  await page.waitForTimeout(600);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success');
});

test('lost ack: the press ran, the link died before the ack; after reconnecting it shows the real outcome', async ({ page, hasTouch }) => {
  const vib = await recordVibrations(page);
  proxy = await startProxy(host.port);
  await open(page, proxy);
  await expectVisual(page, 'tap', 'ready', 8000);
  const before = runs();
  proxy.cutAfterNextUp();
  await new Fingers(page, hasTouch).tap('tap');
  await expect.poll(runs).toBe(before + 1);
  // Reconnected: SUCCESS from the host (resultHoldMs 4 s), not NO RESPONSE.
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 6000 });
  await expectVisual(page, 'tap', 'success');
  await expect(btn(page, 'tap')).not.toContainText('NO RESPONSE');
  await expect.poll(async () => (await vib()).filter((v) => v === VIB.success).length).toBe(1);
  expect((await vib()).filter((v) => v === VIB.failure)).toHaveLength(0);
  expect(runs()).toBe(before + 1);
});

test('a host that drops every socket right after hello is retried with a growing backoff, not hammered', async ({ page }) => {
  proxy = await startProxy(host.port);
  await open(page, proxy);
  const sockets = countSockets(page);
  // Every new connection dies 60 ms after it opens (its hello gets through).
  proxy.cutNewAfterMs = 60;
  proxy.killAll();
  await page.waitForTimeout(5000);
  // Backoff 0, 0.25, 0.5, 1, 2, 4 s (±20%): about 5 sockets in 5 s (it was over a hundred).
  expect(sockets()).toBeGreaterThanOrEqual(3);
  expect(sockets()).toBeLessThanOrEqual(7);
  proxy.cutNewAfterMs = 0;
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
});

test('slow link: a press right after a link check is sent at once and answered; the socket is kept', async ({ page, hasTouch }) => {
  proxy = await startProxy(host.port);
  proxy.latency = 420;
  await open(page, proxy);
  await expectVisual(page, 'tap', 'ready', 8000);
  const sockets = countSockets(page);
  const seen: string[] = [];
  await page.exposeFunction('__seen', (v: string) => seen.push(v));
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="btn-tap"]')!;
    new MutationObserver(() => (window as unknown as { __seen(v: string): void }).__seen(el.getAttribute('data-visual')!)).observe(el, { attributes: true, attributeFilter: ['data-visual'] });
  });
  const before = runs();
  // E.g. back from the background: the backend checks the link (it must not drop a live socket).
  await page.evaluate(() => window.__buttpad!.backend.kick());
  const t0 = Date.now();
  await new Fingers(page, hasTouch).tap('tap');
  await expect.poll(runs, { timeout: 3000 }).toBe(before + 1);
  expect(Date.now() - t0).toBeLessThan(1500);
  await expectVisual(page, 'tap', 'success', 4000);
  expect(seen).not.toContain('failure');
  expect(sockets()).toBe(0);
});

test('a press is sent at once or not at all: one that can no longer go out is NOT SENT and never runs', async ({ page }) => {
  await open(page);
  await expectVisual(page, 'tap', 'ready', 8000);
  const before = runs();
  const r = await page.evaluate(async () => {
    const b = window.__buttpad!.backend as unknown as { ws: WebSocket; press(p: string, id: string): Promise<string> };
    // The socket is closing under us; its close event isn't in yet.
    b.ws.close();
    try {
      return await b.press('main', 'tap');
    } catch (e) {
      return `${(e as Error).name} sent=${(e as { sent?: boolean }).sent}`;
    }
  });
  expect(r).toBe('PressError sent=false');
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 5000 });
  await page.waitForTimeout(500);
  expect(runs()).toBe(before);
});

test('startup with a WebSocket that hangs: the host’s states come over HTTP (a running action shows as RUNNING)', async ({ page, request }) => {
  const r = await request.post(`${host.url}/api/press/main/slow`, { headers: { authorization: `Bearer ${host.pressToken}` } });
  expect((await r.json()).result).toBe('started');
  proxy = await startProxy(host.port);
  proxy.blackholeWs = true;
  await page.goto(`${proxy.url}/?pad=main#token=${host.pressToken}`);
  // No cached layout and no hello: layout and states both from HTTP, long before the socket gives up.
  await expectVisual(page, 'slow', 'running', 3000);
  await expect(conn(page)).not.toHaveAttribute('data-status', 'online');
});
