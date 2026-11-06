/**
 * Run mode, round 4 (demo backend, `?demo&exact`): per-button maxLatenessMs on the client, show
 * mode for dark rooms (measured: how bright READY and results get), FAILURE's hatching (grayscale,
 * show mode), READY's last-result text, narrow buttons keeping their trigger/confirm glyphs, and
 * leaving the editor for the pad it had open.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, contrastOf, demo, expectVisual, Fingers, pixels, recordVibrations, seedDemo, VIB } from './helpers.ts';

const sh = (script: string) => ({ type: 'shell' as const, script });

let f: Fingers;

async function open(page: Page, config: ConfigInput, query = '?demo&exact') {
  await seedDemo(page, config);
  await page.goto(`/${query}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
}

test.beforeEach(async ({ page, hasTouch }) => {
  f = new Fingers(page, hasTouch);
});

// ---- 1. maxLatenessMs ---------------------------------------------------------------------------

const LATE: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 2,
      rows: 2,
      buttons: [
        { id: 'patient', label: 'Patient', x: 0, y: 0, trigger: 'tap', maxLatenessMs: 8000, resultHoldMs: 5000, action: sh('sleep 0.2; echo ran') },
        { id: 'strict', label: 'Strict', x: 1, y: 0, trigger: 'tap', resultHoldMs: 5000, action: sh('sleep 0.2; echo ran') },
        { id: 'three', label: 'Three', x: 0, y: 1, trigger: 'tap', action: sh('echo three') },
        { id: 'six', label: 'Six', x: 1, y: 1, trigger: 'tap', maxLatenessMs: 6000, action: sh('echo six') },
      ],
    },
  ],
};

test("a press held up 3.3 s still runs on a button that allows 8 s (maxLatenessMs); the same delay is NOT SENT on a default (3 s) one", async ({ page }) => {
  await open(page, LATE);
  const runId = (id: string) => page.evaluate((id) => window.__buttpad!.backend.snapshot.get().states[`main/${id}`]?.runId ?? 0, id);
  await demo(page, (b) => b.delayNextPress(3300));
  await f.tap('patient');
  // No answer in 2 s: NO RESPONSE; then the host's answer: it started (3.3 s is within its 8 s).
  await expect(btn(page, 'patient')).toContainText('NO RESPONSE', { timeout: 4000 });
  await expectVisual(page, 'patient', 'success', 6000);
  await expect(btn(page, 'patient')).toContainText('ran');
  expect(await runId('patient')).toBe(1);

  await demo(page, (b) => b.delayNextPress(3300));
  await f.tap('strict');
  await expect(btn(page, 'strict')).toContainText('NOT SENT', { timeout: 6000 });
  await expect(btn(page, 'strict')).toContainText('too late');
  expect(await runId('strict')).toBe(0);
});

test("NO RESPONSE settles as DIDN'T RUN only once the button's maxLatenessMs has passed (3 s by default, 6 s here)", async ({ page }) => {
  await open(page, LATE);
  await demo(page, (b) => b.dropAcks(2));
  const t0 = Date.now();
  await f.tap('three');
  await f.tap('six');
  await expect(btn(page, 'three')).toContainText('NO RESPONSE', { timeout: 4000 });
  await expect(btn(page, 'six')).toContainText('NO RESPONSE', { timeout: 4000 });
  // Reconnected: a fresh hello, with no run of either press on the host.
  await demo(page, (b) => b.setOnline(false));
  await demo(page, (b) => b.setOnline(true));
  await expect(btn(page, 'three')).toContainText("DIDN'T RUN", { timeout: 4000 });
  expect(Date.now() - t0).toBeGreaterThan(3900);
  // The host could still run a press of `six` (it takes them up to 6 s late): not settled yet.
  await page.waitForTimeout(Math.max(0, 5600 - (Date.now() - t0)));
  await expect(btn(page, 'six')).toContainText('NO RESPONSE');
  await expect(btn(page, 'six')).toContainText("DIDN'T RUN", { timeout: 3500 });
  expect(Date.now() - t0).toBeGreaterThan(6900);
});

// ---- 2. show mode, 5. FAILURE's hatching ----------------------------------------------------------

const SHOW: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'show',
      name: 'Show',
      cols: 2,
      rows: 2,
      buttons: [
        { id: 'go', label: 'Cue 12 GO', color: '#2f6fde', x: 0, y: 0, trigger: 'tap', resultHoldMs: 60_000, action: sh('echo cue 12 done') },
        { id: 'house', label: 'House lights', color: '#facc15', x: 1, y: 0, trigger: 'tap', resultHoldMs: 60_000, action: sh('echo house up') },
        { id: 'fog', label: 'Fog', color: '#c1121f', x: 0, y: 1, trigger: 'tap', resultHoldMs: 60_000, action: sh("echo 'fluid empty' >&2; exit 2") },
        { id: 'estop', label: 'EMERGENCY STOP', color: '#c1121f', x: 1, y: 1, trigger: 'tap', confirm: true, action: { type: 'none' } },
      ],
    },
  ],
};

async function setShow(page: Page, on: boolean) {
  await page.getByTestId('menu-btn').click();
  const t = page.getByTestId('toggle-show');
  if ((await t.getAttribute('aria-checked')) !== String(on)) await t.click();
  await expect(t).toHaveAttribute('aria-checked', String(on));
  await page.getByTestId('menu-close').click();
  await expect(page.getByTestId('menu')).toHaveCount(0);
}

/** Before the app loads: records the opacity each `.bp-flash` animation starts at (the fire flash). */
async function recordFlashes(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __flashes: number[] };
    w.__flashes = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (k, o) {
      if (this.classList.contains('bp-flash') && Array.isArray(k)) w.__flashes.push(Number((k[0] as Keyframe).opacity));
      return animate.call(this, k, o);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __flashes: number[] }).__flashes.slice());
}

/** A screenshot kept with the test's output (and attached to its report). */
async function attach(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('show mode: dim faces, results as an edge + glyph + text (no flood), a faint fire flash; measured on screen against normal mode', async ({ page }, info) => {
  const flashes = await recordFlashes(page);
  await open(page, SHOW);
  const lum = async (id: string) => (await pixels(page, btn(page, id))).mean;
  const ready = { go: await lum('go'), house: await lum('house'), estop: await lum('estop') };
  await attach(page, info, 'normal-ready');

  await setShow(page, true);
  await expect(btn(page, 'go')).toHaveAttribute('data-show', '');
  const dim = { go: await lum('go'), house: await lum('house'), estop: await lum('estop') };
  await attach(page, info, 'show-ready');
  // READY dimmed: a yellow face (0.6 relative luminance) as dark as a navy one.
  expect(dim.go).toBeLessThan(ready.go * 0.6);
  expect(dim.house).toBeLessThan(ready.house * 0.3);
  expect(dim.estop).toBeLessThan(ready.estop * 0.8);
  for (const v of Object.values(dim)) expect(v).toBeLessThan(0.15);
  // …and still legible: the label's ink against the face is at least 7:1.
  for (const id of ['go', 'house', 'estop']) {
    const c = await btn(page, id).evaluate((el) => [getComputedStyle(el.querySelector('.bp-label')!).color, getComputedStyle(el.querySelector('.bp-base')!).backgroundColor]);
    expect(contrastOf(c[0]!, c[1]!), id).toBeGreaterThanOrEqual(7);
  }

  // A cue fires: the flash is faint; the result is an edge, a glyph and text, on a dark face.
  await f.tap('go');
  await page.evaluate(() => Promise.all([window.__buttpad!.backend.press('show', 'house'), window.__buttpad!.backend.press('show', 'fog')]));
  await expectVisual(page, 'go', 'success');
  await expectVisual(page, 'house', 'success');
  await expectVisual(page, 'fog', 'failure');
  expect(await flashes()).toEqual([0.14]);
  for (const id of ['go', 'fog']) {
    const look = await btn(page, id).evaluate((el) => ({
      flood: getComputedStyle(el.querySelector('.bp-flood')!).display,
      edge: parseFloat(getComputedStyle(el.querySelector('.bp-frame')!).borderTopWidth),
      glyph: getComputedStyle(el.querySelector('.bp-icon')!).color,
      face: getComputedStyle(el.querySelector('.bp-base')!).backgroundColor,
    }));
    expect(look.flood).toBe('none');
    expect(look.edge).toBeGreaterThanOrEqual(4);
    expect(contrastOf(look.glyph, look.face)).toBeGreaterThan(3);
  }
  await expect(btn(page, 'go')).toContainText('cue 12 done');
  const res = { go: await lum('go'), house: await lum('house'), fog: await lum('fog') };
  await attach(page, info, 'show-results');
  // No flood brightening the tile as the house goes dark: a result is about as bright as READY was.
  expect(res.go).toBeLessThan(dim.go * 1.6);
  expect(res.house).toBeLessThan(dim.house * 1.6);
  for (const v of Object.values(res)) expect(v).toBeLessThan(0.15);

  // The same results in normal mode: a full-tile flood, several times brighter.
  await setShow(page, false);
  const flood = { go: await lum('go'), house: await lum('house'), fog: await lum('fog') };
  await attach(page, info, 'normal-results');
  expect(flood.go).toBeGreaterThan(ready.go * 1.5);
  expect(res.go).toBeLessThan(flood.go * 0.3);
  expect(res.fog).toBeLessThan(flood.fog * 0.4);
  // Kept with the output: mean relative luminance per tile (0 black … 1 white).
  const report = JSON.stringify({ normal: { ready, results: flood }, show: { ready: dim, results: res } }, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
  writeFileSync(info.outputPath('luminance.json'), report);
  info.annotations.push({ type: 'luminance', description: report });
});

test('FAILURE is hatched, a red READY button is not: told apart in grayscale, and in show mode', async ({ page }) => {
  await open(page, SHOW);
  await page.evaluate(() => window.__buttpad!.backend.press('show', 'fog'));
  await expectVisual(page, 'fog', 'failure');
  await expect(btn(page, 'fog').locator('.bp-hatch')).toHaveCount(1);
  await expect(btn(page, 'estop').locator('.bp-hatch')).toHaveCount(0);
  // Grayscale, and only the faces (no text, glyphs or chips: their edges would be "texture" too).
  await page.addStyleTag({ content: 'html { filter: grayscale(1) } .bp-content, .bp-top { visibility: hidden }' });
  for (const show of [false, true]) {
    if (show) await setShow(page, true);
    const fail = await pixels(page, btn(page, 'fog'), [0.2, 0.8, 0.3, 0.7]);
    const red = await pixels(page, btn(page, 'estop'), [0.2, 0.8, 0.3, 0.7]);
    // Hatching is a texture (luminance steps between neighboring pixels); the red READY face is smooth.
    expect(fail.texture, `show=${show}: hatched ${fail.texture}, smooth ${red.texture}`).toBeGreaterThan(Math.max(0.003, red.texture * 4));
  }
});

// ---- 6. READY's last-result text --------------------------------------------------------------------

test('READY says how the last run ended with its short result text where all of it fits ("✓ printing 37% · 3 s ago"), never cut', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 3,
        buttons: [
          { id: 'printer', label: 'Is the printer done?', x: 0, y: 0, w: 2, trigger: 'tap', resultHoldMs: 200, action: sh("echo 'printing 37%'") },
          { id: 'porch', label: 'Porch', x: 0, y: 1, trigger: 'tap', resultHoldMs: 200, action: sh("echo '@state ON'; echo 'Porch light is ON now'") },
          { id: 'fail', label: 'Backup', x: 1, y: 1, trigger: 'tap', resultHoldMs: 200, action: sh("echo 'disk full' >&2; exit 1") },
          { id: 'long', label: 'Sync', x: 0, y: 2, w: 2, trigger: 'tap', resultHoldMs: 200, action: sh("echo 'copied 1,234 files to /mnt/backup/2026-11-06 in 12 s'") },
        ],
      },
    ],
  });
  await page.evaluate(() => Promise.all(['printer', 'porch', 'fail', 'long'].map((id) => window.__buttpad!.backend.press('p', id))));
  for (const id of ['printer', 'porch', 'fail', 'long']) await expectVisual(page, id, 'ready', 4000);
  await expect(page.getByTestId('last-printer')).toContainText(/✓\s*printing 37% · \d+ s ago/);
  expect((await page.getByTestId('last-text-printer').boundingBox())!.width).toBeGreaterThan(20);
  // A failure's text too (another device's run: READY right away).
  await expect(page.getByTestId('last-fail')).toContainText('disk full');
  // Next to a latched chip on a half-width button it doesn't fit: left out whole, "s ago" stays.
  await expect(page.getByTestId('last-porch')).toContainText(/\d+ s ago|\d+s/);
  expect((await page.getByTestId('last-text-porch').boundingBox())?.width ?? 0).toBeLessThan(1);
  await expect(page.getByTestId('latched-porch')).toHaveText('ON');
  // A sentence isn't "short": not in the corner.
  await expect(page.getByTestId('last-text-long')).toHaveCount(0);
  await expect(page.getByTestId('last-long')).toContainText(/✓\s*\d+ s ago/);
  // Nothing spills out of its button, nothing is cut with an ellipsis.
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.bp-top')].flatMap((top) => {
      const b = top.closest('.bp-btn')!.getBoundingClientRect();
      return [...top.querySelectorAll<HTMLElement>('.bp-mark, .bp-latched, .bp-chip-text')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < b.left - 1 || r.right > b.right + 1 || el.scrollWidth > el.clientWidth + 1);
      }).map((el) => `${top.closest('.bp-btn')!.getAttribute('data-testid')} ${el.className}`);
    }),
  );
  expect(bad).toEqual([]);
});

// ---- 10. narrow buttons ---------------------------------------------------------------------------

test('narrow buttons (a 4-column pad on a phone, ~90 px) keep the trigger and the confirm lock as glyphs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 4,
        rows: 3,
        buttons: [
          { id: 'fade', label: 'Fade in 10s', x: 0, y: 0, holdMs: 1500, key: 'f', action: sh('echo') },
          { id: 'estop', label: 'E STOP', color: '#c1121f', x: 1, y: 0, trigger: 'tap', confirm: true, action: sh('echo') },
          { id: 'strobe', label: 'Strobe', x: 2, y: 0, trigger: 'double', action: sh('echo') },
          { id: 'spot', label: 'Spot', x: 3, y: 0, trigger: 'tap', key: 'ArrowUp', action: sh('echo') },
        ],
      },
    ],
  });
  for (const id of ['fade', 'estop', 'strobe', 'spot']) {
    const b = btn(page, id);
    const box = (await b.boundingBox())!;
    expect(box.width).toBeLessThan(110);
    const chip = b.locator('.bp-trigger');
    await expect(chip).toBeVisible();
    await expect(chip.locator('svg').first()).toBeVisible();
    const c = (await chip.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width + 1);
    // The label sits above the chip, not under it.
    const label = (await b.locator('.bp-label').boundingBox())!;
    expect(label.y + label.height).toBeLessThanOrEqual(c.y + 2);
    // The key chip is what goes.
    await expect(b.locator('.bp-key')).toBeHidden();
  }
  // A confirm button's lock stays; a hold's duration too.
  await expect(btn(page, 'estop').locator('.bp-trigger svg')).toHaveCount(2);
  await expect(btn(page, 'estop').locator('.bp-trigger svg').nth(1)).toBeVisible();
  await expect(btn(page, 'fade').locator('.bp-trigger')).toContainText('1.5s');
});

// ---- 9. leaving the editor ------------------------------------------------------------------------

const PADS: ConfigInput = {
  version: 1,
  pads: [
    { id: 'main', name: 'Main', cols: 1, rows: 1, buttons: [{ id: 'go', label: 'Go', x: 0, y: 0, trigger: 'tap', action: sh('echo go') }] },
    { id: 'backup', name: 'Backup', cols: 1, rows: 1, buttons: [{ id: 'spare', label: 'Spare', x: 0, y: 0, trigger: 'tap', action: sh('echo spare') }] },
    { id: 'crew', name: 'Crew', cols: 1, rows: 1, buttons: [{ id: 'call', label: 'Call', x: 0, y: 0, trigger: 'tap', action: sh('echo call') }] },
  ],
};

async function editAnotherPadAndLeave(page: Page, other: string) {
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
  await page.getByTestId(`edit-tab-${other}`).click();
  await expect(page.getByTestId(`edit-tab-${other}`)).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('edit-close').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
}

test('leaving the editor lands on the pad it had open (a ?pad= link’s page too); with that pad never saved, on the one on screen before', async ({ page }) => {
  await open(page, PADS, '?demo&exact&pad=backup');
  await expect(btn(page, 'spare')).toBeVisible();
  await editAnotherPadAndLeave(page, 'main');
  await expect(btn(page, 'go')).toBeVisible();
  await expect(page.getByTestId('tab-main')).toHaveAttribute('aria-selected', 'true');

  // Picked from the tabs: the same.
  await page.getByTestId('tab-crew').click();
  await expect(btn(page, 'call')).toBeVisible();
  await editAnotherPadAndLeave(page, 'backup');
  await expect(btn(page, 'spare')).toBeVisible();
  await expect(page.getByTestId('tab-backup')).toHaveAttribute('aria-selected', 'true');

  // A pad added in the editor and thrown away: back on the pad on screen before (not "no longer exists").
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await page.getByTestId('edit-add-pad').click();
  await page.getByTestId('edit-close').click();
  await page.getByTestId('leave-discard').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(btn(page, 'spare')).toBeVisible();
  await expect(page.getByTestId('pad-missing')).toHaveCount(0);
});

// ---- the gallery has every state, show mode too ---------------------------------------------------

test('?gallery shows SYNCING and a red READY next to FAILURE; ?gallery&show renders it in show mode', async ({ page }) => {
  const vib = await recordVibrations(page);
  await page.goto('/?gallery');
  await expect(btn(page, 'syncing')).toHaveAttribute('data-visual', 'syncing');
  await expect(btn(page, 'syncing')).toContainText('SYNCING');
  await expect(btn(page, 'failure').locator('.bp-hatch')).toHaveCount(1);
  await expect(btn(page, 'estop').locator('.bp-hatch')).toHaveCount(0);
  await page.goto('/?gallery&show');
  await expect(btn(page, 'success')).toHaveAttribute('data-show', '');
  await expect(btn(page, 'success').locator('.bp-flood')).toBeHidden();
  expect((await vib()).filter((v) => v !== VIB.touch)).toEqual([]);
});

// ---- a latched state the host can't vouch for ---------------------------------------------------------

test('a latched state marked uncertain by the host ("? REC ●", after a crash) is a hollow, dashed chip; a sure one is solid', async ({ page }) => {
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'rec', label: 'REC', x: 0, y: 0, trigger: 'tap', action: sh('echo') },
          { id: 'bgm', label: 'BGM', x: 1, y: 0, trigger: 'tap', action: sh('echo') },
        ],
      },
    ],
  });
  // As a host's hello would bring them after a restart (src/server/persist.ts UNCERTAIN_PREFIX).
  await page.evaluate(() => window.__buttpad!.backend.snapshot.set((s) => ({ ...s, latched: { 'p/rec': '? REC ●', 'p/bgm': 'BGM ON' } })));
  const unsure = page.getByTestId('latched-rec');
  await expect(unsure).toHaveText('? REC ●');
  await expect(unsure).toHaveAttribute('data-uncertain', '');
  const look = (id: string) =>
    page.getByTestId(`latched-${id}`).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, outline: getComputedStyle(el).outlineStyle }));
  expect(await look('rec')).toEqual({ bg: 'rgba(0, 0, 0, 0)', outline: 'dashed' });
  const sure = await look('bgm');
  expect(sure.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(sure.outline).not.toBe('dashed');
  await expect(page.getByTestId('latched-bgm')).not.toHaveAttribute('data-uncertain', '');
});

// ---- banners take their own room ----------------------------------------------------------------------

test('a banner (unsaved edits kept on the device) sits below the pad, never over its bottom button (360×640)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 1,
        rows: 3,
        buttons: [
          { id: 'a', label: 'Garage door', x: 0, y: 0, action: sh('echo') },
          { id: 'b', label: 'Porch light', x: 0, y: 1, trigger: 'tap', action: sh('echo') },
          { id: 'c', label: 'Printer', x: 0, y: 2, trigger: 'tap', action: sh('echo') },
        ],
      },
    ],
  });
  // An edit left unsaved (the page reloaded): the run mode offers it back in a banner.
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await page.getByTestId('edit-btn-c').click();
  await page.getByTestId('field-label').fill('Printer (unsaved)');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('buttpad.draft:demo') ?? '')).toContain('Printer (unsaved)');
  await page.reload();
  const banner = page.getByTestId('draft-banner');
  await expect(banner).toBeVisible();
  const b = (await btn(page, 'c').boundingBox())!;
  const r = (await banner.boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(r.y + 1);
  expect(r.y + r.height).toBeLessThanOrEqual(640);
  // Its buttons still work, and hiding it gives the room back.
  await page.getByTestId('draft-banner-hide').click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await btn(page, 'c').boundingBox())!.height).toBeGreaterThan(b.height);
});
