/**
 * Run mode's look, round 2 (demo backend): failure/running typography, progress motion, label ink
 * and color fallbacks, forced colors, the top bar on a 360 px phone, chips, grid gaps, offline
 * clocks and device clock jumps, iOS haptic ticks, very long labels, the demo badge.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, demo, expectVisual, Fingers, seedDemo } from './helpers.ts';

const sh = (script: string) => ({ type: 'shell' as const, script });

async function open(page: Page, config: ConfigInput, query = '?demo&exact') {
  await seedDemo(page, config);
  await page.goto(`/${query}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
}

const phoneOnly = (name: string) => test.skip(name !== 'phone', 'one phone viewport is enough');

test("a failure's reason is its headline and the exit code small print; RUNNING keeps its label big (never ~10 px on a phone)", async ({ page }, info) => {
  phoneOnly(info.project.name);
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 3,
        rows: 4,
        buttons: [
          { id: 'card', label: 'Card backup', x: 0, y: 0, trigger: 'tap', resultHoldMs: 60_000, action: sh("echo 'card full: 0 bytes free' >&2; exit 3") },
          { id: 'render', label: 'Render preview proxies', x: 1, y: 0, trigger: 'tap', action: sh("echo '@status encoding frame 75/600'; sleep 30") },
          { id: 'fog', label: 'Fog', x: 2, y: 0, trigger: 'tap', timeoutMs: 200, resultHoldMs: 60_000, action: sh('sleep 30') },
        ],
      },
    ],
  });
  await page.evaluate(() => Promise.all(['card', 'render', 'fog'].map((id) => window.__buttpad!.backend.press('p', id))));
  await expectVisual(page, 'card', 'failure');
  await expectVisual(page, 'fog', 'failure');
  const sizes = await btn(page, 'card').evaluate((el) => {
    const px = (sel: string) => {
      const e = el.querySelector<HTMLElement>(sel)!;
      return { font: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height, text: e.textContent };
    };
    return { head: px('.bp-headline'), detail: px('.bp-detail'), label: px('.bp-label') };
  });
  expect(sizes.head.text).toBe('card full: 0 bytes free');
  expect(sizes.detail.text).toBe('EXIT 3');
  expect(sizes.head.font).toBeGreaterThan(sizes.detail.font * 1.4);
  // At most two lines.
  expect(sizes.head.h / (sizes.head.font * 1.04)).toBeLessThan(2.3);
  // No reason text: the reason (TIMEOUT) is the headline itself.
  await expect(btn(page, 'fog').locator('.bp-headline')).toHaveText('TIMEOUT');
  // Running: the label stays the big text; the clock comes second.
  await expectVisual(page, 'render', 'running');
  const run = await btn(page, 'render').evaluate((el) => ({
    label: parseFloat(getComputedStyle(el.querySelector('.bp-label')!).fontSize),
    num: parseFloat(getComputedStyle(el.querySelector('.bp-num')!).fontSize),
  }));
  // (A 120×150 px button: its floor is 9% of its height, 13 px; it used to come out at ~10 px.)
  expect(run.label).toBeGreaterThanOrEqual(13);
  expect(run.label).toBeGreaterThanOrEqual(run.num * 0.9);
});

test('determinate progress keeps a slow motion cue under the fill (2% still looks busy)', async ({ page }) => {
  await open(page, { version: 1, pads: [{ id: 'p', name: 'P', cols: 1, rows: 1, buttons: [{ id: 'up', label: 'Upload', x: 0, y: 0, trigger: 'tap', action: sh("echo '@progress 2'; sleep 30") }] }] });
  await page.evaluate(() => window.__buttpad!.backend.press('p', 'up'));
  await expect(btn(page, 'up').locator('.bp-prog')).toHaveCount(1);
  const moving = await btn(page, 'up')
    .locator('.bp-stripes.is-under')
    .evaluate((el) => el.getAnimations().some((a) => a.playState === 'running' && (a as CSSAnimation).animationName === 'bp-stripes'));
  expect(moving).toBe(true);
});

test('label ink by WCAG contrast; colors that can’t paint a button fall back to the default', async ({ page }) => {
  const colors = ['#f97316', 'transparent', 'currentColor', 'var(--nope)', 'rgb(255 0 0 / 0.3)', '#2f6fde'];
  await open(page, {
    version: 1,
    pads: [{ id: 'p', name: 'P', cols: 3, rows: 2, buttons: colors.map((color, i) => ({ id: `c${i}`, label: `C${i}`, color, x: i % 3, y: Math.floor(i / 3), action: sh('echo') })) }],
  });
  const look = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.bp-btn')].map((b) => ({
      bg: getComputedStyle(b.querySelector('.bp-base')!).backgroundColor,
      ink: getComputedStyle(b.querySelector('.bp-label')!).color,
    })),
  );
  // White on orange is 2.9:1; black is 7.2:1.
  expect(look[0]!.ink).toBe('rgb(11, 12, 14)');
  // The see-through or context-only colors are painted as the default blue, with its white ink.
  for (const i of [1, 2, 3, 4]) expect(look[i]).toEqual(look[5]);
  expect(look[5]).toEqual({ bg: 'rgb(47, 111, 222)', ink: 'rgb(255, 255, 255)' });
});

test('forced colors: buttons keep visible edges, the hold fill, the LIVE dot, and the state in words', async ({ page, hasTouch }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'hold', label: 'Hold', x: 0, y: 0, holdMs: 2000, action: sh('echo') },
          { id: 'run', label: 'Run', x: 1, y: 0, trigger: 'tap', action: sh('sleep 30') },
        ],
      },
    ],
  });
  const edge = await btn(page, 'hold').locator('.bp-face').evaluate((el) => ({ w: parseFloat(getComputedStyle(el).borderTopWidth), s: getComputedStyle(el).borderTopStyle }));
  expect(edge.w).toBeGreaterThanOrEqual(2);
  expect(edge.s).not.toBe('none');
  const dot = await page.locator('.bp-dot').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(dot).not.toBe('none');
  const f = new Fingers(page, hasTouch);
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  const fill = await btn(page, 'hold').locator('.bp-arm').evaluate((el) => getComputedStyle(el, '::after').backgroundColor);
  expect(fill).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await f.up();
  await page.evaluate(() => window.__buttpad!.backend.press('p', 'run'));
  await expect(btn(page, 'run').locator('.bp-fc')).toHaveText('RUNNING');
  await expect(btn(page, 'run').locator('.bp-fc')).toBeVisible();
});

test('top bar at 360 px: OFFLINE never hides the tabs, the active tab is scrolled into view, other pads show a dot', async ({ page }, info) => {
  phoneOnly(info.project.name);
  await page.setViewportSize({ width: 360, height: 740 });
  const names = ['Lighting rig', 'Camera A', 'Camera B', 'Sound desk', 'Effects', 'Stage left'];
  await open(
    page,
    {
      version: 1,
      pads: names.map((name, i) => ({ id: `p${i}`, name, cols: 1, rows: 1, buttons: [{ id: `b${i}`, label: name, x: 0, y: 0, trigger: 'tap' as const, action: sh('sleep 30') }] })),
    },
    '?demo&exact&pad=p5',
  );
  const inView = async (id: string) =>
    page.evaluate((id) => {
      const tab = document.querySelector(`[data-testid="tab-${id}"]`)!.getBoundingClientRect();
      const strip = document.querySelector('.bp-tabs')!.getBoundingClientRect();
      return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
    }, id);
  expect(await inView('p5')).toBe(true);
  await demo(page, (b) => b.setOnline(false));
  await expect(page.getByTestId('conn')).toContainText('OFFLINE');
  expect(await page.locator('.bp-tabs').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(150);
  expect(await inView('p5')).toBe(true);
  await demo(page, (b) => b.setOnline(true));
  // Something runs on another pad: its tab says so.
  await page.evaluate(() => window.__buttpad!.backend.press('p1', 'b1'));
  await expect(page.getByTestId('tab-p1')).toHaveAttribute('data-mark', 'running');
  await expect(page.getByTestId('tab-p1').locator('.bp-tab-dot')).toBeVisible();
});

test('chips: pretty key names, the hold duration, and they stay inside narrow buttons; a double says TAP AGAIN after one tap', async ({ page, hasTouch }) => {
  const keys = ['AudioVolumeUp', ' ', 'ArrowUp', 'PageDown'];
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 4,
        rows: 2,
        buttons: [
          ...keys.map((key, i) => ({ id: `k${i}`, label: `K${i}`, x: i, y: 0, key, holdMs: 1500, action: sh('echo') })),
          { id: 'dbl', label: 'Double', x: 0, y: 1, w: 2, trigger: 'double' as const, action: sh('echo') },
        ],
      },
    ],
  });
  await expect(btn(page, 'k0').locator('.bp-key')).toHaveText('VOL+');
  await expect(btn(page, 'k1').locator('.bp-key')).toHaveText('SPACE');
  await expect(btn(page, 'k2').locator('.bp-key')).toHaveText('↑');
  await expect(btn(page, 'k3').locator('.bp-key')).toHaveText('PG↓');
  await expect(btn(page, 'k0').locator('.bp-trigger')).toContainText('1.5s');
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.bp-chip')].filter((c) => {
      const r = c.getBoundingClientRect();
      const b = c.closest('.bp-btn')!.getBoundingClientRect();
      return getComputedStyle(c.parentElement!).display !== 'none' && (r.left < b.left || r.right > b.right || c.scrollWidth > c.clientWidth + 1);
    }).length,
  );
  expect(clipped).toBe(0);
  await new Fingers(page, hasTouch).tap('dbl');
  await expect(btn(page, 'dbl')).toContainText('TAP AGAIN');
});

test('a touch in the gap between two buttons presses the nearer one', async ({ page, hasTouch }) => {
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'a', label: 'A', x: 0, y: 0, trigger: 'tap', action: sh('sleep 0.3; echo a') },
          { id: 'b', label: 'B', x: 1, y: 0, trigger: 'tap', action: sh('sleep 0.3; echo b') },
        ],
      },
    ],
  });
  const a = (await btn(page, 'a').boundingBox())!;
  const b = (await btn(page, 'b').boundingBox())!;
  expect(b.x - (a.x + a.width)).toBeGreaterThan(2);
  // Just right of A's edge, in the gap.
  await new Fingers(page, hasTouch).pressAt({ x: a.x + a.width + 1, y: a.y + a.height / 2 }, 90);
  await expectVisual(page, 'a', 'running');
  await expectVisual(page, 'b', 'ready');
});

test("offline: a run's clock stops at the last word from the host; setting the device's clock moves no counter or confirm window", async ({ page, hasTouch }) => {
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'slow', label: 'Slow', x: 0, y: 0, trigger: 'tap', action: sh('sleep 60') },
          { id: 'conf', label: 'Confirm', x: 1, y: 0, trigger: 'tap', confirm: true, confirmWindowMs: 1500, action: sh('echo') },
        ],
      },
    ],
  });
  const f = new Fingers(page, hasTouch);
  await f.tap('slow');
  await expectVisual(page, 'slow', 'running');
  await page.waitForTimeout(1200);
  await demo(page, (b) => b.setOnline(false));
  await expect(btn(page, 'slow')).toContainText('LAST SEEN RUNNING');
  const seen = await btn(page, 'slow').locator('.bp-offline-was').textContent();
  await page.waitForTimeout(1500);
  await expect(btn(page, 'slow').locator('.bp-offline-was')).toHaveText(seen!);
  await demo(page, (b) => b.setOnline(true));
  await expectVisual(page, 'slow', 'running');
  // The device's clock jumps 3 hours ahead (NTP, the user setting it): the run is still seconds old.
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 3 * 3600e3;
  });
  await page.waitForTimeout(300);
  await expect(btn(page, 'slow').locator('.bp-num')).toHaveText(/^\d+(\.\d)?s$/);
  // …and back an hour: a confirm window still closes when it should.
  await f.tap('conf');
  await expectVisual(page, 'conf', 'confirm');
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() - 3600e3;
  });
  await expectVisual(page, 'conf', 'ready', 3000);
});

test('iOS (no vibrate()): a press ticks once, a success twice, a failure three times', async ({ page }, info) => {
  phoneOnly(info.project.name);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true });
    const w = window as unknown as { __ticks: number[] };
    w.__ticks = [];
    const click = HTMLLabelElement.prototype.click;
    HTMLLabelElement.prototype.click = function () {
      if (this.querySelector('input[switch]')) w.__ticks.push(performance.now());
      return click.call(this);
    };
  });
  await open(page, {
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 2,
        rows: 1,
        buttons: [
          { id: 'ok', label: 'OK', x: 0, y: 0, trigger: 'tap', action: sh('sleep 0.5; echo ok') },
          { id: 'bad', label: 'Bad', x: 1, y: 0, trigger: 'tap', action: sh('sleep 0.5; exit 1') },
        ],
      },
    ],
  });
  const ticks = () => page.evaluate(() => (window as unknown as { __ticks: number[] }).__ticks.length);
  const f = new Fingers(page, true);
  await f.tap('ok');
  await expect.poll(ticks).toBe(1);
  await expectVisual(page, 'ok', 'success');
  await expect.poll(ticks).toBe(3);
  await f.tap('bad');
  await expect.poll(ticks).toBe(4);
  await expectVisual(page, 'bad', 'failure');
  await expect.poll(ticks).toBe(7);
});

test('a label thousands of words long (a host without the 200-character cap) does not freeze the page', async ({ page }) => {
  await open(page, { version: 1, pads: [{ id: 'p', name: 'P', cols: 1, rows: 1, buttons: [{ id: 'b', label: 'B', x: 0, y: 0, action: sh('echo') }] }] });
  const ms = await page.evaluate(() => {
    const b = window.__buttpad!.backend;
    const label = Array.from({ length: 1600 }, (_, i) => `word${i}`).join(' ');
    const t0 = performance.now();
    b.snapshot.set((s) => ({ ...s, config: { ...s.config!, pads: [{ ...s.config!.pads[0]!, buttons: [{ ...s.config!.pads[0]!.buttons[0]!, label }] }] } }));
    return new Promise<number>((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now() - t0))));
  });
  expect(ms).toBeLessThan(1000);
  await expect(btn(page, 'b')).toContainText('word0');
});

test('the demo shows a DEMO badge where a host would show LIVE', async ({ page }) => {
  await open(page, { version: 1, pads: [{ id: 'p', name: 'P', cols: 1, rows: 1, buttons: [{ id: 'b', label: 'B', x: 0, y: 0, action: sh('echo') }] }] });
  await expect(page.getByTestId('conn')).toHaveText('DEMO');
  await expect(page.getByTestId('conn').locator('.bp-dot')).toBeHidden();
  await demo(page, (b) => b.setOnline(false));
  await expect(page.getByTestId('conn')).toHaveText('OFFLINE');
});
