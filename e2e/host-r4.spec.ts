/**
 * Round 4 against a real host: pairing by code (from the plain root URL, a `#pair` link, the
 * press role's "Unlock editing…", an admin's "Pair another device…"); a rejected new token never
 * replaces a working pairing; per-button maxLatenessMs; ack and link-check timeouts that follow
 * the link's measured round trips; and a page that didn't run for a while (a frozen tab, a long
 * stretch hidden) not replaying what happened meanwhile as live.
 *
 * The host's pairing endpoints are stood in for with page.route where the test is about the
 * client (POST /api/pair, POST /api/pair-code: core/protocol.ts); one test uses the host's own,
 * when it has them.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
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
      rows: 3,
      buttons: [
        { id: 'quick', label: 'Quick', x: 0, y: 0, trigger: 'tap', resultHoldMs: 600, action: sh('echo quick') },
        { id: 'slow', label: 'Slow', x: 1, y: 0, trigger: 'tap', resultHoldMs: 600, action: sh('sleep 1.5; echo slow done') },
        { id: 'patient', label: 'Patient', x: 0, y: 1, trigger: 'tap', maxLatenessMs: 8000, resultHoldMs: 3000, action: sh('echo ran >> patient.log; echo patient') },
        { id: 'strict', label: 'Strict', x: 1, y: 1, trigger: 'tap', resultHoldMs: 3000, action: sh('echo ran >> strict.log; echo strict') },
        // Keeps frames coming from the host (progress every 100 ms): a socket with traffic isn't probed.
        { id: 'ticker', label: 'Ticker', x: 0, y: 2, trigger: 'tap', action: sh('i=0; while [ $i -lt 200 ]; do echo "@progress $((i / 2))"; i=$((i + 1)); sleep 0.1; done') },
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
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('buttpad.token'));
const hostFile = (name: string) => path.join(path.dirname(host.configPath), name);
const lines = (name: string) => (existsSync(hostFile(name)) ? readFileSync(hostFile(name), 'utf8').trim().split('\n').filter(Boolean).length : 0);

async function open(page: Page, token = host.pressToken, via: Proxy | null = null) {
  await page.goto(`${via?.url ?? host.url}/?pad=main#token=${token}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
}

/** Another device presses (the HTTP API): no ack for this page. */
async function pressElsewhere(request: APIRequestContext, button: string) {
  const r = await request.post(`${host.url}/api/press/main/${button}`, { headers: { authorization: `Bearer ${host.pressToken}` } });
  return ((await r.json()) as { result?: string }).result;
}

/** Stands in for the host's POST /api/pair: `codes` maps a code to the role it pairs as. */
async function fakePair(page: Page, codes: Record<string, 'press' | 'admin'>, status?: { status: number; headers?: Record<string, string> }) {
  const tried: string[] = [];
  await page.route('**/api/pair', async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    tried.push(code);
    if (status) return route.fulfill({ status: status.status, headers: status.headers, json: { error: 'too many tries' } });
    const role = codes[code];
    if (!role) return route.fulfill({ status: 401, json: { error: 'bad or expired code' } });
    return route.fulfill({ json: { token: role === 'admin' ? host.adminToken : host.pressToken, role } });
  });
  return tried;
}

// ---- 3. pairing by code ----------------------------------------------------------------------------

test('not paired, from the plain root URL: a big "Pair with a code"; a wrong code says so and changes nothing; the right one pairs', async ({ page }) => {
  const tried = await fakePair(page, { '246810': 'admin' });
  await page.goto(`${host.url}/`);
  await expect(page.getByTestId('pairing')).toBeVisible();
  const cta = page.getByTestId('pair-with-code');
  expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await cta.click();
  await expect(page.getByTestId('pair-code')).toBeVisible();
  const input = page.getByTestId('code-input');
  await expect(input).toHaveAttribute('inputmode', 'numeric');
  await expect(input).toBeFocused();
  expect(parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(40);
  await input.fill('111111');
  await page.getByTestId('code-submit').click();
  await expect(page.getByTestId('code-error')).toContainText('didn’t work');
  expect(await stored(page)).toBeNull();
  // Typed with a space, as it is read out.
  await input.fill('246 810');
  await input.press('Enter');
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(host.adminToken);
  expect(tried).toEqual(['111111', '246810']);
  await expect(page.getByTestId('paired-note')).toContainText('admin');
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu-edit')).toBeVisible();
});

test('a #pair link opens the code entry (a code in the link is tried at once); too many tries says how long to wait', async ({ page }) => {
  await fakePair(page, { '135790': 'press' });
  await page.goto(`${host.url}/#pair`);
  await expect(page.getByTestId('pair-code')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByTestId('code-cancel').click();
  await expect(page.getByTestId('pairing')).toBeVisible();
  await page.goto(`${host.url}/?x=1#pair=135790`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(host.pressToken);

  const limited = await page.context().newPage();
  await fakePair(limited, {}, { status: 429, headers: { 'retry-after': '30' } });
  await limited.goto(`${host.url}/#pair`);
  await limited.getByTestId('code-input').fill('999999');
  await limited.getByTestId('code-submit').click();
  // A countdown from the host's Retry-After; Pair waits meanwhile.
  await expect(limited.getByTestId('code-error')).toContainText(/Too many tries\. Wait (30|29|28) s/);
  await expect(limited.getByTestId('code-submit')).toBeDisabled();
  await expect(limited.getByTestId('code-submit')).toContainText(/Wait 2\d s/, { timeout: 4000 });
  await limited.close();
});

test('press role: the menu says how to become an admin device, and "Unlock editing…" takes a code', async ({ page }) => {
  await fakePair(page, { '424242': 'admin' });
  await open(page);
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu-edit')).toHaveCount(0);
  const unlock = page.getByTestId('menu-unlock');
  await expect(unlock).toContainText('Unlock editing');
  await expect(unlock).toContainText('pairing code');
  await expect(unlock).toContainText('admin link');
  await unlock.click();
  await expect(page.getByTestId('pair-code')).toBeVisible();
  await expect(page.getByTestId('pair-code')).toContainText('Unlock with a pairing code');
  // Cancel goes back to the pad, still paired as before.
  await page.getByTestId('code-cancel').click();
  await expect(page.getByTestId('pair-code')).toHaveCount(0);
  await expectVisual(page, 'quick', 'ready');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-unlock').click();
  await page.getByTestId('code-input').fill('424242');
  await page.getByTestId('code-submit').click();
  await expect(page.getByTestId('pair-code')).toHaveCount(0);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(host.adminToken);
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu-edit')).toBeVisible();
  await expect(page.getByTestId('menu-unlock')).toHaveCount(0);
});

test('admin: "Pair another device…" shows a one-time code, big, with when it runs out', async ({ page }) => {
  await page.route('**/api/pair-code', (route) =>
    route.request().headers().authorization === `Bearer ${host.adminToken}`
      ? route.fulfill({ json: { code: '73915026', expiresAt: Date.now() + 5 * 60_000, role: 'admin' } })
      : route.fulfill({ status: 401, json: { error: 'admin only' } }),
  );
  await open(page, host.adminToken);
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-pair-device').click();
  await expect(page.getByTestId('pair-device-code')).toHaveText('7391 5026');
  await expect(page.getByTestId('pair-device-left')).toContainText(/Expires in [45]:\d\d/);
  await expect(page.getByTestId('pair-device-panel')).toContainText('/#pair');
});

test("the host's own pairing codes: a code an admin makes pairs another device", async ({ page, request }) => {
  const r = await request.post(`${host.url}/api/pair-code`, { headers: { authorization: `Bearer ${host.adminToken}` }, data: {} });
  test.skip(r.status() === 404 || r.status() === 405, 'this host has no pairing codes yet');
  expect(r.ok()).toBe(true);
  const made = (await r.json()) as { code: string; role: 'press' | 'admin' };
  await page.goto(`${host.url}/`);
  await page.getByTestId('pair-with-code').click();
  await page.getByTestId('code-input').fill(String(made.code));
  await page.getByTestId('code-submit').click();
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(made.role === 'admin' ? host.adminToken : host.pressToken);
  // Used once: the same code again is refused.
  const again = await request.post(`${host.url}/api/pair`, { data: { code: String(made.code) } });
  expect(again.status()).toBe(401);
});

// ---- 4. a rejected new token never replaces a working pairing -----------------------------------

const TYPO = 'Zz9_this-is-not-the-token-you-are-looking-for';

test('a typo’d pairing link opened in the tab: the working pairing stays (and the pad says so); presses still work', async ({ page, hasTouch }) => {
  await open(page);
  await page.evaluate((t) => (location.hash = `#token=${t}`), TYPO);
  await expect(page.getByTestId('pair-kept')).toContainText('rejected — still paired as before');
  expect(await stored(page)).toBe(host.pressToken);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success');
});

test('the same on a fresh load with a typo’d link: checked first, the old token kept; a pasted rejected token is refused in place', async ({ page }) => {
  await open(page);
  await page.goto(`${host.url}/?pad=main&again=1#token=${TYPO}`);
  await expect(page.getByTestId('pair-kept')).toBeVisible();
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(host.pressToken);
  await expect(page.getByTestId('rejected')).toHaveCount(0);

  // Not paired: pasting a token the host rejects says so on the spot.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${host.url}/`);
  await page.getByTestId('token-input').fill(`${host.url}/#token=${TYPO}`);
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('token-error')).toContainText('rejected');
  await expect(page.getByTestId('pairing')).toBeVisible();
  expect(await stored(page)).toBeNull();
});

test('a new token that could not be checked first (no answer) and turns out rejected: back to the old one, with a note', async ({ page }) => {
  await open(page);
  // The check of the new link gets no answer (a flaky link): it's taken, the old one kept aside.
  let first = true;
  await page.route('**/api/state', (route) => {
    if (first && route.request().headers().authorization === `Bearer ${TYPO}`) {
      first = false;
      return route.abort('timedout');
    }
    return route.continue();
  });
  await page.evaluate((t) => (location.hash = `#token=${t}`), TYPO);
  await expect(page.getByTestId('pair-kept')).toBeVisible({ timeout: 10_000 });
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(await stored(page)).toBe(host.pressToken);
  expect(await page.evaluate(() => localStorage.getItem('buttpad.token.fallback'))).toBeNull();
  await expect(page.getByTestId('rejected')).toHaveCount(0);
});

// ---- 1. per-button maxLatenessMs, against the host ----------------------------------------------------

test('per-button maxLatenessMs: held up 3.5 s on the way, a press of an 8 s button runs; of a default (3 s) one, it is dropped (NOT SENT)', async ({ page, hasTouch, request }) => {
  rmSync(hostFile('patient.log'), { force: true });
  rmSync(hostFile('strict.log'), { force: true });
  proxy = await startProxy(host.port);
  await open(page, host.pressToken, proxy);
  await expectVisual(page, 'patient', 'ready', 8000);
  expect(await pressElsewhere(request, 'ticker')).toBe('started');
  proxy.upLatency = 3500;
  const f = new Fingers(page, hasTouch);
  await f.tap('patient');
  await expectVisual(page, 'patient', 'success', 10_000);
  expect(lines('patient.log')).toBe(1);
  await f.tap('strict');
  await expect(btn(page, 'strict')).toContainText('NOT SENT', { timeout: 10_000 });
  await expect(btn(page, 'strict')).toContainText('too late');
  proxy.upLatency = 0;
  await page.waitForTimeout(500);
  expect(lines('strict.log')).toBe(0);
});

// ---- 7. timeouts that follow the link's round trips ----------------------------------------------

/** Records, from now on, every look of button `id` and of the connection badge (the page's own clock). */
async function recordLooks(page: Page, id: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __looks: { t: number; v: string }[] };
    w.__looks = [];
    const note = (v: string) => w.__looks.at(-1)?.v !== v && w.__looks.push({ t: Date.now(), v });
    const scan = () => {
      const b = document.querySelector(`[data-testid="btn-${id}"]`);
      const c = document.querySelector('[data-testid="conn"]');
      const v = b?.getAttribute('data-visual');
      // A running face with its clock: a stale one shows minutes.
      const clock = v === 'running' ? `:${b?.querySelector('.bp-num')?.textContent ?? ''}` : '';
      note(`${v}${clock}${b?.querySelector(`[data-testid="other-${id}"]`) ? '+other' : ''}|${c?.getAttribute('data-status')}${c?.hasAttribute('data-syncing') ? '+syncing' : ''}`);
    };
    scan();
    new MutationObserver(scan).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ['data-visual', 'data-status', 'data-syncing', 'data-testid'] });
  }, id);
  return async (since = 0) => (await page.evaluate(() => (window as unknown as { __looks: { t: number; v: string }[] }).__looks)).filter((x) => x.t >= since).map((x) => x.v);
}

test('on a slow link a press waits longer for its answer (4 × the p90 round trip, ≤ 6 s): no false NO RESPONSE or OFFLINE; a dead link still says NO RESPONSE', async ({ page, hasTouch }) => {
  test.setTimeout(60_000);
  proxy = await startProxy(host.port);
  // WebSocket chunks take 650 ms each way: round trips of ~1.3 s (the page itself loads fast).
  proxy.wsLatency = 650;
  await open(page, host.pressToken, proxy);
  const f = new Fingers(page, hasTouch);
  const timing = () =>
    page.evaluate(() => {
      const b = window.__buttpad!.backend as unknown as { ackTimeoutMs(): number; roundTrips: readonly number[] };
      return { ack: b.ackTimeoutMs(), rtts: [...b.roundTrips] };
    });
  expect((await timing()).ack).toBe(2000);
  // A few presses (and the link checks around them) measure the link.
  for (let i = 0; i < 3; i++) {
    await f.tap('quick');
    await expectVisual(page, 'quick', 'success', 8000);
    await expectVisual(page, 'quick', 'ready', 5000);
  }
  const t = await timing();
  expect(t.rtts.length).toBeGreaterThanOrEqual(3);
  expect(t.ack).toBeGreaterThan(4000);
  expect(t.ack).toBeLessThanOrEqual(6000);
  // A spike: this press's answer takes ~2.9 s (a fixed 2 s said NO RESPONSE, and a 1.5 s link check OFFLINE).
  const looks = await recordLooks(page, 'quick');
  proxy.upLatency = 1600;
  await f.tap('quick');
  await expectVisual(page, 'quick', 'success', 10_000);
  const seen = await looks();
  expect(seen.filter((v) => v.startsWith('unknown'))).toEqual([]);
  expect(seen.filter((v) => v.includes('|offline'))).toEqual([]);
  proxy.upLatency = 0;
  await expectVisual(page, 'quick', 'ready', 5000);
  // Honest all the same: on a dead link, NO RESPONSE within the 6 s cap, never a success.
  proxy.freezeAll();
  proxy.setMode('blackhole');
  const t0 = Date.now();
  await f.tap('quick');
  await expect(btn(page, 'quick')).toContainText('NO RESPONSE', { timeout: 9000 });
  expect(Date.now() - t0).toBeLessThan(7500);
  expect((await looks(t0)).filter((v) => v.startsWith('success'))).toEqual([]);
});

// ---- 8. a page that didn't run for a while -----------------------------------------------------------

test("a frozen tab doesn't replay what happened meanwhile as live: SYNCING (no OTHER DEVICE flash, no buzz), then the host's word as it is now", async ({ page, hasTouch, request }) => {
  test.setTimeout(60_000);
  const vib = await recordVibrations(page);
  await open(page);
  await expectVisual(page, 'slow', 'ready', 8000);
  // This device's own run, which will end while the tab is frozen.
  await new Fingers(page, hasTouch).tap('slow');
  await expectVisual(page, 'slow', 'running');
  const looksSlow = await recordLooks(page, 'slow');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  // Meanwhile: the run ends (success, then READY), and another device runs `quick`. The socket stays
  // up; what the host says piles up for a page that doesn't run.
  await page.waitForTimeout(300);
  expect(await pressElsewhere(request, 'quick')).toBe('started');
  await page.waitForTimeout(9500);
  const tResume = Date.now();
  await cdp.send('Debugger.resume');
  await cdp.send('Debugger.disable');
  await expectVisual(page, 'slow', 'ready', 5000);
  await expectVisual(page, 'quick', 'ready', 5000);
  await expect(conn(page)).not.toHaveAttribute('data-syncing', '');
  const after = await looksSlow(tResume);
  expect(after).toContain('syncing|online+syncing');
  // Not one frame of the minutes-old picture as live: no running clock, no outcome replayed.
  expect(after.filter((v) => /^(running|success|failure|unknown)/.test(v))).toEqual([]);
  // `quick`: another device's run, replayed from the backlog: never shown, never marked as live.
  await expect(page.getByTestId('other-quick')).toHaveCount(0);
  // The outcome of this device's run is settled quietly: no success buzz minutes later.
  expect((await vib()).filter((v) => v === VIB.success)).toEqual([]);
  await expect(page.getByTestId('last-slow')).toContainText('✓');
  // And it is live again: a press goes through.
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success');
});

test('back after a long stretch in the background: SYNCING until the host has answered, presses wait (WAIT · SYNCING), then live', async ({ page, hasTouch }) => {
  await page.addInitScript(() => {
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
    (window as unknown as { __setVis(v: DocumentVisibilityState): void }).__setVis = (v) => {
      vis = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  // A slow link, so that catching up takes a moment to see.
  proxy = await startProxy(host.port);
  proxy.wsLatency = 400;
  await open(page, host.pressToken, proxy);
  await expectVisual(page, 'quick', 'ready', 8000);
  const looks = await recordLooks(page, 'quick');
  await page.evaluate(() => (window as unknown as { __setVis(v: string): void }).__setVis('hidden'));
  await page.waitForTimeout(5500);
  const t0 = Date.now();
  await page.evaluate(() => (window as unknown as { __setVis(v: string): void }).__setVis('visible'));
  await expect(conn(page)).toHaveAttribute('data-syncing', '');
  await expect(conn(page)).toContainText('SYNCING');
  // A press now would act on a picture that may be minutes old: it waits.
  await new Fingers(page, hasTouch).tap('quick');
  await expect(btn(page, 'quick')).toHaveAttribute('data-flash', 'syncing');
  await expect(conn(page)).not.toHaveAttribute('data-syncing', '', { timeout: 5000 });
  expect(await looks(t0)).toContain('syncing|online+syncing');
  await expectVisual(page, 'quick', 'ready');
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success', 8000);
});

// ---- served from another address (a reverse proxy, a preview pane) --------------------------------

test('behind a proxy the host was not told about (the page has another origin): the page says exactly what to start the host with; with --allow-origin it connects and pairs', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const h = await startHost({ version: 1, pads: [{ id: 'main', name: 'Main', cols: 1, rows: 1, buttons: [{ id: 'quick', label: 'Quick', x: 0, y: 0, trigger: 'tap', action: sh('echo quick') }] }] });
  const px = await startProxy(h.port);
  // Like many reverse proxies: requests reach the host with its own address as Host.
  px.rewriteHost = `127.0.0.1:${h.port}`;
  try {
    await page.goto(`${px.url}/?pad=main#token=${h.pressToken}`);
    await expect(page.getByTestId('origin-refused').first()).toContainText(`--allow-origin ${px.url}`, { timeout: 15_000 });
    // Pairing by code from there says the same, not "wrong code".
    const other = await browser.newPage();
    await other.goto(`${px.url}/#pair`);
    await other.getByTestId('code-input').fill('123456');
    await other.getByTestId('code-submit').click();
    await expect(other.getByTestId('code-error')).toContainText(`--allow-origin ${px.url}`);
    await other.close();
    // The host is told about the proxy's address: the page connects by itself.
    await h.stop();
    process.env.BUTTPAD_ALLOW_ORIGINS = px.url;
    try {
      await h.start();
    } finally {
      delete process.env.BUTTPAD_ALLOW_ORIGINS;
    }
    await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
    await expect(page.getByTestId('origin-refused')).toHaveCount(0);
    await new Fingers(page, false).tap('quick');
    await expectVisual(page, 'quick', 'success');
  } finally {
    await px.close();
    await h.dispose();
  }
});
