/**
 * Run mode, the details of input and of a press's life (demo backend, `?demo&exact`): stalled main
 * threads, presses while one is in flight, confirm windows, triggers changing mid-press, rolling
 * thumbs, resting thumbs, keyboards/clickers, haptics, and how unanswered presses resolve.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, expectVisual, Fingers, recordVibrations, seedDemo, trackPresses, VIB } from './helpers.ts';

const sh = (script: string) => ({ type: 'shell' as const, script });
const CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 3,
      buttons: [
        { id: 'hold', label: 'Hold', x: 0, y: 0, holdMs: 600, resultHoldMs: 800, key: 'h', action: sh('sleep 0.2; echo held') },
        { id: 'tap', label: 'Tap', color: '#db2777', x: 1, y: 0, trigger: 'tap', resultHoldMs: 1000, key: 't', action: sh('sleep 0.3; echo tapped') },
        { id: 'double', label: 'Double', color: '#7c3aed', x: 2, y: 0, trigger: 'double', resultHoldMs: 800, key: 'd', action: sh('sleep 0.2; echo double') },
        { id: 'confirm', label: 'Confirm', color: '#4338ca', x: 0, y: 1, holdMs: 600, confirm: true, confirmWindowMs: 1000, resultHoldMs: 800, key: 'c', action: sh('sleep 0.2; echo confirmed') },
        { id: 'cancel', label: 'Cancel', color: '#0d9488', x: 1, y: 1, trigger: 'tap', whileRunning: 'cancel', resultHoldMs: 1500, action: sh("echo '@progress 10'; sleep 30") },
        { id: 'slow', label: 'Slow', color: '#0891b2', x: 2, y: 1, trigger: 'tap', resultHoldMs: 800, action: sh("echo '@status busy'; sleep 3") },
      ],
    },
    {
      id: 'many',
      name: 'Many',
      cols: 4,
      rows: 6,
      buttons: Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, label: `M${i}`, x: i % 4, y: Math.floor(i / 4), trigger: 'tap' as const, action: sh('echo m') })),
    },
  ],
};

type DemoHandle = {
  press(pad: string, id: string, onSent?: () => void): Promise<string>;
  saveConfig(c: unknown, rev: string): Promise<{ ok: boolean }>;
  snapshot: { get(): { config: unknown; rev: string } };
  setOnline(v: boolean): void;
  dropAcks(n: number): void;
  dropLinkOnNextPress(): void;
};
const demo = (page: Page) => ({
  run: <T,>(fn: (b: DemoHandle) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__buttpad.backend)`) as Promise<T>,
});

let f: Fingers;
let vib: () => Promise<string[]>;
const count = async (pattern: string) => (await vib()).filter((v) => v === pattern).length;

test.beforeEach(async ({ page, hasTouch }) => {
  await seedDemo(page, CONFIG);
  vib = await recordVibrations(page);
  await page.goto('/?demo&exact&pad=main');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  f = new Fingers(page, hasTouch);
});

/** Makes the main thread busy `fromMs..fromMs+forMs` after the next pointerdown on a button. */
async function stallAfterDown(page: Page, id: string, fromMs: number, forMs: number) {
  await page.evaluate(
    ([id, from, ms]) =>
      document.querySelector(`[data-testid="btn-${id}"]`)!.addEventListener(
        'pointerdown',
        () =>
          setTimeout(() => {
            const end = performance.now() + ms;
            while (performance.now() < end);
          }, from),
        { once: true },
      ),
    [id, fromMs, forMs] as const,
  );
}

/** Relabel a button through the backend: a config broadcast, like another admin saving. */
async function relabel(page: Page, id: string, label: string, patch: Record<string, unknown> = {}) {
  await page.evaluate(
    async ([id, label, patch]) => {
      const b = window.__buttpad!.backend;
      const s = b.snapshot.get();
      const cfg = structuredClone(s.config) as { pads: { buttons: { id: string; label: string }[] }[] };
      const button = cfg.pads.flatMap((p) => p.buttons).find((x) => x.id === id)!;
      Object.assign(button, { label }, patch);
      const r = await b.saveConfig(cfg as never, s.rev!);
      if (!r.ok) throw new Error(JSON.stringify(r));
    },
    [id, label, patch] as const,
  );
}

// The events carry their own times (CDP timestamps): what counts is when the finger lifted, not when
// a busy page got around to it (nor when a loaded test machine got around to sending it).
test('stalled page: a finger lifted before holdMs never fires, even when the hold timer runs late', async ({ page }) => {
  const presses = await trackPresses(page);
  // Busy 150..950 ms after the touch; holdMs is 600; the finger lifts at 300 ms.
  await stallAfterDown(page, 'hold', 150, 800);
  const t0 = Date.now();
  await f.downAt('hold', t0);
  await page.waitForTimeout(250);
  await f.upAt(t0 + 300);
  await page.waitForTimeout(900);
  expect(await presses()).toEqual([]);
  await expectVisual(page, 'hold', 'ready');
});

test('stalled page: a finger held past holdMs fires once, whichever of timer and release runs first', async ({ page }) => {
  const presses = await trackPresses(page);
  // Busy 300..1200 ms; the finger lifts at 850 ms, after holdMs (600).
  await stallAfterDown(page, 'hold', 300, 900);
  const t0 = Date.now();
  await f.downAt('hold', t0);
  await page.waitForTimeout(800);
  await f.upAt(t0 + 850);
  await expectVisual(page, 'hold', 'success');
  expect(await presses()).toEqual(['hold']);
});

test('pressing again while the last press is still SENDING: BUSY, no second fire buzz, nothing dropped silently', async ({ page }) => {
  const presses = await trackPresses(page);
  await demo(page).run((b) => b.dropAcks(1));
  await f.tap('tap');
  await expectVisual(page, 'tap', 'sending');
  await f.tap('tap');
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'busy');
  await expect(btn(page, 'tap').locator('.bp-badge')).toHaveText('BUSY');
  expect(await count(VIB.fire)).toBe(1);
  expect(await count(VIB.busy)).toBe(1);
  expect(await presses()).toEqual(['tap']);
});

test('no ack in 2 s: NO RESPONSE, with the "unknown" buzz rather than the failure one', async ({ page }) => {
  await demo(page).run((b) => b.dropAcks(1));
  await f.tap('tap');
  await expectVisual(page, 'tap', 'unknown', 3500);
  await expect(btn(page, 'tap')).toContainText('NO RESPONSE');
  expect(await count(VIB.unknown)).toBe(1);
  expect(await count(VIB.failure)).toBe(0);
});

test('a press that never left the device says NOT SENT (and keeps saying it until touched), not NO RESPONSE', async ({ page }) => {
  // A backend that gives up before sending (the socket closed under it).
  await page.evaluate(() => {
    (window.__buttpad!.backend as unknown as { press(): Promise<never> }).press = () => Promise.reject(new Error('not connected to the host'));
  });
  await f.tap('tap');
  await expectVisual(page, 'tap', 'failure');
  await expect(btn(page, 'tap')).toContainText('NOT SENT');
  await expect(btn(page, 'tap')).toHaveAttribute('data-sticky', '');
  await page.waitForTimeout(2300);
  await expect(btn(page, 'tap')).toContainText('NOT SENT');
  await expect(btn(page, 'tap')).not.toContainText('NO RESPONSE');
  expect(await count(VIB.failure)).toBe(0);
});

test('lost ack: once the link is back, a press that did run shows what it did (not NO RESPONSE)', async ({ page }) => {
  // The press reaches the "host" and runs; the link dies before the ack gets back.
  await demo(page).run((b) => b.dropLinkOnNextPress());
  await f.tap('tap');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'offline');
  await page.waitForTimeout(100);
  await demo(page).run((b) => b.setOnline(true));
  // Back within the run: its SUCCESS (with the success buzz, never the failure one).
  await expectVisual(page, 'tap', 'success');
  await expect.poll(() => count(VIB.success)).toBe(1);
  expect(await count(VIB.failure)).toBe(0);
  await expectVisual(page, 'tap', 'ready', 3000);

  // Back only after it finished and its result ran out: READY's `last` says how it ended, so that
  // shows (a result like any other, with its buzz), not NO RESPONSE.
  await demo(page).run((b) => b.dropLinkOnNextPress());
  await f.tap('tap');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'offline');
  await page.waitForTimeout(1700);
  await demo(page).run((b) => b.setOnline(true));
  await expectVisual(page, 'tap', 'success');
  await expect(btn(page, 'tap')).toContainText('tapped');
  await expect(btn(page, 'tap')).not.toContainText('NO RESPONSE');
  await expect.poll(() => count(VIB.success)).toBe(2);
  expect(await count(VIB.failure)).toBe(0);
  await expectVisual(page, 'tap', 'ready', 3000);
});

test('confirm: a second hold begun inside the window fires, even when it completes after the window', async ({ page }) => {
  const presses = await trackPresses(page);
  // The first hold fires at 600 ms: the window runs 600..1600 ms.
  await f.hold('confirm', 700);
  await expectVisual(page, 'confirm', 'confirm');
  await page.waitForTimeout(500);
  // Begun at ~1.2 s, inside the window; completes at ~1.8 s, after it.
  await f.down('confirm');
  await page.waitForTimeout(750);
  await f.up();
  await expectVisual(page, 'confirm', 'success');
  expect(await presses()).toEqual(['confirm']);
});

test('confirm: a confirming press that is let go early gives the window back', async ({ page }) => {
  await f.hold('confirm', 700);
  await expectVisual(page, 'confirm', 'confirm');
  await page.waitForTimeout(450);
  await f.down('confirm');
  // It took the window over…
  await expectVisual(page, 'confirm', 'arming');
  await page.waitForTimeout(150);
  await f.up();
  await expectVisual(page, 'confirm', 'confirm');
  await expect(btn(page, 'confirm')).toContainText('AGAIN TO CONFIRM');
});

test('a trigger change from hold to tap mid-press does not fire again on release', async ({ page }) => {
  const presses = await trackPresses(page);
  await f.down('hold');
  await expect.poll(presses).toEqual(['hold']);
  await relabel(page, 'hold', 'Hold', { trigger: 'tap' });
  await page.waitForTimeout(200);
  await f.up();
  await page.waitForTimeout(800);
  expect(await presses()).toEqual(['hold']);
});

test('a tap button pressed longer than 1.5 s (a resting thumb) does not fire, and says so with a short buzz', async ({ page }) => {
  const presses = await trackPresses(page);
  await f.down('tap');
  await page.waitForTimeout(1700);
  await f.up();
  await page.waitForTimeout(400);
  expect(await presses()).toEqual([]);
  expect(await count(VIB.cancel)).toBe(1);
  expect(await count(VIB.fire)).toBe(0);
  await expectVisual(page, 'tap', 'ready');
});

test('cancelled gestures (released early, slid off) get the short "cancelled" buzz', async ({ page }) => {
  await f.down('hold');
  await page.waitForTimeout(150);
  await f.up();
  await expect.poll(() => count(VIB.cancel)).toBe(1);
  await f.down('hold');
  await page.waitForTimeout(100);
  await f.move(0, 90);
  await expect.poll(() => count(VIB.cancel)).toBe(2);
  await f.up();
  await page.waitForTimeout(800);
  expect(await count(VIB.fire)).toBe(0);
  await expectVisual(page, 'hold', 'ready');
});

test('rolling thumb: a second contact on the same button carries the hold on when the first lifts', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'needs a touch screen');
  const presses = await trackPresses(page);
  await f.down('hold', 1);
  await page.waitForTimeout(150);
  await f.down('hold', 2, { x: 15, y: 10 });
  await page.waitForTimeout(100);
  // The first contact lifts at ~250 ms, before holdMs (600): the second one still holds the button.
  await f.up(1);
  await expect.poll(presses).toEqual(['hold']);
  await f.up(2);
  await expectVisual(page, 'hold', 'success');
  expect(await presses()).toEqual(['hold']);
});

test('keyboard: auto-repeat is ignored, a double is two keydowns, confirm still applies', async ({ page }) => {
  const presses = await trackPresses(page);
  // Holding a key: one press (the later keydowns are auto-repeats).
  await page.keyboard.down('t');
  await page.keyboard.down('t');
  await page.keyboard.down('t');
  await page.keyboard.up('t');
  await expectVisual(page, 'tap', 'success');
  await page.keyboard.press('d');
  await expectVisual(page, 'double', 'ready');
  await page.waitForTimeout(120);
  await page.keyboard.press('d');
  await expect.poll(presses).toEqual(['tap', 'double']);
  await page.keyboard.press('c');
  await expectVisual(page, 'confirm', 'confirm');
  await expect(btn(page, 'confirm')).toContainText('PRESS AGAIN TO CONFIRM');
  // A deliberate second press (not a bounce: 400 ms after CONFIRM came up, at the earliest).
  await page.waitForTimeout(450);
  await page.keyboard.press('c');
  await expectVisual(page, 'confirm', 'success');
  expect(await presses()).toEqual(['tap', 'double', 'confirm']);
});

test('keyboard: a key held across a config broadcast does not fire again; a double survives one', async ({ page }) => {
  const presses = await trackPresses(page);
  // A clicker that doesn't flag its repeats: the same key goes down twice, a config change between.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true })));
  await relabel(page, 'slow', 'Slow 2');
  await expect(btn(page, 'slow')).toContainText('Slow 2');
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true })));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 't', code: 'KeyT', bubbles: true })));
  await expectVisual(page, 'tap', 'success');
  expect(await presses()).toEqual(['tap']);
  // First keydown of a double, a broadcast, the second keydown: still a double.
  await page.keyboard.press('d');
  await relabel(page, 'slow', 'Slow 3');
  await page.waitForTimeout(80);
  await page.keyboard.press('d');
  await expect.poll(presses).toEqual(['tap', 'double']);
});

test('cancel: no hint and no cancel within 700 ms of the start (like the host); after that it cancels', async ({ page }) => {
  const presses = await trackPresses(page);
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'running');
  await expect(btn(page, 'cancel')).not.toContainText('TO CANCEL');
  // A second tap right away is a double press (a bounce), not a cancel: this device doesn't even send it.
  await f.tap('cancel');
  await expect(btn(page, 'cancel')).toHaveAttribute('data-flash', 'cooldown');
  await expect(btn(page, 'cancel').locator('.bp-badge')).toHaveText('BUSY');
  expect(await presses()).toEqual(['cancel']);
  await expect(btn(page, 'cancel')).toContainText('TAP TO CANCEL');
  await expectVisual(page, 'cancel', 'running');
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'stopped');
  await expect(btn(page, 'cancel')).toContainText('STOPPED');
  expect(await count(VIB.failure)).toBe(0);
});

test('the demo answers presses like the host: cancelling while cancelling, ignored past the start limit', async ({ page }) => {
  const acks = await demo(page).run(async (b) => {
    const out = [await b.press('main', 'cancel')];
    await new Promise((r) => setTimeout(r, 750));
    out.push(await b.press('main', 'cancel'), await b.press('main', 'cancel'));
    return out;
  });
  expect(acks).toEqual(['started', 'cancelling', 'cancelling']);
  // Bursts of 20 starts, then 10/s: 21 at once → the last one is refused.
  await page.waitForTimeout(2100);
  const burst = await demo(page).run((b) => Promise.all(Array.from({ length: 21 }, (_, i) => b.press('many', `m${i}`))));
  expect(burst.filter((r) => r === 'started')).toHaveLength(20);
  expect(burst.filter((r) => r === 'ignored')).toHaveLength(1);
});

test('ignored on a READY button (the host is refusing starts for now) reads BUSY — TRY AGAIN', async ({ page }) => {
  await page.evaluate(() => {
    (window.__buttpad!.backend as unknown as { press(p: string, b: string, o?: { onSent?(): void }): Promise<string> }).press = (_p, _b, o) => (o?.onSent?.(), Promise.resolve('ignored'));
  });
  await f.tap('tap');
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'later');
  await expect(btn(page, 'tap').locator('.bp-badge')).toContainText('BUSY');
  await expect(btn(page, 'tap').locator('.bp-badge')).toContainText('TRY AGAIN');
  await expectVisual(page, 'tap', 'ready');
});
