/** The important flows against a real host (one per spec file and project), real shell scripts. */
import { expect, test, type Page } from '@playwright/test';
import { btn, expectVisual, FLOW_CONFIG, Fingers } from './helpers.ts';
import { startHost, type Host } from './host.ts';

// One host for the whole file: run its tests in order in one worker.
test.describe.configure({ mode: 'default' });

let host: Host;

test.beforeAll(async () => {
  host = await startHost(FLOW_CONFIG);
});

test.afterAll(async () => {
  await host?.dispose();
});

async function open(page: Page, token = host.pressToken, query = '?pad=main') {
  await page.goto(`${host.url}/${query}#token=${token}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
}

test('pairing via #token: stored, stripped from the URL, live', async ({ page }) => {
  await open(page);
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => localStorage.getItem('buttpad.token'))).toBe(host.pressToken);
  await expectVisual(page, 'hold', 'ready');
  // The token persists: a plain reload reconnects.
  await page.goto(`${host.url}/?pad=main`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
});

test('a rejected token shows the re-pair screen', async ({ page }) => {
  await page.goto(`${host.url}/#token=not-a-real-token-at-all`);
  await expect(page.getByTestId('rejected')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('token-input').fill(`${host.url}/#token=${host.pressToken}`);
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
});

test('press role has no Edit entry; admin does', async ({ page }) => {
  await open(page);
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu')).toContainText('press only');
  await expect(page.getByTestId('menu-edit')).toHaveCount(0);
  await open(page, host.adminToken);
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu-edit')).toBeVisible();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-stub')).toBeVisible();
});

test('hold to fire runs the script: status, then success with its output', async ({ page, hasTouch }) => {
  await open(page);
  const f = new Fingers(page, hasTouch);
  await expectVisual(page, 'hold', 'ready');
  await f.down('hold');
  await expectVisual(page, 'hold', 'arming');
  await expectVisual(page, 'hold', 'running');
  await expect(btn(page, 'hold')).toContainText('working');
  await f.up();
  await expectVisual(page, 'hold', 'success');
  await expect(btn(page, 'hold')).toContainText('held ok');
  await expectVisual(page, 'hold', 'ready');
});

test('early release and tap/double triggers against the host', async ({ page, hasTouch }) => {
  await open(page);
  const f = new Fingers(page, hasTouch);
  await f.hold('hold', 120);
  await page.waitForTimeout(600);
  await expectVisual(page, 'hold', 'ready');
  await f.tap('tap');
  await expectVisual(page, 'tap', 'success');
  await f.tap('double');
  await page.waitForTimeout(80);
  await f.tap('double');
  await expectVisual(page, 'double', 'success');
});

test('failure: exit code and stderr', async ({ page, hasTouch }) => {
  await open(page);
  await new Fingers(page, hasTouch).tap('fail');
  await expectVisual(page, 'fail', 'failure');
  await expect(btn(page, 'fail')).toContainText('EXIT 2');
  await expect(btn(page, 'fail')).toContainText('disk full');
});

test('ignored press while running flashes BUSY; cancel kills the run', async ({ page, hasTouch }) => {
  await open(page);
  const f = new Fingers(page, hasTouch);
  await f.tap('slow');
  await expectVisual(page, 'slow', 'running');
  await f.tap('slow');
  await expect(btn(page, 'slow')).toHaveAttribute('data-flash', 'busy');
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'running');
  await expect(btn(page, 'cancel')).toContainText('%');
  await f.tap('cancel');
  await expectVisual(page, 'cancel', 'failure');
  await expect(btn(page, 'cancel')).toContainText('CANCELLED');
});

test('confirm and keyboard against the host', async ({ page, hasTouch }) => {
  await open(page);
  const f = new Fingers(page, hasTouch);
  await f.hold('confirm', 400);
  await expectVisual(page, 'confirm', 'confirm');
  await f.hold('confirm', 400);
  await expectVisual(page, 'confirm', 'success');
  await page.keyboard.press('t');
  await expectVisual(page, 'tap', 'running');
});

test('multi-client sync: a press on one device shows on another', async ({ page, browser, hasTouch }) => {
  await open(page);
  const other = await browser.newPage();
  await other.goto(`${host.url}/?pad=main#token=${host.pressToken}`);
  await expect(other.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await expectVisual(page, 'slow', 'ready', 8000);
  await new Fingers(page, hasTouch).tap('slow');
  await expectVisual(other, 'slow', 'running');
  await expect(btn(other, 'slow')).toContainText('busy');
  await expectVisual(other, 'slow', 'success', 6000);
  await expectVisual(page, 'slow', 'success');
  await other.close();
});

test('presses from outside the UI (HTTP API) show up live', async ({ page, request }) => {
  await open(page);
  await expectVisual(page, 'tap', 'ready', 4000);
  const r = await request.post(`${host.url}/api/press/main/tap`, { headers: { authorization: `Bearer ${host.pressToken}` } });
  expect((await r.json()).result).toBe('started');
  await expectVisual(page, 'tap', 'success');
});

test('a reload mid-run still shows the run (state comes from the host)', async ({ page, hasTouch }) => {
  await open(page);
  await expectVisual(page, 'slow', 'ready', 8000);
  await new Fingers(page, hasTouch).tap('slow');
  await expectVisual(page, 'slow', 'running');
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await expectVisual(page, 'slow', 'running');
  await expectVisual(page, 'slow', 'success', 6000);
});

test('host goes away: offline display; comes back: reconnects by itself', async ({ page, hasTouch }) => {
  await open(page);
  await host.stop();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'offline');
  await expectVisual(page, 'hold', 'offline');
  await expect(btn(page, 'tap')).toContainText('OFFLINE');
  await new Fingers(page, hasTouch).tap('tap');
  await expect(btn(page, 'tap')).toHaveAttribute('data-flash', 'denied');
  await host.start();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
  await expectVisual(page, 'tap', 'ready');
  await new Fingers(page, hasTouch).tap('tap');
  await expectVisual(page, 'tap', 'success');
});
