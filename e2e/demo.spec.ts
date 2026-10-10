/** Run-mode flows against the in-browser demo backend (`?demo&exact`: no random timing/failures). */
import { expect, test, type Page } from '@playwright/test';
import { btn, expectVisual, FLOW_CONFIG, Fingers, seedDemo } from './helpers.ts';

let f: Fingers;

test.beforeEach(async ({ page, hasTouch }) => {
  await seedDemo(page, FLOW_CONFIG);
  await page.goto('/?demo&exact&pad=main');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  f = new Fingers(page, hasTouch);
});

/** Records every data-visual a button goes through. */
async function trackVisuals(page: Page, id: string) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="btn-${id}"]`)!;
    const seen: string[] = [el.getAttribute('data-visual')!];
    (window as unknown as Record<string, string[]>)[`seen_${id}`] = seen;
    new MutationObserver(() => {
      const v = el.getAttribute('data-visual')!;
      if (seen.at(-1) !== v) seen.push(v);
    }).observe(el, { attributes: true, attributeFilter: ['data-visual'] });
  }, id);
  return () => page.evaluate((id) => (window as unknown as Record<string, string[]>)[`seen_${id}`]!, id);
}

test('hold to fire: arming → sending → running → success → ready', async ({ page }) => {
  const seen = await trackVisuals(page, 'hold');
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  await expectVisual(page, 'hold', 'running');
  await expect(btn(page, 'hold')).toContainText('working');
  await f.up();
  await expectVisual(page, 'hold', 'success');
  await expect(btn(page, 'hold')).toContainText('held ok');
  await expectVisual(page, 'hold', 'ready');
  expect(await seen()).toEqual(['ready', 'arming', 'sending', 'running', 'success', 'ready']);
});

test('releasing early drains back to ready without firing', async ({ page }) => {
  const seen = await trackVisuals(page, 'hold');
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  await page.waitForTimeout(150);
  await f.up();
  await expectVisual(page, 'hold', 'ready');
  await page.waitForTimeout(600);
  expect(await seen()).toEqual(['ready', 'arming', 'ready']);
});

test('drifting past driftPx cancels the hold', async ({ page }) => {
  const seen = await trackVisuals(page, 'hold');
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  await f.move(0, 80);
  await expectVisual(page, 'hold', 'ready');
  await page.waitForTimeout(600);
  await f.up();
  expect(await seen()).toEqual(['ready', 'arming', 'ready']);
});

test('small wobble within driftPx still fires', async ({ page }) => {
  await f.down('hold');
  await f.move(20, 15);
  await expectVisual(page, 'hold', 'running');
  await f.up();
});

test('tap fires on release', async ({ page }) => {
  await f.down('tap');
  await page.waitForTimeout(300);
  await expectVisual(page, 'tap', 'ready');
  await f.up();
  await expectVisual(page, 'tap', 'running');
  await expectVisual(page, 'tap', 'success');
  await expect(btn(page, 'tap')).toContainText('tapped ok');
});

test('tap that drifts does not fire', async ({ page }) => {
  await f.down('tap');
  await f.move(90, 0);
  await f.up();
  await page.waitForTimeout(500);
  await expectVisual(page, 'tap', 'ready');
});

test('double: one tap does nothing, two taps fire', async ({ page }) => {
  await f.tap('double');
  await page.waitForTimeout(700);
  await expectVisual(page, 'double', 'ready');
  await f.tap('double');
  await page.waitForTimeout(80);
  await f.tap('double');
  await expectVisual(page, 'double', 'running');
  await expectVisual(page, 'double', 'success');
});

test('confirm: first fire asks again, second fires; the window times out', async ({ page }) => {
  await f.hold('confirm', 450);
  await expectVisual(page, 'confirm', 'confirm');
  await expect(btn(page, 'confirm')).toContainText('AGAIN TO CONFIRM');
  // Let the 1.5 s window lapse: back to ready, nothing ran.
  await expectVisual(page, 'confirm', 'ready', 3000);
  await f.hold('confirm', 450);
  await expectVisual(page, 'confirm', 'confirm');
  await f.hold('confirm', 450);
  await expectVisual(page, 'confirm', 'running');
  await expectVisual(page, 'confirm', 'success');
});

test('keyboard: a mapped key fires on keydown, hold and tap buttons alike (clickers send down+up at once)', async ({ page }) => {
  // An instant down/up on a hold button: no hold needed.
  await page.keyboard.press('h');
  await expectVisual(page, 'hold', 'running');
  await expectVisual(page, 'hold', 'success');
  await page.keyboard.press('t');
  await expectVisual(page, 'tap', 'running');
});

test('multi-touch: two buttons held at once both fire', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'needs a touch screen');
  await f.down('hold', 1);
  await f.down('hold2', 2);
  await expectVisual(page, 'hold', 'arming');
  await expectVisual(page, 'hold2', 'arming');
  await expectVisual(page, 'hold', 'running');
  await expectVisual(page, 'hold2', 'running');
  await f.up(1);
  await f.up(2);
  await expectVisual(page, 'hold', 'success');
  await expectVisual(page, 'hold2', 'success');
});

test('multi-touch: lifting one finger only cancels its own button', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'needs a touch screen');
  await f.down('hold', 1);
  await f.down('hold2', 2);
  await page.waitForTimeout(120);
  await f.up(2);
  await expectVisual(page, 'hold2', 'ready');
  await expectVisual(page, 'hold', 'running');
  await f.up(1);
  await page.waitForTimeout(300);
  await expectVisual(page, 'hold2', 'ready');
});

test('a second finger on the same button does not cancel the first one', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'needs a touch screen');
  await f.down('hold', 1);
  await page.waitForTimeout(100);
  await f.down('hold', 2);
  await f.up(2);
  // Lifting the second finger must not cancel the first finger's hold.
  await expectVisual(page, 'hold', 'running');
  await f.up(1);
});

test('pressing while running (whileRunning: ignore) flashes BUSY', async ({ page }) => {
  await f.tap('slow');
  await expectVisual(page, 'slow', 'running');
  await f.tap('slow');
  await expect(btn(page, 'slow')).toHaveAttribute('data-flash', 'busy');
  await expect(btn(page, 'slow').locator('.bp-badge')).toHaveText('BUSY');
  await expectVisual(page, 'slow', 'running');
});

test('failure shows exit code and stderr text', async ({ page }) => {
  await f.tap('fail');
  await expectVisual(page, 'fail', 'failure');
  await expect(btn(page, 'fail')).toContainText('EXIT 2');
  await expect(btn(page, 'fail')).toContainText('disk full');
});

test('cancel while running: CANCELLING… then CANCELLED', async ({ page }) => {
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'running');
  await expect(btn(page, 'cancel')).toContainText('TAP TO CANCEL');
  await expect(btn(page, 'cancel')).toContainText('%');
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'failure');
  await expect(btn(page, 'cancel')).toContainText('CANCELLED');
});

test('queue while running runs again', async ({ page }) => {
  await f.tap('queue');
  await expectVisual(page, 'queue', 'running');
  await f.tap('queue');
  await expect(btn(page, 'queue')).toContainText('QUEUED');
  await expectVisual(page, 'queue', 'success', 4000);
});

test('no ack within 2 s → NO RESPONSE', async ({ page }) => {
  await page.evaluate(() => (window.__buttpad!.backend as unknown as { dropAcks(n: number): void }).dropAcks(1));
  await f.tap('tap');
  await expectVisual(page, 'tap', 'sending');
  await page.waitForTimeout(1500);
  await expectVisual(page, 'tap', 'sending');
  await expectVisual(page, 'tap', 'failure', 2000);
  await expect(btn(page, 'tap')).toContainText('NO RESPONSE');
});

test('offline: grey + dashed, presses only shake; recovers on reconnect', async ({ page }) => {
  const demo = () => page.evaluate((on) => (window.__buttpad!.backend as unknown as { setOnline(v: boolean): void }).setOnline(on), false);
  await demo();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'offline');
  for (const id of ['hold', 'tap', 'slow']) await expectVisual(page, id, 'offline');
  await expect(btn(page, 'tap')).toContainText('OFFLINE');
  await f.tap('tap');
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'denied');
  await page.waitForTimeout(400);
  await expectVisual(page, 'tap', 'offline');
  await page.evaluate(() => (window.__buttpad!.backend as unknown as { setOnline(v: boolean): void }).setOnline(true));
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await expectVisual(page, 'tap', 'ready');
  await f.tap('tap');
  await expectVisual(page, 'tap', 'running');
});

test('a run keeps going while offline: its last-known state stays visible, and shows again after reconnecting', async ({ page }) => {
  await f.tap('slow');
  await f.tap('fail');
  await expectVisual(page, 'slow', 'running');
  await expectVisual(page, 'fail', 'failure');
  await page.evaluate(() => (window.__buttpad!.backend as unknown as { setOnline(v: boolean): void }).setOnline(false));
  await expectVisual(page, 'slow', 'offline');
  // OFFLINE on top, the running stripes (dimmed, still) and what it was doing underneath.
  await expect(btn(page, 'slow')).toHaveAttribute('data-under', 'running');
  await expect(btn(page, 'slow').locator('.bp-stripes')).toHaveCount(1);
  await expect(btn(page, 'slow')).toContainText('OFFLINE');
  await expect(btn(page, 'slow')).toContainText('RUNNING');
  await expect(btn(page, 'fail')).toHaveAttribute('data-under', 'failure');
  await expect(btn(page, 'fail')).toContainText('LAST RUN: EXIT 2');
  // A result runs out (resultHoldMs 1500) as it would have: then it's just OFFLINE.
  await expect(btn(page, 'fail')).toHaveAttribute('data-under', 'ready', { timeout: 3000 });
  await page.evaluate(() => (window.__buttpad!.backend as unknown as { setOnline(v: boolean): void }).setOnline(true));
  await expectVisual(page, 'slow', 'running');
});

test('pad tabs switch pads; the last pad is remembered; ?pad and ?lock', async ({ page }) => {
  await page.getByTestId('tab-other').click();
  await expect(btn(page, 'solo')).toBeVisible();
  await page.goto('/?demo&exact');
  await expect(btn(page, 'solo')).toBeVisible();
  await page.goto('/?demo&exact&pad=main');
  await expect(btn(page, 'hold')).toBeVisible();
  await expect(page.getByTestId('tab-main')).toHaveAttribute('aria-selected', 'true');
  await page.goto('/?demo&exact&pad=main&lock');
  await expect(btn(page, 'hold')).toBeVisible();
  await expect(page.getByTestId('tab-main')).toHaveCount(0);
});

test('menu: device settings persist; keep-awake status is shown', async ({ page }) => {
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('keep-awake')).toContainText(/On|Waiting|Paused/);
  const sound = page.getByTestId('toggle-sound');
  await expect(sound).toHaveAttribute('aria-checked', 'false');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('menu-edit')).toBeVisible();
  await page.getByTestId('menu-close').click();
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('toggle-sound')).toHaveAttribute('aria-checked', 'true');
});

test('locked-down page: no scrolling, no text selection, no context menu', async ({ page }) => {
  const r = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const el = document.querySelector('[data-testid="btn-hold"]')!;
    el.dispatchEvent(ev);
    const cs = getComputedStyle(document.documentElement);
    return {
      contextPrevented: ev.defaultPrevented,
      scrollable: document.scrollingElement!.scrollHeight > innerHeight,
      userSelect: getComputedStyle(el).userSelect,
      touchAction: getComputedStyle(el).touchAction,
      overscroll: cs.overscrollBehaviorY,
    };
  });
  expect(r).toEqual({ contextPrevented: true, scrollable: false, userSelect: 'none', touchAction: 'none', overscroll: 'none' });
});
