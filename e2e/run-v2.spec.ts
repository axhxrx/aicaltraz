/**
 * Run mode, round 2 (demo backend, `?demo&exact`): protocol v2 on the client (confirm flags,
 * expired presses, whose run it is, latched state, last results, stops), and input safety for
 * field use (deliberate confirms, cooldowns, global keys, deliberate navigation, ?lock/?pad, rough
 * mode, grazes and palms, SLIPPED, sticky failures, ALREADY RUNNING, buttons moving under a finger,
 * controllers that outlive pad switches, keep-awake warnings).
 */
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, demo, expectVisual, Fingers, recordVibrations, seedDemo, trackPresses, VIB } from './helpers.ts';

const sh = (script: string) => ({ type: 'shell' as const, script });
const CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 4,
      rows: 3,
      buttons: [
        { id: 'hold', label: 'Hold', x: 0, y: 0, holdMs: 400, resultHoldMs: 800, key: 'h', action: sh('sleep 0.2; echo held') },
        { id: 'tap', label: 'Tap', color: '#db2777', x: 1, y: 0, trigger: 'tap', resultHoldMs: 800, key: 't', action: sh('sleep 0.3; echo tapped') },
        { id: 'wrap', label: 'Wrap', color: '#7c3aed', x: 2, y: 0, holdMs: 300, confirm: true, confirmWindowMs: 3000, resultHoldMs: 800, key: 'w', action: sh('sleep 0.2; echo wrapped') },
        { id: 'fail', label: 'Fail', color: '#f97316', x: 0, y: 1, trigger: 'tap', resultHoldMs: 600, action: sh("sleep 0.5; echo 'disk full' >&2; exit 2") },
        { id: 'failhold', label: 'Fail hold', color: '#ea580c', x: 1, y: 1, holdMs: 300, resultHoldMs: 600, action: sh("echo 'nope' >&2; exit 1") },
        { id: 'slow', label: 'Slow', color: '#0891b2', x: 2, y: 1, trigger: 'tap', whileRunning: 'cancel', action: sh("echo '@progress 2'; sleep 30") },
        { id: 'rec', label: 'REC', color: '#dc2626', x: 0, y: 2, trigger: 'tap', resultHoldMs: 800, action: sh("echo '@state REC ●'; echo recording") },
        { id: 'stop', label: 'All off', color: '#4338ca', x: 1, y: 2, trigger: 'tap', stops: ['main/*'], action: { type: 'none' } },
        { id: 'chatter', label: 'Chatter', color: '#0d9488', x: 2, y: 2, trigger: 'tap', key: 'c', resultHoldMs: 500, action: sh('echo hi') },
      ],
    },
    {
      id: 'ride',
      name: 'Ride',
      cols: 1,
      rows: 2,
      buttons: [
        { id: 'pull', label: 'PULL OVER', color: '#f97316', x: 0, y: 0, trigger: 'tap', key: 'p', action: sh('echo pulled') },
        { id: 'dup1', label: 'Dup one', x: 0, y: 1, trigger: 'tap', key: 'x', action: sh('echo one') },
      ],
    },
    { id: 'crew', name: 'Crew', cols: 1, rows: 1, buttons: [{ id: 'dup2', label: 'Dup two', x: 0, y: 0, trigger: 'tap', key: 'x', action: sh('echo two') }] },
  ],
};

let f: Fingers;
let vib: () => Promise<string[]>;
const count = async (pattern: string) => (await vib()).filter((v) => v === pattern).length;

async function open(page: Page, query = '?demo&exact&pad=main') {
  await page.goto(`/${query}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
}

test.beforeEach(async ({ page, hasTouch }) => {
  await seedDemo(page, CONFIG);
  vib = await recordVibrations(page);
  f = new Fingers(page, hasTouch);
});

/** Change the config like another admin saving (a config broadcast). */
async function edit(page: Page, change: string) {
  await page.evaluate(async (change) => {
    const b = window.__buttpad!.backend;
    const s = b.snapshot.get();
    const cfg = structuredClone(s.config) as { pads: { id: string; name: string; buttons: { id: string; x: number; y: number }[] }[] };
    new Function('cfg', change)(cfg);
    const r = await b.saveConfig(cfg as never, s.rev!);
    if (!r.ok) throw new Error(JSON.stringify(r));
  }, change);
}

// ---- protocol v2 ------------------------------------------------------------------------------

test('a press carries confirm only after the confirm step; a needs-confirm answer asks for it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const b = window.__buttpad!.backend as unknown as { press(p: string, id: string, o?: { confirm?: boolean }): Promise<string> };
    const orig = b.press.bind(b);
    const w = window as unknown as { __sent: string[] };
    w.__sent = [];
    b.press = (p, id, o) => (w.__sent.push(`${id}:${o?.confirm ? 'confirm' : '-'}`), orig(p, id, o));
  });
  const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.slice());
  await f.tap('tap');
  await f.hold('wrap', 400);
  await expectVisual(page, 'wrap', 'confirm');
  await expect(btn(page, 'wrap')).toContainText('HOLD AGAIN TO CONFIRM');
  await page.waitForTimeout(450);
  await f.hold('wrap', 400);
  await expectVisual(page, 'wrap', 'success');
  expect(await sent()).toEqual(['tap:-', 'wrap:confirm']);

  // The host wants the confirm step for a press sent without it (the button became a confirm button on the way): ask.
  await expectVisual(page, 'tap', 'ready', 3000);
  await page.evaluate(() => {
    (window.__buttpad!.backend as unknown as { press(p: string, b: string, o?: { onSent?(): void; onAck?(a: unknown): void }): Promise<string> }).press = (_p, _b, o) => {
      o?.onSent?.();
      o?.onAck?.({ result: 'needs-confirm' });
      return Promise.resolve('needs-confirm');
    };
  });
  await f.tap('tap');
  await expectVisual(page, 'tap', 'confirm');
  await expect(btn(page, 'tap')).toContainText('TAP AGAIN TO CONFIRM');
});

test('a press that sat in a dead link: NO RESPONSE, then NOT SENT (too late) when the host drops it — never a success later', async ({ page }) => {
  await open(page);
  // It reaches the "host" 3.3 s after it was made: older than 3 s, so the host drops it (`expired`).
  await demo(page, (b) => b.delayNextPress(3300));
  await f.tap('tap');
  await expectVisual(page, 'tap', 'unknown', 4000);
  await expect(btn(page, 'tap')).toContainText('NO RESPONSE');
  await expect(btn(page, 'tap')).toContainText('NOT SENT', { timeout: 4000 });
  await expect(btn(page, 'tap')).toContainText('too late');
  await expectVisual(page, 'tap', 'failure');
  await page.waitForTimeout(800);
  await expectVisual(page, 'tap', 'failure');
  expect(await demo(page, (b) => b.snapshot.get().states['main/tap']?.runId ?? 0)).toBe(0);
  expect(await count(VIB.success)).toBe(0);
});

test("runs started on another device are marked and don't buzz here; the loser of two presses at once says ALREADY RUNNING", async ({ page }) => {
  await open(page);
  // Another device starts it (a press straight to the backend: no ack for this button).
  await demo(page, (b) => b.press('main', 'tap'));
  await expectVisual(page, 'tap', 'running');
  await expect(page.getByTestId('other-tap')).toBeVisible();
  await expectVisual(page, 'tap', 'success');
  await expect(page.getByTestId('other-tap')).toBeVisible();
  await expectVisual(page, 'tap', 'ready', 3000);
  expect(await count(VIB.success)).toBe(0);

  // This device's own run: no mark, and its outcome buzz.
  await f.tap('tap');
  await expectVisual(page, 'tap', 'running');
  await expect(page.getByTestId('other-tap')).toHaveCount(0);
  await expect.poll(() => count(VIB.success)).toBe(1);
  await expectVisual(page, 'tap', 'ready', 3000);

  // Pressed at the same moment as another device, whose press gets there first: this one is ignored.
  await page.evaluate(() => {
    const b = window.__buttpad!.backend as unknown as { press(p: string, id: string, o?: unknown): Promise<string> };
    const orig = b.press.bind(b);
    b.press = (p, id, o) => {
      b.press = orig;
      void orig(p, id);
      return orig(p, id, o);
    };
  });
  await f.tap('tap');
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'already');
  await expect(btn(page, 'tap').locator('.bp-badge')).toContainText('ALREADY');
  await expect(page.getByTestId('other-tap')).toBeVisible();
  await expectVisual(page, 'tap', 'success');
  await page.waitForTimeout(400);
  expect(await count(VIB.success)).toBe(1);
});

test('latched device state (@state) shows as a chip in every state, offline too', async ({ page }) => {
  await open(page);
  await f.tap('rec');
  await expect(page.getByTestId('latched-rec')).toHaveText('REC ●');
  await expectVisual(page, 'rec', 'success');
  await expect(page.getByTestId('latched-rec')).toBeVisible();
  await expectVisual(page, 'rec', 'ready', 3000);
  await expect(page.getByTestId('latched-rec')).toHaveText('REC ●');
  await demo(page, (b) => b.setOnline(false));
  await expectVisual(page, 'rec', 'offline');
  await expect(page.getByTestId('latched-rec')).toHaveText('REC ●');
});

test('READY shows how the last run ended; a run the host lost (restart) is amber INTERRUPTED and stays', async ({ page }) => {
  await open(page);
  await f.tap('tap');
  await expectVisual(page, 'tap', 'success');
  await expectVisual(page, 'tap', 'ready', 3000);
  await expect(page.getByTestId('last-tap')).toContainText(/✓\s*\d+ s ago/);

  await f.tap('slow');
  await expectVisual(page, 'slow', 'running');
  await demo(page, (b) => b.restart());
  await expectVisual(page, 'slow', 'interrupted');
  await expect(btn(page, 'slow')).toContainText('INTERRUPTED');
  await expect(btn(page, 'slow')).toHaveAttribute('data-sticky', '');
  await expect.poll(() => count(VIB.unknown)).toBe(1);
  expect(await count(VIB.failure)).toBe(0);
  // Its result hold (2.5 s) runs out on the host; here it stays until touched.
  await page.waitForTimeout(3000);
  await expectVisual(page, 'slow', 'interrupted');
});

test('stops + a `none` action: All off stops the running buttons it names (STOPPED, no failure buzz) and says how many', async ({ page }) => {
  await open(page);
  await f.tap('slow');
  await expectVisual(page, 'slow', 'running');
  await f.tap('stop');
  await expectVisual(page, 'slow', 'stopped');
  await expect(btn(page, 'slow')).toContainText('Stopped by All off');
  await expect(btn(page, 'stop')).toContainText('Stopped 1');
  await page.waitForTimeout(400);
  expect(await count(VIB.failure)).toBe(0);
});

// ---- input & safety ---------------------------------------------------------------------------

test('confirm takes a deliberate second press: a chattering key or a pothole bounce does not confirm', async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  // A chattering key: two keydowns 30 ms apart.
  await page.keyboard.press('w');
  await page.waitForTimeout(30);
  await page.keyboard.press('w');
  await expectVisual(page, 'wrap', 'confirm');
  await expect(btn(page, 'wrap')).toContainText('PRESS AGAIN TO CONFIRM');
  await page.waitForTimeout(250);
  expect(await presses()).toEqual([]);
  // A deliberate one does.
  await page.waitForTimeout(200);
  await page.keyboard.press('w');
  await expectVisual(page, 'wrap', 'success');
  expect(await presses()).toEqual(['wrap']);
  await expectVisual(page, 'wrap', 'ready', 3000);

  // A pothole: the hold that asked for confirmation (CONFIRM at 300 ms), a 120 ms lift, and the
  // hand lands again (stamped events: what counts is when each contact happened).
  const t0 = Date.now();
  await f.downAt('wrap', t0);
  await expectVisual(page, 'wrap', 'confirm');
  await f.upAt(t0 + 400);
  await f.downAt('wrap', t0 + 520);
  await page.waitForTimeout(500);
  await f.upAt(t0 + 1020);
  await page.waitForTimeout(300);
  expect(await presses()).toEqual(['wrap']);
  await expectVisual(page, 'wrap', 'confirm');
});

test('cooldown: a chattering key sends once, without a second fire buzz, and shows a brief BUSY', async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  await page.keyboard.press('c');
  await page.waitForTimeout(30);
  await page.keyboard.press('c');
  await expect(btn(page, 'chatter')).toHaveAttribute('data-flash', 'cooldown');
  await expect(btn(page, 'chatter').locator('.bp-badge')).toHaveText('BUSY');
  await page.waitForTimeout(500);
  expect(await presses()).toEqual(['chatter']);
  expect(await count(VIB.fire)).toBe(1);
  expect(await count(VIB.busy)).toBe(0);
  // Past the cooldown it's a press again.
  await page.keyboard.press('c');
  await expect.poll(presses).toEqual(['chatter', 'chatter']);
});

test('keys are global: a key of a button on another pad fires it (with a toast); one on several other pads does nothing', async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  await page.keyboard.press('p');
  await expect(page.getByTestId('run-toast')).toContainText('▶ PULL OVER (Ride)');
  await expect.poll(presses).toEqual(['pull']);
  await page.keyboard.press('x');
  await expect(page.getByTestId('run-toast')).toContainText('on 2 pads');
  await page.waitForTimeout(300);
  expect(await presses()).toEqual(['pull']);
  // The pad on screen comes first: on Ride, x is Ride's.
  await page.getByTestId('tab-ride').click();
  await expect(btn(page, 'dup1')).toBeVisible();
  await page.keyboard.press('x');
  await expect.poll(presses).toEqual(['pull', 'dup1']);
});

test('pad tabs and the menu button take a deliberate touch (a brush does nothing); keys work while the menu is open', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'touch only (mouse clicks are deliberate)');
  await open(page);
  const presses = await trackPresses(page);
  await f.pressStamped('tab-ride', 45, { testid: true });
  await page.waitForTimeout(250);
  await expect(page.getByTestId('tab-main')).toHaveAttribute('aria-selected', 'true');
  await f.pressStamped('tab-ride', 140, { testid: true });
  await expect(page.getByTestId('tab-ride')).toHaveAttribute('aria-selected', 'true');
  await f.pressStamped('menu-btn', 45, { testid: true });
  await page.waitForTimeout(250);
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await f.pressStamped('menu-btn', 140, { testid: true });
  await expect(page.getByTestId('menu')).toBeVisible();
  // A remote's key while the menu is open: the menu closes and the button fires.
  await page.keyboard.press('p');
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await expect.poll(presses).toEqual(['pull']);
});

test('?lock without ?pad is the first pad, not the remembered one; its menu opens on a long press only', async ({ page }) => {
  await open(page, '?demo&exact&pad=ride');
  await page.getByTestId('tab-crew').click();
  await expect(btn(page, 'dup2')).toBeVisible();
  await open(page, '?demo&exact&lock');
  await expect(btn(page, 'hold')).toBeVisible();
  await expect(page.getByTestId('tab-main')).toHaveCount(0);
  await f.pressTestId('menu-btn', 300);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await f.pressTestId('menu-btn', 1300);
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('menu')).toContainText('press and hold');
});

test('?pad matches a name in any case; a pad that is missing (from the start, or deleted while open) says so, never another pad', async ({ page }) => {
  await open(page, '?demo&exact&pad=RIDE');
  await expect(btn(page, 'pull')).toBeVisible();
  await expect(page.getByTestId('tab-ride')).toHaveAttribute('aria-selected', 'true');
  await open(page, '?demo&exact&pad=nope');
  await expect(page.getByTestId('pad-missing')).toContainText('Pad “nope” no longer exists');
  await expect(page.locator('.bp-btn')).toHaveCount(0);
  // Pick another pad from there.
  await page.getByTestId('open-pad-ride').click();
  await expect(btn(page, 'pull')).toBeVisible();

  // A kiosk locked to Crew; Crew is renamed (id), then deleted.
  await open(page, '?demo&exact&pad=crew&lock');
  await expect(btn(page, 'dup2')).toBeVisible();
  await edit(page, "cfg.pads[2].id = 'crew-2'");
  await expect(btn(page, 'dup2')).toBeVisible();
  await edit(page, 'cfg.pads.splice(2, 1)');
  await expect(page.getByTestId('pad-missing')).toContainText('Pad “crew” no longer exists');
  await expect(page.locator('.bp-btn')).toHaveCount(0);
  // Keys don't make it some other pad's remote either... unless a key is unique and says so (toast).
  await expect(page.getByTestId('pad-missing')).toContainText('locked');
});

test('rough mode: one button at a time, firmer taps, a longer cooldown', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'needs a touch screen');
  await open(page);
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('toggle-rough').click();
  await expect(page.getByTestId('toggle-rough')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('menu-close').click();
  const presses = await trackPresses(page);
  // A second contact on another button while one is down: ignored.
  await f.down('hold', 1);
  await page.waitForTimeout(80);
  await f.down('tap', 2);
  await page.waitForTimeout(120);
  await f.up(2);
  await expect.poll(presses).toEqual(['hold']);
  await f.up(1);
  await page.waitForTimeout(300);
  expect(await presses()).toEqual(['hold']);
  // 60 ms is a graze here (taps take 80 ms); 140 ms is a tap.
  await f.pressStamped('tap', 60);
  await page.waitForTimeout(300);
  expect(await presses()).toEqual(['hold']);
  await f.pressStamped('tap', 140);
  await expect.poll(presses).toEqual(['hold', 'tap']);
  // Again right away: within rough mode's 800 ms cooldown.
  await f.pressStamped('tap', 140);
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'cooldown');
  expect(await presses()).toEqual(['hold', 'tap']);
});

test('a graze on a tap button does not fire; a palm landing on several buttons fires none of them', async ({ page, hasTouch }) => {
  await open(page);
  const presses = await trackPresses(page);
  await f.pressStamped('tap', 15);
  await page.waitForTimeout(300);
  expect(await presses()).toEqual([]);
  await expectVisual(page, 'tap', 'ready');
  test.skip(!hasTouch, 'the palm needs a touch screen');
  await f.downAll(['tap', 'fail', 'rec', 'chatter']);
  await page.waitForTimeout(120);
  for (const i of [1, 2, 3, 4]) await f.up(i);
  await page.waitForTimeout(500);
  expect(await presses()).toEqual([]);
});

test('a hold let go early, or a press that slid off, says SLIPPED — HOLD/TAP AGAIN (with the short buzz)', async ({ page }) => {
  await open(page);
  await f.hold('hold', 150);
  await expect(btn(page, 'hold')).toHaveAttribute('data-flash', 'slipped');
  await expect(btn(page, 'hold').locator('.bp-badge')).toContainText('SLIPPED');
  await expect(btn(page, 'hold').locator('.bp-badge')).toContainText('HOLD AGAIN');
  await expect.poll(() => count(VIB.cancel)).toBe(1);
  await f.down('tap');
  await f.move(90, 0);
  await f.up();
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'slipped');
  await expect(btn(page, 'tap').locator('.bp-badge')).toContainText('TAP AGAIN');
});

test('a failure stays until touched; that touch only clears it (a tap does not fire), and a hold from it retries', async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  await f.tap('fail');
  await expectVisual(page, 'fail', 'failure');
  await expect.poll(() => count(VIB.failure)).toBe(1);
  // Its resultHoldMs (600 ms) passes: still there.
  await page.waitForTimeout(1200);
  await expectVisual(page, 'fail', 'failure');
  await expect(btn(page, 'fail')).toContainText('TAP TO CLEAR');
  await expect(btn(page, 'fail')).toContainText('disk full');
  await f.tap('fail');
  await expectVisual(page, 'fail', 'ready');
  await expect(page.getByTestId('last-fail')).toContainText('✗');
  expect(await presses()).toEqual(['fail']);
  // A hold button's failure: a hold is a retry.
  await f.hold('failhold', 450);
  await expectVisual(page, 'failhold', 'failure');
  await page.waitForTimeout(900);
  await expectVisual(page, 'failhold', 'failure');
  await expect(btn(page, 'failhold')).toContainText('HOLD TO RETRY');
  await f.hold('failhold', 450);
  await expect.poll(presses).toEqual(['fail', 'failhold', 'failhold']);
  await expectVisual(page, 'failhold', 'failure');
});

test("a press begun on READY isn't sent if someone else's run started meanwhile (it would cancel theirs): ALREADY RUNNING", async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  await f.down('slow');
  // Another device starts it, and its run gets past the cancel grace while this finger is down.
  await demo(page, (b) => b.press('main', 'slow'));
  await expectVisual(page, 'slow', 'running');
  await page.waitForTimeout(800);
  await f.up();
  await expect(btn(page, 'slow')).toHaveAttribute('data-flash', 'already');
  await page.waitForTimeout(500);
  await expectVisual(page, 'slow', 'running');
  // Only the other device's press went to the host.
  expect(await presses()).toEqual(['slow']);
});

test('a config change that moves the button under a held finger cancels the hold', async ({ page }) => {
  await open(page);
  const presses = await trackPresses(page);
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  await edit(page, "cfg.pads[0].buttons.find((b) => b.id === 'hold').x = 3");
  await page.waitForTimeout(600);
  await f.up();
  await page.waitForTimeout(300);
  expect(await presses()).toEqual([]);
  await expectVisual(page, 'hold', 'ready');
  expect(await count(VIB.cancel)).toBe(1);
});

test('the outcome of a run still buzzes after switching to another pad', async ({ page }) => {
  await open(page);
  await f.tap('fail');
  await page.getByTestId('tab-ride').click();
  await expect(btn(page, 'pull')).toBeVisible();
  await expect.poll(() => count(VIB.failure)).toBe(1);
  // …and its tab says something failed there.
  await expect(page.getByTestId('tab-main')).toHaveAttribute('data-mark', 'failure');
  await page.getByTestId('tab-main').click();
  await expectVisual(page, 'fail', 'failure');
});

test('keep-awake turned off: the pad says the screen may sleep', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('sleepy')).toHaveCount(0);
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('toggle-awake').click();
  await expect(page.getByTestId('keep-awake')).toContainText('Off: the screen may go dark');
  await page.getByTestId('menu-close').click();
  await expect(page.getByTestId('sleepy')).toBeVisible();
});
