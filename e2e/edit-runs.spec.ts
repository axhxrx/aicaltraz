/**
 * Edit mode against a real host, around running things from the editor and what the host says
 * back: Run now on a confirm button asks first (and the press says it was confirmed), a running
 * button's Run now is never a silent cancel, Recent runs keep up while it runs and say what ran
 * and why it couldn't start, a save's warnings land on the right button, and a broken file's errors
 * open up in full. One host per file and project.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { startHost, type Host } from './host.ts';

// One host for the whole file: run its tests in order in one worker.
test.describe.configure({ mode: 'default' });

const CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 2,
      buttons: [
        { id: 'format', label: 'Format card', color: '#4338ca', x: 0, y: 0, trigger: 'tap', confirm: true, action: { type: 'shell', script: "echo formatted > formatted.txt; echo '@result formatted'" } },
        { id: 'render', label: 'Render', color: '#0891b2', x: 1, y: 0, trigger: 'tap', whileRunning: 'cancel', action: { type: 'shell', script: 'echo one; sleep 1.5; echo two; sleep 1.5; echo three; sleep 30' } },
        { id: 'slow', label: 'Slow', color: '#0d9488', x: 2, y: 0, trigger: 'tap', timeoutMs: 5000, action: { type: 'shell', script: "echo '@status busy'; sleep 30" } },
        { id: 'ghost', label: 'Ghost', color: '#7c3aed', x: 0, y: 1, trigger: 'tap', action: { type: 'exec', command: './no-such-program.sh', args: ['--now'] } },
      ],
    },
  ],
};

let host: Host;

test.beforeAll(async () => {
  host = await startHost(CONFIG);
});

test.afterAll(async () => {
  await host?.dispose();
});

const headers = () => ({ authorization: `Bearer ${host.adminToken}` });

// Every test starts from CONFIG (force: a test may leave the file broken on purpose).
test.beforeEach(async ({ request }) => {
  const { rev } = (await (await request.get(`${host.url}/api/config`, { headers: headers() })).json()) as { rev: string };
  expect((await request.put(`${host.url}/api/config`, { headers: headers(), data: { config: CONFIG, baseRev: rev, force: true } })).status()).toBe(200);
  rmSync(join(dirname(host.configPath), 'formatted.txt'), { force: true });
});

const item = (page: Page, id: string) => page.getByTestId(`edit-btn-${id}`);
const status = (page: Page) => page.getByTestId('edit-status');
const tap = async (page: Page, touch: boolean, testid: string) => (touch ? page.getByTestId(testid).tap() : page.getByTestId(testid).click());

async function edit(page: Page) {
  await page.goto(`${host.url}/?pad=main#token=${host.adminToken}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
}
async function runs(page: Page, touch: boolean, id: string) {
  await tap(page, touch, `edit-btn-${id}`);
  await expect(page.getByTestId('button-editor')).toBeVisible();
  await page.getByTestId('editor-tab-runs').click();
  await expect(page.getByTestId('run-log')).toBeVisible();
}
/** Every backend.press from now on: its pad/button and whether it said "confirmed". */
async function spyPresses(page: Page) {
  await page.evaluate(() => {
    type P = (pad: string, id: string, opts?: { confirm?: boolean }) => Promise<unknown>;
    const b = window.__buttpad!.backend as unknown as { press: P };
    const orig = b.press.bind(b);
    const w = window as unknown as { __presses: { id: string; confirm: boolean }[] };
    w.__presses = [];
    b.press = (pad, id, opts) => (w.__presses.push({ id, confirm: !!opts?.confirm }), orig(pad, id, opts));
  });
  return () => page.evaluate(() => (window as unknown as { __presses: { id: string; confirm: boolean }[] }).__presses.slice());
}

test('Run now on a confirm button asks first: Cancel runs nothing; yes runs it, as a confirmed press', async ({ page, hasTouch }) => {
  const formatted = join(dirname(host.configPath), 'formatted.txt');
  await edit(page);
  const presses = await spyPresses(page);
  await runs(page, hasTouch, 'format');
  await expect(page.getByTestId('run-hint')).toContainText('after you confirm');
  await page.getByTestId('run-test').click();
  const dialog = page.getByTestId('dialog-run-confirm');
  await expect(dialog).toContainText('Run “Format card” now?');
  // The safe way out has the focus: a stray Enter runs nothing.
  await expect(page.getByTestId('run-confirm-no')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await presses()).toEqual([]);
  expect(existsSync(formatted)).toBe(false);
  await page.getByTestId('run-test').click();
  await page.getByTestId('run-confirm-yes').click();
  await expect(page.getByTestId('run-item').first()).toContainText('OK · exit 0', { timeout: 8000 });
  expect(await presses()).toEqual([{ id: 'format', confirm: true }]);
  expect(existsSync(formatted)).toBe(true);

  // Unsaved changes: "Save & run" asks too, then saves and runs the saved version.
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-script').fill("echo v2 > formatted.txt; echo '@result formatted v2'");
  await page.getByTestId('editor-tab-runs').click();
  await page.getByTestId('run-save').click();
  await expect(page.getByTestId('dialog-run-confirm')).toContainText('Save, then run “Format card”?');
  await page.getByTestId('run-confirm-yes').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('run-item').first()).toContainText('formatted v2', { timeout: 8000 });
  expect((await presses()).at(-1)).toEqual({ id: 'format', confirm: true });
  expect(readFileSync(formatted, 'utf8').trim()).toBe('v2');
});

test("while it runs, Run now is never a silent cancel: it's “Cancel run” (whileRunning: cancel) or disabled; the list keeps up by itself", async ({ page, hasTouch }) => {
  await edit(page);
  await runs(page, hasTouch, 'render');
  await page.getByTestId('run-test').click();
  const cancel = page.getByTestId('run-cancel');
  await expect(cancel).toHaveText('Cancel run');
  await expect(page.getByTestId('run-test')).toHaveCount(0);
  // No Refresh pressed: the running run's output grows on screen.
  await expect(page.getByTestId('run-item').first()).toContainText('Running…');
  await expect(page.getByTestId('run-stdout').first()).toContainText('two', { timeout: 6000 });
  await cancel.click();
  await expect(page.getByTestId('run-item').first()).toContainText(/Cancelled|Stopped/, { timeout: 8000 });
  await expect(page.getByTestId('run-test')).toHaveText('Run now');

  await runs(page, hasTouch, 'slow');
  await page.getByTestId('run-test').click();
  await expect(page.getByTestId('run-test')).toHaveText('Running…');
  await expect(page.getByTestId('run-test')).toBeDisabled();
  await expect(page.getByTestId('run-cancel')).toHaveCount(0);
  await expect(page.getByTestId('run-hint')).toContainText('a press would be ignored');
  await expect(page.getByTestId('run-item').first()).toContainText('Timed out', { timeout: 10_000 });
  await expect(page.getByTestId('run-test')).toBeEnabled();
});

test("a program that can't start: the run says why, what ran and in which folder", async ({ page, hasTouch }) => {
  await edit(page);
  await runs(page, hasTouch, 'ghost');
  await page.getByTestId('run-test').click();
  const run = page.getByTestId('run-item').first();
  await expect(run).toContainText("Couldn't start", { timeout: 8000 });
  await expect(page.getByTestId('run-error')).toContainText('no-such-program');
  await expect(page.getByTestId('run-command')).toContainText('no-such-program.sh --now');
  await expect(page.getByTestId('run-cwd')).toHaveText(dirname(host.configPath));
});

test("a save's warnings (non-blocking) show after it, on the button they're about, until it changes", async ({ page, hasTouch }) => {
  await edit(page);
  await tap(page, hasTouch, 'edit-btn-format');
  await page.getByTestId('field-label').fill('Format SD card');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('toast')).toContainText('Saved, with 1 warning');
  const notice = page.getByTestId('notice-warnings');
  // The host checks what a press would run into: Ghost's program isn't there.
  await expect(notice.getByTestId('warning-item')).toHaveText(`Main › “Ghost” · Command: not found: ${join(dirname(host.configPath), 'no-such-program.sh')}`);
  await expect(item(page, 'ghost').getByTestId('warned-badge')).toBeVisible();
  await expect(item(page, 'format').getByTestId('warned-badge')).toHaveCount(0);
  // It points at the button and the field.
  await notice.getByTestId('warning-item').click();
  await expect(page.getByTestId('field-command')).toHaveValue('./no-such-program.sh');
  await expect(page.getByTestId('warning-button')).toContainText('Command: not found');
  await page.getByTestId('editor-tab-button').click();
  await expect(page.getByTestId('warning-button')).toBeVisible();
  // Fixed (changed): the warning is history.
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-command').fill('/bin/echo');
  await expect(page.getByTestId('warning-button')).toHaveCount(0);
  await expect(item(page, 'ghost').getByTestId('warned-badge')).toHaveCount(0);
  await page.getByTestId('warnings-dismiss').click();
  await expect(notice).toHaveCount(0);
  // Saved again with nothing to warn about: no notice, no toast about warnings.
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('toast')).toContainText('Saved: live on every device now');
  await expect(notice).toHaveCount(0);
});

type Json = { pads: { buttons: Record<string, unknown>[] }[] };

test("a broken config file's errors: “+N more” opens the whole list (notice and the replace dialog)", async ({ page }) => {
  await edit(page);
  const cfg = JSON.parse(readFileSync(host.configPath, 'utf8')) as Json;
  const [a, b, c, d] = cfg.pads[0]!.buttons as Record<string, unknown>[];
  Object.assign(a!, { holdMs: 1 });
  Object.assign(b!, { trigger: 'squeeze', resultHoldMs: -5 });
  Object.assign(c!, { color: 5 });
  Object.assign(d!, { w: 0 });
  writeFileSync(host.configPath, JSON.stringify(cfg, null, 2));
  const notice = page.getByTestId('notice-file-errors');
  await expect(notice).toBeVisible();
  const more = notice.getByTestId('file-errors-more');
  await expect(more).toHaveText(/^\+\d+ more$/);
  const n = Number(/\d+/.exec((await more.textContent()) ?? '')![0]);
  expect(n).toBeGreaterThanOrEqual(4);
  await more.click();
  await expect(notice.getByTestId('file-errors-list').locator('li')).toHaveCount(n);
  await expect(more).toHaveCount(0);
  // Saving asks before replacing the file: its list opens up too.
  await page.getByTestId('edit-save').click();
  const dialog = page.getByTestId('dialog-broken');
  await expect(dialog.getByTestId('broken-more')).toHaveText(`+${n + 1 - 3} more`);
  await dialog.getByTestId('broken-more').click();
  await expect(dialog.getByTestId('broken-errors').locator('li')).toHaveCount(n + 1);
  await page.getByTestId('broken-cancel').click();
});
