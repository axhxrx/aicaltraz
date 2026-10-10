/**
 * Edit mode staying in step with a real host when things go wrong: lost or hung save answers, a
 * lagging socket, a broken config file, saves that would stop running actions, reused ids, and a
 * draft that must survive reloads, token rotation and pairing links. One host per file and project.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import type { RunRecord } from '../src/core/protocol.ts';
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
        { id: 'lamp', label: 'Lamp', x: 0, y: 0, trigger: 'tap', action: { type: 'shell', script: "echo 'lamp toggled'" } },
        { id: 'boom', label: 'Boom', color: '#f97316', x: 1, y: 0, trigger: 'tap', resultHoldMs: 500, action: { type: 'shell', script: 'echo boom' } },
        { id: 'record', label: 'Record', color: '#0891b2', x: 2, y: 0, trigger: 'tap', timeoutMs: 120_000, action: { type: 'shell', script: "echo '@status recording'; sleep 60; echo done" } },
      ],
    },
    {
      id: 'other',
      name: 'Other',
      cols: 2,
      rows: 2,
      buttons: [
        { id: 'solo', label: 'Solo', x: 0, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo solo' } },
        { id: 'button-2', label: 'Wipe card', color: '#c026d3', x: 1, y: 0, confirm: true, action: { type: 'shell', script: 'echo WIPED > wiped.txt; echo "@result card wiped"' } },
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
});

type Json = { pads: { id: string; name: string; buttons: Record<string, unknown>[] }[] };
const disk = () => JSON.parse(readFileSync(host.configPath, 'utf8')) as Json;
const labels = (pad = 0) => disk().pads[pad]!.buttons.map((b) => b.label);
/** Someone with a text editor on the host. */
function handEdit(fn: (cfg: Json) => void) {
  const cfg = disk();
  fn(cfg);
  writeFileSync(host.configPath, JSON.stringify(cfg, null, 2));
}

const item = (page: Page, id: string) => page.getByTestId(`edit-btn-${id}`);
const status = (page: Page) => page.getByTestId('edit-status');
const tap = async (page: Page, touch: boolean, testid: string) => (touch ? page.getByTestId(testid).tap() : page.getByTestId(testid).click());

async function open(page: Page, token = host.adminToken) {
  await page.goto(`${host.url}/?pad=main#token=${token}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
}
async function edit(page: Page) {
  await open(page);
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
}
async function select(page: Page, touch: boolean, id: string) {
  await tap(page, touch, `edit-btn-${id}`);
  await expect(page.getByTestId('button-editor')).toBeVisible();
}
async function relabel(page: Page, touch: boolean, id: string, label: string) {
  await select(page, touch, id);
  await page.getByTestId('field-label').fill(label);
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem(`buttpad.draft:${location.origin}`) ?? 'null') as { draft: Json } | null);

/** Config frames from the host reach this page late (`delay` ms) or never (`hold`); everything else passes. */
async function lagSocket(page: Page) {
  const lag = { delay: 0, hold: false };
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      let t: unknown;
      try {
        t = (JSON.parse(String(m)) as { t?: string }).t;
      } catch {}
      if (t === 'config' && lag.hold) return;
      if (t === 'config' && lag.delay) setTimeout(() => ws.send(m), lag.delay);
      else ws.send(m);
    });
    ws.onMessage((m) => server.send(m));
  });
  return lag;
}

test('a committed save whose answer is lost counts as saved: no error, no false "changed on the host", no 409 next time', async ({ page, hasTouch }) => {
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Lamp v2');
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fetch(); // the host gets it and writes the file…
    await route.abort('connectionreset'); // …and the answer never makes it back
  });
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('toast')).toContainText('Saved');
  await expect(page.getByTestId('notice-save-error')).toHaveCount(0);
  await expect(page.getByTestId('notice-host-changed')).toHaveCount(0);
  expect(labels()[0]).toBe('Lamp v2');

  // Even when the check over HTTP fails too, the socket's echo settles it.
  await page.getByTestId('field-label').fill('Lamp v3');
  await page.unroute('**/api/config');
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.abort('connectionreset');
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('notice-save-error')).toHaveCount(0);
  await page.unroute('**/api/config');
  await page.getByTestId('field-label').fill('Lamp v4');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('dialog-conflict')).toHaveCount(0);
  expect(labels()[0]).toBe('Lamp v4');
});

test("two quick saves on a lagging socket: their late echoes aren't news (no revert, no lost undo, no notice, no 409)", async ({ page, hasTouch }) => {
  const lag = await lagSocket(page);
  await edit(page);
  lag.delay = 2000;
  await relabel(page, hasTouch, 'lamp', 'Lamp v2');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await relabel(page, hasTouch, 'boom', 'Boom v2');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  // Both echoes land meanwhile.
  await page.waitForTimeout(2600);
  await expect(item(page, 'boom')).toContainText('Boom v2');
  await expect(item(page, 'lamp')).toContainText('Lamp v2');
  await expect(page.getByTestId('edit-undo')).toBeEnabled();
  await expect(page.getByTestId('notice-host-changed')).toHaveCount(0);
  lag.delay = 0;
  await relabel(page, hasTouch, 'lamp', 'Lamp v3');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('dialog-conflict')).toHaveCount(0);
  expect(labels()).toEqual(['Lamp v3', 'Boom v2', 'Record']);
});

test('a save that never gets an answer gives up after 10 s, asks the host whether it landed, and the editor works again', async ({ page, hasTouch }) => {
  test.setTimeout(75_000);
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Lamp v2');
  // The link dies mid-request: no answer, no reset.
  await page.route('**/api/config', (route) => (route.request().method() === 'PUT' ? undefined : route.continue()));
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-save')).toHaveText('Saving…');
  await expect(page.getByTestId('notice-save-error')).toContainText("the host didn't answer within 10 s", { timeout: 20_000 });
  await expect(page.getByTestId('edit-save')).toBeEnabled();
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  expect(labels()[0]).toBe('Lamp');
  await page.unroute('**/api/config');
  await page.getByTestId('save-retry').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(labels()[0]).toBe('Lamp v2');

  // It did land, only its answer hangs: after the timeout the check finds it saved.
  await page.getByTestId('field-label').fill('Lamp v3');
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fetch(); // written; the answer never comes
  });
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean', { timeout: 20_000 });
  await expect(page.getByTestId('notice-save-error')).toHaveCount(0);
  expect(labels()[0]).toBe('Lamp v3');
});

test('a broken config file on the host (a typo, or caught mid-write) is replaced only when the user says so', async ({ page, hasTouch }) => {
  await edit(page);
  const good = readFileSync(host.configPath, 'utf8');
  // Someone is halfway through a hand edit: the file is cut off right now.
  const broken = good.slice(0, -40);
  writeFileSync(host.configPath, broken);
  await expect(page.getByTestId('notice-file-errors')).toBeVisible();
  // Nothing unsaved, but Save would write over it: it asks first.
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('dialog-broken')).toContainText('invalid JSON');
  await expect(page.getByTestId('broken-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialog-broken')).toHaveCount(0);
  expect(readFileSync(host.configPath, 'utf8')).toBe(broken);

  // Fixed by hand, then broken again just before a save goes out: the host's 409 says so.
  writeFileSync(host.configPath, good);
  await expect(page.getByTestId('notice-file-errors')).toHaveCount(0);
  await relabel(page, hasTouch, 'lamp', 'Mine');
  writeFileSync(host.configPath, broken);
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('dialog-broken')).toContainText('invalid JSON');
  expect(readFileSync(host.configPath, 'utf8')).toBe(broken);
  await page.getByTestId('broken-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(labels()[0]).toBe('Mine');
  await expect(page.getByTestId('notice-file-errors')).toHaveCount(0);
});

test('saving asks before it stops a running action (renamed pad); the canvas shows what runs', async ({ page, request }) => {
  expect((await (await request.post(`${host.url}/api/press/main/record`, { headers: headers() })).json()).result).toBe('started');
  await edit(page);
  await expect(item(page, 'record').getByTestId('running-badge')).toBeVisible();
  await expect(item(page, 'lamp').getByTestId('running-badge')).toHaveCount(0);
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-id').fill('studio');
  await expect(page.getByTestId('pad-id-warning')).toContainText('?pad=main');
  // Still running under its host id: the badge stays.
  await expect(item(page, 'record').getByTestId('running-badge')).toBeVisible();
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('stop-list')).toContainText('“Record” (running');
  await expect(page.getByTestId('stop-cancel')).toBeFocused();
  await page.getByTestId('stop-cancel').click();
  expect(disk().pads[0]!.id).toBe('main');
  await page.getByTestId('edit-save').click();
  await page.getByTestId('stop-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(disk().pads[0]!.id).toBe('studio');
  await expect
    .poll(async () => ((await (await request.get(`${host.url}/api/runs?pad=main&button=record`, { headers: headers() })).json()) as RunRecord[])[0]?.reason)
    .toBe('cancelled');
});

test('a new button never takes the id of a deleted host button; unsaved ones get "Save & run", which runs the saved version', async ({ page, hasTouch }) => {
  const wiped = join(dirname(host.configPath), 'wiped.txt');
  await edit(page);
  await tap(page, hasTouch, 'edit-tab-other');
  await select(page, hasTouch, 'button-2');
  await page.getByTestId('editor-delete').click();
  await tap(page, hasTouch, 'cell-1-0');
  await expect(page.getByTestId('field-id')).toHaveValue('button-3');
  await page.getByTestId('editor-tab-runs').click();
  await expect(page.getByTestId('run-test')).toHaveCount(0);
  await page.getByTestId('run-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('run-item').first()).toContainText('OK · exit 0', { timeout: 8000 });
  // It ran the new button: the deleted "Wipe card" never did.
  expect(existsSync(wiped)).toBe(false);
  // A changed (unsaved) button on the host: no "Run now" either, it would run the old version.
  await select(page, hasTouch, 'solo');
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-script').fill('echo solo v2');
  await page.getByTestId('editor-tab-runs').click();
  await expect(page.getByTestId('run-test')).toHaveCount(0);
  await expect(page.getByTestId('run-log')).toContainText('Run now would run the old one');
  await page.getByTestId('run-save').click();
  await expect(page.getByTestId('run-item').first()).toContainText('solo v2', { timeout: 8000 });
  await expect(page.getByTestId('run-test')).toBeVisible();
});

test('the draft survives leaving the page; reopening offers it back, merged with what changed on the host meanwhile', async ({ page, hasTouch }) => {
  page.on('dialog', (d) => void d.accept()); // "leave the page?"
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Lamp (an hour of work)');
  await tap(page, hasTouch, 'cell-0-1');
  await page.getByTestId('field-label').fill('Fan');
  await expect.poll(async () => (await stored(page))?.draft.pads[0]!.buttons.length).toBe(4);
  await page.goto('about:blank');
  // While the page is gone, someone fixes a typo by hand.
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Boom (by hand)'));
  await edit(page);
  await expect(page.getByTestId('dialog-restore')).toContainText('Restore unsaved changes from');
  await expect(page.getByTestId('restore-yes')).toBeFocused();
  await page.getByTestId('restore-yes').click();
  await expect(item(page, 'lamp')).toContainText('Lamp (an hour of work)');
  await expect(item(page, 'fan')).toBeVisible();
  await expect(item(page, 'boom')).toContainText('Boom (by hand)');
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(labels()).toEqual(['Lamp (an hour of work)', 'Boom (by hand)', 'Record', 'Fan']);
  // Saved: nothing is kept, nothing offered.
  expect(await stored(page)).toBeNull();
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
  await expect(page.getByTestId('dialog-restore')).toHaveCount(0);
});

test('a rotated token (401) unmounts the editor, but the draft is offered back after pairing again', async ({ page, hasTouch }) => {
  test.setTimeout(60_000);
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Before the rotation');
  await expect.poll(async () => (await stored(page))?.draft.pads[0]!.buttons[0]!.label).toBe('Before the rotation');
  await host.stop();
  await host.start({ rotateTokens: true });
  await expect(page.getByTestId('rejected')).toBeVisible({ timeout: 20_000 });
  // The new pairing link, opened in this tab.
  await page.evaluate((t) => (location.hash = `#token=${t}`), host.adminToken);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
  await expect(page.getByTestId('draft-banner')).toContainText('Unsaved edits');
  await page.getByTestId('draft-banner-open').click();
  await page.getByTestId('restore-yes').click();
  await expect(item(page, 'lamp')).toContainText('Before the rotation');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(labels()[0]).toBe('Before the rotation');
});

test('a pairing link opened in this tab while the draft is dirty asks first; the draft stays on the device either way', async ({ page, hasTouch }) => {
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Unsaved');
  await page.evaluate((t) => (location.hash = `#token=${t}`), host.pressToken);
  await expect(page.getByTestId('dialog-switch')).toBeVisible();
  await expect(page.getByTestId('switch-no')).toBeFocused();
  await page.getByTestId('switch-no').click();
  await expect(page.getByTestId('field-label')).toHaveValue('Unsaved');
  expect(await page.evaluate(() => localStorage.getItem('buttpad.token'))).toBe(host.adminToken);
  await page.evaluate((t) => (location.hash = `#token=${t}`), host.pressToken);
  await page.getByTestId('switch-yes').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  expect((await stored(page))?.draft.pads[0]!.buttons[0]!.label).toBe('Unsaved');
});

test('with a stalled socket, "Merge" works from the host\'s config fetched fresh, not the stale broadcast', async ({ page, hasTouch }) => {
  const lag = await lagSocket(page);
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Mine');
  lag.hold = true; // config frames stop reaching the page (pings still answered)
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Theirs'));
  await page.waitForTimeout(600);
  await expect(item(page, 'boom')).toContainText('Boom');
  await page.getByTestId('edit-save').click();
  await page.getByTestId('conflict-merge').click();
  await expect(page.getByTestId('toast')).toContainText('Merged 1 change from the host');
  await expect(item(page, 'boom')).toContainText('Theirs');
  await expect(item(page, 'lamp')).toContainText('Mine');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(labels()).toEqual(['Mine', 'Theirs', 'Record']);
});

test('a button added while a save is in flight keeps following its label', async ({ page, hasTouch }) => {
  await edit(page);
  await relabel(page, hasTouch, 'lamp', 'Lamp v2');
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const r = await route.fetch();
    await new Promise((res) => setTimeout(res, 1500));
    await route.fulfill({ response: r });
  });
  await page.getByTestId('edit-save').click();
  await tap(page, hasTouch, 'cell-0-1');
  await page.getByTestId('field-label').fill('Fi');
  await expect(page.getByTestId('toast')).toContainText('Saved', { timeout: 5000 });
  await page.getByTestId('field-label').fill('Fill light');
  await expect(page.getByTestId('field-id')).toHaveValue('fill-light');
});

test('a config over 1 MB says so in words', async ({ page, hasTouch }) => {
  await edit(page);
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-script').fill(`# ${'x'.repeat(1100 * 1024)}\necho hi`);
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('notice-save-error')).toContainText('config too large (max 1 MB)');
  await expect(page.getByTestId('notice-save-error')).not.toContainText('HTTP 413');
});
