/**
 * The web client's final pass (an owner pairing an iPhone through an HTTPS preview proxy, QA): the
 * pairing-code box (exactly 6 digits, a failed code replaced by what's typed next), a code typed
 * into the pairing-link box, the address-refused advice (the exact option, whole on its line, one
 * tap to copy it for the operator), the token never in a URL (one-time WebSocket tickets), show
 * mode's @state chip, a result's retry pill on small buttons, and leaving the editor on the pad it
 * had open.
 *
 * The pairing-box tests run on the web app served alone, with POST /api/pair stood in for
 * (page.route); the rest against a real host, through a TCP proxy (e2e/proxy.ts) where the page
 * must come from another origin. `*.localhost` names resolve to this machine and are secure
 * contexts (the Clipboard API works), so http://mason-preview.localhost:PORT is a proxy's address.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, contrastOf, expectVisual, Fingers, pixels, seedDemo } from './helpers.ts';
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
      rows: 1,
      buttons: [
        { id: 'quick', label: 'Quick', x: 0, y: 0, trigger: 'tap', resultHoldMs: 600, action: sh('echo quick') },
        { id: 'lamp', label: 'Key 80%', x: 1, y: 0, trigger: 'tap', action: sh("echo '@state ON 80%'; echo lamp") },
      ],
    },
    { id: 'test', name: 'Test', cols: 1, rows: 1, buttons: [{ id: 'probe', label: 'Probe', x: 0, y: 0, trigger: 'tap', action: sh('echo probe') }] },
  ],
};

let host: Host;
let proxies: Proxy[] = [];

test.beforeAll(async () => {
  host = await startHost(CONFIG);
});
test.afterAll(async () => {
  await host?.dispose();
});
test.afterEach(async () => {
  for (const p of proxies) await p.close();
  proxies = [];
});

const conn = (page: Page) => page.getByTestId('conn');

/** A TCP proxy in front of the host; `foreign`: it passes requests on with the host's own address as Host (like many reverse proxies), so the page's origin isn't the host's. */
async function proxy(foreign = false): Promise<Proxy> {
  const p = await startProxy(host.port);
  if (foreign) p.rewriteHost = `127.0.0.1:${host.port}`;
  proxies.push(p);
  return p;
}

/** Stands in for the host's POST /api/pair: `codes` maps a code to the role it pairs as; the codes sent are recorded. */
async function fakePair(page: Page, codes: Record<string, 'press' | 'admin'> = {}) {
  const tried: string[] = [];
  await page.route('**/api/pair', async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    tried.push(code);
    const role = codes[code];
    if (!role) return route.fulfill({ status: 401, json: { error: 'wrong or expired code' } });
    return route.fulfill({ json: { token: `Tok_${'x'.repeat(40)}`, role } });
  });
  return tried;
}

const selection = (l: Locator) => l.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);

/** A tap (touch projects) or a click at `fx` of the way across `l`: the caret lands there. */
async function tapAt(l: Locator, touch: boolean, fx: number) {
  const b = (await l.boundingBox())!;
  const position = { x: b.width * fx, y: b.height / 2 };
  if (touch) await l.tap({ position });
  else await l.click({ position });
}

// ---- 1. the pairing-code box ---------------------------------------------------------------------

test('the code box takes exactly 6 digits: never more, spaces and dashes ignored, and Pair waits for all 6 (and says why)', async ({ page }) => {
  const tried = await fakePair(page);
  await page.goto('/#pair');
  const input = page.getByTestId('code-input');
  const pair = page.getByTestId('code-submit');
  const hint = page.getByTestId('code-hint');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('pair-code')).toContainText('6 digits');
  await expect(pair).toBeDisabled();
  await page.keyboard.type('640-16');
  await expect(input).toHaveValue('640 16');
  await expect(pair).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(hint).toHaveText('A code has 6 digits (5 so far).');
  expect(tried).toEqual([]);
  await page.keyboard.type('9');
  await expect(input).toHaveValue('640 169');
  await expect(hint).toHaveCount(0);
  await expect(pair).toBeEnabled();
  // QA: "6401696161" was taken whole and shown cut off. A 7th digit is refused, and it says why.
  await page.keyboard.type('6161');
  await expect(input).toHaveValue('640 169');
  await expect(hint).toHaveText('A code has 6 digits.');
  // Typed into the middle of a full code: refused too (no digit is pushed out of sight).
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
  await page.keyboard.type('5');
  await expect(input).toHaveValue('640 169');
  // A backspace right after the space takes the digit before it.
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(4, 4));
  await page.keyboard.press('Backspace');
  await expect(input).toHaveValue('641 69');
  expect(await selection(input)).toEqual([2, 2]);
  await expect(pair).toBeDisabled();
  // Too long a paste is refused whole: never cut down to a wrong code.
  await input.evaluate((el: HTMLInputElement) => el.select());
  await page.keyboard.press('Backspace');
  await expect(input).toHaveValue('');
  await page.keyboard.insertText('640 169 616');
  await expect(input).toHaveValue('');
  await expect(hint).toHaveText('A code has 6 digits.');
  await page.keyboard.insertText('640.169');
  await expect(input).toHaveValue('640 169');
  await pair.click();
  await expect.poll(() => tried).toEqual(['640169']);
});

test('after a code fails it is selected, and the next one typed replaces it, even after a tap put the caret into it (QA: "640169616" showed as "640 1696")', async ({ page, hasTouch }) => {
  const tried = await fakePair(page, { '640169': 'press' });
  await page.goto('/#pair');
  const input = page.getByTestId('code-input');
  const error = page.getByTestId('code-error');
  await page.keyboard.type('765 616');
  await page.keyboard.press('Enter');
  await expect(error).toContainText('didn’t work');
  await expect(input).toBeFocused();
  await expect.poll(() => selection(input)).toEqual([0, 7]);
  // A tap into the old digits selects it all again…
  await tapAt(input, hasTouch, 0.45);
  await expect.poll(() => selection(input)).toEqual([0, 7]);
  // …and wherever the caret ends up (iOS can put it there all the same), what is typed next is the new code.
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(4, 4));
  await page.keyboard.type('111 111');
  await expect(input).toHaveValue('111 111');
  await expect(error).toHaveCount(0);
  await page.getByTestId('code-submit').click();
  await expect(error).toContainText('didn’t work');
  // A new code pasted (or autofilled) over it that starts with the same digits is taken whole.
  await expect.poll(() => selection(input)).toEqual([0, 7]);
  await page.keyboard.insertText('111 199');
  await expect(input).toHaveValue('111 199');
  await page.keyboard.press('Enter');
  await expect(error).toContainText('didn’t work');
  // Backspace on a failed code clears it all, not one digit.
  await expect.poll(() => selection(input)).toEqual([0, 7]);
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  await page.keyboard.press('Backspace');
  await expect(input).toHaveValue('');
  await page.keyboard.type('640169');
  await expect(input).toHaveValue('640 169');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pair-code')).toHaveCount(0);
  expect(tried).toEqual(['765616', '111111', '111199', '640169']);
});

// ---- 2. a code in the pairing-link box -------------------------------------------------------------

test('a pairing code typed into the pairing-link box goes to the code entry and is tried at once; other digits are told a code has 6', async ({ page }) => {
  const tried = await fakePair(page);
  await page.goto('/');
  const box = page.getByTestId('token-input');
  await box.fill('640 169');
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('pair-code')).toBeVisible();
  await expect.poll(() => tried).toEqual(['640169']);
  await expect(page.getByTestId('code-error')).toContainText('didn’t work');
  await expect(page.getByTestId('code-input')).toHaveValue('640 169');
  await page.getByTestId('code-cancel').click();
  for (const typo of ['64016', '640 1696']) {
    await box.fill(typo);
    await page.getByTestId('token-submit').click();
    await expect(page.getByTestId('token-error')).toHaveText('That looks like a pairing code, but a code has 6 digits.');
  }
  await box.fill('hello');
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('token-error')).toHaveText("That doesn't look like a pairing link or token.");
  expect(tried).toEqual(['640169']);
  await expect(page.getByTestId('pairing')).toBeVisible();
});

// ---- 3. a page the host turns away ------------------------------------------------------------------

/** How many lines each unit kept whole (an origin, the option) takes: 1 each when none is split. */
const unitLines = (l: Locator) =>
  l.locator('.bp-unit').evaluateAll((els) =>
    els.map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    }),
  );

test('a page the host turns away (pairing): the exact option, whole on its line, copied for the operator with one tap; a restart prints a NEW code', async ({ page, context }) => {
  const px = await proxy(true);
  const origin = `http://mason-preview.localhost:${px.port}`;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(`${origin}/#pair`);
  await page.keyboard.type('123456');
  await page.keyboard.press('Enter');
  const advice = page.getByTestId('code-error');
  await expect(advice.getByTestId('origin-cmd')).toHaveText(`--allow-origin ${origin}`);
  await expect(advice.getByTestId('origin-new-code')).toHaveText('Restarting ButtPad prints a NEW pairing code — ask for it.');
  // QA: "https://mason-" / "preview.test:44617" (split at its hyphen). The origin and the option stay whole.
  expect(await unitLines(advice)).toEqual([1, 1, 1]);
  await advice.getByTestId('copy-origin').click();
  await expect(advice.getByTestId('copy-origin')).toHaveText('Copied ✓');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`--allow-origin ${origin}`);
});

test('a paired page the host turns away: the banner has the same option and copy button (no new code needed), and copying works without the Clipboard API (plain HTTP)', async ({ page, context }) => {
  const px = await proxy(true);
  const origin = `http://mason-preview.localhost:${px.port}`;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  // As on a plain-HTTP page: no Clipboard API, the copy goes through a selected text area.
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await page.addInitScript((t) => localStorage.setItem('buttpad.token', t), host.pressToken);
  await page.goto(`${origin}/?pad=main`);
  const banner = page.getByTestId('origin-refused');
  await expect(banner.getByTestId('origin-cmd')).toHaveText(`--allow-origin ${origin}`, { timeout: 15_000 });
  await expect(banner.getByTestId('origin-new-code')).toHaveCount(0);
  expect(await unitLines(banner)).toEqual([1, 1, 1]);
  await banner.getByTestId('copy-origin').click();
  await expect(banner.getByTestId('copy-origin')).toHaveText('Copied ✓');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`--allow-origin ${origin}`);
});

// ---- 4. the token never in a URL --------------------------------------------------------------------

test('the token never goes in a URL: every (re)connect trades it for a fresh one-time ticket; the refused-upgrade probe is a POST with the token in its header', async ({ page }) => {
  test.setTimeout(60_000);
  const px = await proxy();
  const token = host.adminToken;
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  const posts: { path: string; auth?: string }[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === '/api/ws-ticket' || path === '/api/ws-check') posts.push({ path: `${r.method()} ${path}`, auth: r.headers().authorization });
  });
  // As a QR code's link opens it (the fragment never leaves the browser).
  await page.goto(`${px.url}/?pad=main#token=${token}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  // A socket closed under it: a new one at once, on a ticket of its own.
  const t0 = Date.now();
  await page.evaluate(() => (window.__buttpad!.backend as unknown as { ws: WebSocket }).ws.close());
  await expect.poll(() => sockets.length).toBe(2);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  expect(Date.now() - t0).toBeLessThan(3000);
  // A socket that never gets its hello: the host is asked why (POST /api/ws-check), then it connects again.
  px.blackholeWs = true;
  px.killAll();
  await expect.poll(() => posts.filter((p) => p.path === 'POST /api/ws-check').length, { timeout: 15_000 }).toBeGreaterThan(0);
  px.blackholeWs = false;
  await page.evaluate(() => window.__buttpad!.backend.kick());
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
  // The host restarts: and again.
  await host.stop();
  await expect(conn(page)).not.toHaveAttribute('data-status', 'online');
  await host.start();
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
  await new Fingers(page, false).tap('quick');
  await expectVisual(page, 'quick', 'success');

  // What a proxy's access log has: no token, in any form.
  const lines = px.lines;
  expect(lines.some((l) => l.startsWith('GET /ws?ticket='))).toBe(true);
  for (const l of [...lines, ...sockets]) {
    expect(l).not.toContain(token);
    expect(l).not.toContain(encodeURIComponent(token));
    expect(l).not.toContain('token=');
  }
  // One ticket per socket, never reused; each asked for with the token in the header.
  const tickets = sockets.map((u) => new URL(u).searchParams.get('ticket'));
  expect(sockets.length).toBeGreaterThanOrEqual(4);
  expect(tickets.every((t) => !!t && t.length >= 32)).toBe(true);
  expect(new Set(tickets).size).toBe(tickets.length);
  const asked = posts.filter((p) => p.path === 'POST /api/ws-ticket');
  expect(asked.length).toBeGreaterThanOrEqual(sockets.length);
  for (const p of posts) expect(p.auth).toBe(`Bearer ${token}`);
});

// ---- 11. a slow link that is alive ---------------------------------------------------------------

/** Records how button `id` and the connection look, each change (`visual|status`). */
async function recordLooks(page: Page, id: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __looks: string[] };
    w.__looks = [];
    const scan = () => {
      const v = `${document.querySelector(`[data-testid="btn-${id}"]`)?.getAttribute('data-visual')}|${document.querySelector('[data-testid="conn"]')?.getAttribute('data-status')}`;
      if (w.__looks.at(-1) !== v) w.__looks.push(v);
    };
    scan();
    new MutationObserver(scan).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['data-visual', 'data-status'] });
  }, id);
  return () => page.evaluate(() => (window as unknown as { __looks: string[] }).__looks.slice());
}

test('a link 1.5 s each way, all of it (through a proxy): online at the first try, the clock offset right, a press answered without a false OFFLINE or NO RESPONSE', async ({ page, hasTouch }) => {
  test.setTimeout(90_000);
  const px = await proxy();
  px.latency = 1500;
  await page.goto(`${px.url}/?pad=main#token=${host.pressToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 30_000 });
  // Host and browser share a clock: the offset is about 0. A quarter of the socket's opening (no
  // connecting through a proxy on this machine) made it 0.75 s, and presses looked that much older.
  expect(Math.abs(await page.evaluate(() => window.__buttpad!.backend.snapshot.get().clockSkew))).toBeLessThan(400);
  // QA (2 s each way): a fresh socket's first press waited a fast link's 2.1 s for a frame, and the link was dropped (OFFLINE), press after press.
  const looks = await recordLooks(page, 'quick');
  await new Fingers(page, hasTouch).tap('quick');
  await expectVisual(page, 'quick', 'success', 15_000);
  expect((await looks()).filter((v) => v.startsWith('unknown') || v.includes('|offline') || v.includes('|connecting'))).toEqual([]);
});

// ---- 5. show mode's @state chip ---------------------------------------------------------------------

const CHIPS: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'p',
      name: 'P',
      cols: 2,
      rows: 2,
      buttons: [
        { id: 'key', label: 'Key', color: '#f5c518', x: 0, y: 0, trigger: 'tap', action: sh('echo') },
        { id: 'rec', label: 'REC', color: '#2f6fde', x: 1, y: 0, trigger: 'tap', action: sh('echo') },
        { id: 'fog', label: 'Fog', color: '#16a34a', x: 0, y: 1, trigger: 'tap', action: sh('echo') },
        { id: 'bgm', label: 'BGM', color: '#111111', x: 1, y: 1, trigger: 'tap', action: sh('echo') },
      ],
    },
  ],
};

test('show mode: the @state chip is dimmed with the face (QA: it was the brightest thing on a dark pad), still a solid chip, and legible', async ({ page }) => {
  await seedDemo(page, CHIPS);
  await page.goto('/?demo&exact');
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  await page.evaluate(() =>
    window.__buttpad!.backend.snapshot.set((s) => ({ ...s, latched: { 'p/key': 'ON 80%', 'p/rec': 'REC ●', 'p/fog': 'FOG 40%', 'p/bgm': '? BGM ●' } })),
  );
  const chip = (id: string) => page.getByTestId(`latched-${id}`);
  await expect(chip('key')).toHaveText('ON 80%');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('toggle-show').click();
  await page.getByTestId('menu-close').click();
  await expect(btn(page, 'key')).toHaveAttribute('data-show', '');
  for (const id of ['key', 'rec', 'fog']) {
    const look = await chip(id).evaluate((el) => {
      const s = getComputedStyle(el);
      return { fg: s.color, bg: s.backgroundColor, face: getComputedStyle(el.closest('.bp-btn')!.querySelector('.bp-base')!).backgroundColor };
    });
    // A solid chip: a fill of its own, a step off the face…
    expect(look.bg, id).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.bg, id).not.toBe(look.face);
    // …with its text legible on it.
    expect(contrastOf(look.fg, look.bg), id).toBeGreaterThanOrEqual(4.5);
    // Measured on screen (mean relative luminance): ~0.11, darker than the label; a pill in the ink was 0.33 (0.35 in QA).
    const lum = (await pixels(page, chip(id))).mean;
    expect(lum, id).toBeLessThan(0.16);
  }
  // The one the host can't vouch for stays hollow and dashed.
  expect(await chip('bgm').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).outlineStyle])).toEqual(['rgba(0, 0, 0, 0)', 'dashed']);
});

// ---- 8. a result's pill on small buttons --------------------------------------------------------------

test('a result kept on screen: TAP TO RETRY has a row of its own on small buttons (3×6 on a phone), never over the small print', async ({ page, hasTouch }) => {
  const buttons = Array.from({ length: 18 }, (_, i) => ({
    id: `b${i}`,
    label: `Card backup ${i}`,
    x: i % 3,
    y: Math.floor(i / 3),
    trigger: 'tap' as const,
    resultHoldMs: 60_000,
    action: sh("echo 'card full: 0 bytes free'; exit 3"),
  }));
  await seedDemo(page, { version: 1, pads: [{ id: 'dense', name: 'Dense', cols: 3, rows: 6, buttons }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo&exact');
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  const f = new Fingers(page, hasTouch);
  for (const id of ['b0', 'b1']) {
    await f.tap(id);
    await expectVisual(page, id, 'failure');
  }
  for (const id of ['b0', 'b1']) {
    const b = btn(page, id);
    expect((await b.boundingBox())!.height).toBeLessThan(131);
    await expect(b.locator('.bp-sticky')).toHaveText('TAP TO RETRY');
    await expect(b.locator('.bp-detail')).toHaveText('EXIT 3');
    const [pill, detail, headline] = await Promise.all(['.bp-sticky', '.bp-detail', '.bp-headline'].map(async (s) => (await b.locator(s).boundingBox())!));
    // The pill sits below the small print, and the small print below the reason.
    expect(pill.y).toBeGreaterThanOrEqual(detail.y + detail.height - 0.5);
    expect(detail.y).toBeGreaterThanOrEqual(headline.y + headline.height - 0.5);
  }
});

// ---- the demo does what the host does ------------------------------------------------------------

const PARITY: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'lights',
      name: 'Lights',
      cols: 3,
      rows: 2,
      buttons: [
        { id: 'key', label: 'Key', x: 0, y: 0, trigger: 'tap', action: sh("echo '@state ON 80%'") },
        { id: 'fill', label: 'Fill', x: 1, y: 0, trigger: 'tap', action: sh("echo '@state ON 40%'") },
        { id: 'alloff', label: 'All off', x: 2, y: 0, trigger: 'tap', action: sh("echo '@state:lights/key OFF'; echo '@state:lights/fill'; echo '@state:lights/nope X'; echo off") },
        { id: 'wash', label: 'Wash', group: 'look', x: 0, y: 1, trigger: 'tap', action: sh('sleep 30') },
        { id: 'stop', label: 'Stop', stops: ['lights/wash'], x: 1, y: 1, trigger: 'tap', action: { type: 'none' } },
        { id: 'noop', label: 'Noop', x: 2, y: 1, trigger: 'tap', action: { type: 'none' } },
      ],
    },
    { id: 'more', name: 'More', cols: 1, rows: 1, buttons: [{ id: 'haze', label: 'Haze', group: 'look', x: 0, y: 0, trigger: 'tap', action: sh('sleep 30') }] },
  ],
};

test('the demo as the host: a Nothing button says "Stopped N", "Nothing was running" or "Done"; a group stops its mates on any pad; @state:<pad>/<button> sets (or clears) another button’s chip', async ({ page }) => {
  await seedDemo(page, PARITY);
  await page.goto('/?demo&exact&pad=lights');
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  const press = (pad: string, id: string) => page.evaluate(([pad, id]) => window.__buttpad!.backend.press(pad!, id!), [pad, id]);
  const state = (key: string) => page.evaluate((k) => window.__buttpad!.backend.snapshot.get().states[k], key);
  const latched = () => page.evaluate(() => window.__buttpad!.backend.snapshot.get().latched);
  // Nothing to stop: it says so (no "Done" read as if it switched something off); one that names nothing: "Done".
  await press('lights', 'stop');
  await expect.poll(async () => (await state('lights/stop'))?.text).toBe('Nothing was running');
  await press('lights', 'noop');
  await expect.poll(async () => (await state('lights/noop'))?.text).toBe('Done');
  // An exclusive group, across pads: Haze (More) stops Wash (Lights)…
  await press('lights', 'wash');
  await expect.poll(async () => (await state('lights/wash'))?.phase).toBe('running');
  await press('more', 'haze');
  await expectVisual(page, 'wash', 'stopped');
  expect(await state('lights/wash')).toMatchObject({ phase: 'failure', reason: 'cancelled', text: 'Stopped by Haze' });
  // …and Stop names Wash: running again, it is stopped, and counted.
  await expect.poll(async () => (await state('lights/wash'))?.phase, { timeout: 8000 }).toBe('ready');
  await press('lights', 'wash');
  await expect.poll(async () => (await state('lights/wash'))?.phase).toBe('running');
  await press('lights', 'stop');
  await expect.poll(async () => (await state('lights/stop'))?.text).toBe('Stopped 1');
  // @state:<pad>/<button>: All off sets Key's chip, clears Fill's, ignores a button that isn't there.
  await press('lights', 'key');
  await press('lights', 'fill');
  await expect.poll(latched).toEqual({ 'lights/key': 'ON 80%', 'lights/fill': 'ON 40%' });
  await press('lights', 'alloff');
  await expect.poll(latched).toEqual({ 'lights/key': 'OFF' });
  await expect(page.getByTestId('latched-key')).toHaveText('OFF');
  await expect(page.getByTestId('latched-fill')).toHaveCount(0);
});

// ---- 10. a fresh code's countdown ------------------------------------------------------------------

test('"Pair another device…": a fresh 10-minute code counts down from 10:00 / 9:59 in whole seconds left (QA: "Expires in 10:01")', async ({ page }) => {
  await page.route('**/api/pair-code', (route) => route.fulfill({ json: { code: '640169', expiresAt: Date.now() + 10 * 60_000, role: 'admin' } }));
  await page.goto(`${host.url}/?pad=main#token=${host.adminToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-pair-device').click();
  await expect(page.getByTestId('pair-device-code')).toHaveText('640 169');
  await expect(page.getByTestId('pair-device-left')).toHaveText(/^Expires in (10:00|9:5\d)$/);
});

// ---- 6. leaving the editor -----------------------------------------------------------------------

test('leaving the editor lands on the pad it had open: a pad built and saved there (QA: built "Stage", landed on "Test"), even when the socket brings it a moment after the save', async ({ page }) => {
  test.setTimeout(60_000);
  const px = await proxy();
  // WebSocket frames a little slow, HTTP not: the save's answer comes before the socket's news of it.
  px.wsLatency = 400;
  await page.goto(`${px.url}/?pad=test#token=${host.adminToken}`);
  await expect(conn(page)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
  await expect(btn(page, 'probe')).toBeVisible();
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
  await page.getByTestId('edit-add-pad').click();
  await page.getByTestId('pad-name').fill('Stage');
  await expect(page.getByTestId('edit-tab-stage')).toBeVisible();
  const missing: string[] = [];
  await page.exposeFunction('__missing', (t: string) => missing.push(t));
  await page.evaluate(() =>
    new MutationObserver(() => {
      const m = document.querySelector('[data-testid="pad-missing"]');
      if (m) (window as unknown as { __missing(t: string): void }).__missing(m.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true }),
  );
  // Close with the changes unsaved: "Save and close".
  await page.getByTestId('edit-close').click();
  await page.getByTestId('leave-save').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('tab-stage')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
  await expect(btn(page, 'probe')).toHaveCount(0);
  expect(missing).toEqual([]);
  // Put back as it was, for the tests after this one.
  const headers = { authorization: `Bearer ${host.adminToken}` };
  const got = (await (await page.request.get(`${host.url}/api/config`, { headers })).json()) as { rev: string };
  expect((await page.request.put(`${host.url}/api/config`, { headers, data: { config: CONFIG, baseRev: got.rev } })).ok()).toBe(true);
});
