/**
 * Edit mode against a real host (one per spec file and project): saves land in the config file,
 * hand edits under a clean/dirty draft, 409 conflicts, host validation errors, network errors,
 * run logs, and the press role never seeing any of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn } from './helpers.ts';
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
        { id: 'boom', label: 'Boom', color: '#f97316', x: 1, y: 0, trigger: 'tap', resultHoldMs: 500, action: { type: 'shell', script: "echo '@status trying'; echo 'boom: disk on fire' >&2; exit 3" } },
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

// Every test starts from CONFIG, put through the API so the host and its clients agree.
test.beforeEach(async ({ request }) => {
  const headers = { authorization: `Bearer ${host.adminToken}` };
  let status = 0;
  // 409 = a hand edit landed between the GET and the PUT: take the new rev and go again.
  for (let i = 0; i < 3 && status !== 200; i++) {
    const { rev } = (await (await request.get(`${host.url}/api/config`, { headers })).json()) as { rev: string };
    status = (await request.put(`${host.url}/api/config`, { headers, data: { config: CONFIG, baseRev: rev } })).status();
  }
  expect(status).toBe(200);
});

type Json = { pads: { id: string; buttons: Record<string, unknown>[] }[] };
const disk = () => JSON.parse(readFileSync(host.configPath, 'utf8')) as Json;
/** Someone with a text editor on the host. */
function handEdit(fn: (cfg: Json) => void) {
  const cfg = disk();
  fn(cfg);
  writeFileSync(host.configPath, JSON.stringify(cfg, null, 2));
}

const item = (page: Page, id: string) => page.getByTestId(`edit-btn-${id}`);
const status = (page: Page) => page.getByTestId('edit-status');

async function edit(page: Page) {
  await page.goto(`${host.url}/?pad=main#token=${host.adminToken}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
}

async function select(page: Page, touch: boolean, id: string) {
  if (touch) await item(page, id).tap();
  else await item(page, id).click();
  await expect(page.getByTestId('button-editor')).toBeVisible();
}

test('press role: no edit entry, no edit UI, no actions on the wire', async ({ page }) => {
  await page.goto(`${host.url}/?pad=main#token=${host.pressToken}`);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu')).toContainText('press only');
  await expect(page.getByTestId('menu-edit')).toHaveCount(0);
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  const actions = await page.evaluate(() => window.__buttpad!.backend.snapshot.get().config!.pads.flatMap((p) => p.buttons.map((b) => b.action ?? null)));
  expect(actions).toEqual([null, null]);
  const runs = await page.evaluate(() => window.__buttpad!.backend.runs().then(() => 'allowed', (e: Error) => e.message));
  expect(runs).toBe('HTTP 403');
});

test('edit a label and the action, add a button, save: the config file has it', async ({ page, hasTouch }) => {
  await edit(page);
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Desk lamp');
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-script').fill("echo 'desk lamp on'");
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('toast')).toContainText('Saved');
  const lamp = disk().pads[0]!.buttons[0]!;
  expect(lamp).toMatchObject({ id: 'lamp', label: 'Desk lamp', trigger: 'tap', action: { type: 'shell', script: "echo 'desk lamp on'" } });
  // Written compactly: defaults are left out.
  expect(lamp.holdMs).toBeUndefined();

  const empty = page.getByTestId('cell-2-1');
  if (hasTouch) await empty.tap();
  else await empty.click();
  await page.getByTestId('field-label').fill('Fan');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(disk().pads[0]!.buttons[2]).toMatchObject({ id: 'fan', label: 'Fan', x: 2, y: 1, action: { type: 'shell' } });

  await page.getByTestId('edit-close').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(btn(page, 'lamp')).toContainText('Desk lamp');
  await expect(btn(page, 'fan')).toBeVisible();
});

test('host config changes: adopted silently while clean, a notice while dirty', async ({ page, hasTouch }) => {
  await edit(page);
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Boom!'));
  await expect(item(page, 'boom')).toContainText('Boom!');
  await expect(page.getByTestId('notice-host-changed')).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'clean');

  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Mine');
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Boom again'));
  await expect(page.getByTestId('notice-host-changed')).toBeVisible();
  // The draft is left alone.
  await expect(item(page, 'boom')).toContainText('Boom!');
  await expect(page.getByTestId('field-label')).toHaveValue('Mine');
  await page.getByTestId('host-changed-load').click();
  await expect(item(page, 'boom')).toContainText('Boom again');
  await expect(item(page, 'lamp')).toContainText('Lamp');
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
});

test('409 conflict: the file changed under a dirty draft → load theirs, or overwrite with mine', async ({ page, hasTouch }) => {
  await edit(page);
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Mine');
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Theirs'));
  await expect(page.getByTestId('notice-host-changed')).toBeVisible();
  await page.getByTestId('edit-save').click();
  const dialog = page.getByTestId('dialog-conflict');
  await expect(dialog).toContainText('hand');
  await page.getByTestId('conflict-theirs').click();
  await expect(dialog).toHaveCount(0);
  await expect(item(page, 'boom')).toContainText('Theirs');
  await expect(item(page, 'lamp')).toContainText('Lamp');
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect(disk().pads[0]!.buttons[0]!.label).toBe('Lamp');

  // Again, and this time keep mine.
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Mine again');
  handEdit((c) => (c.pads[0]!.buttons[1]!.label = 'Theirs again'));
  await expect(page.getByTestId('notice-host-changed')).toBeVisible();
  await page.getByTestId('edit-save').click();
  await page.getByTestId('conflict-mine').click();
  await expect(dialog).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  const [lamp, boom] = disk().pads[0]!.buttons;
  expect(lamp!.label).toBe('Mine again');
  expect(boom!.label).toBe('Theirs');
});

test('validation errors from the host point at the offending button and field', async ({ page, hasTouch }) => {
  await edit(page);
  // A host stricter than this client (another version, say): the 400 is shown as it comes.
  await page.route('**/api/config', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ errors: ['pads.0.buttons.1.action.script: scripts may not "exit" here', 'pads.0.buttons.1: button "boom" is not allowed'] }),
        })
      : route.continue(),
  );
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Lamp 2');
  await page.getByTestId('edit-save').click();
  const notice = page.getByTestId('notice-problems');
  await expect(notice).toContainText('The host refused to save: 2 problems');
  await expect(notice).toContainText('Main › “Boom” · Script: scripts may not "exit" here');
  await expect(item(page, 'boom')).toHaveClass(/has-problem/);
  // It jumped to the first problem: Boom's action, with the message under the script.
  await expect(page.getByTestId('field-script')).toBeVisible();
  await expect(page.getByTestId('error-script')).toHaveText('scripts may not "exit" here');
  await expect(page.getByTestId('error-button')).toHaveText('button "boom" is not allowed');
  await expect(status(page)).toHaveAttribute('data-state', 'problems');
  expect(disk().pads[0]!.buttons[0]!.label).toBe('Lamp');
});

test('a network error keeps the draft; trying again saves it', async ({ page, hasTouch }) => {
  await edit(page);
  await page.route('**/api/config', (route) => (route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.continue()));
  await select(page, hasTouch, 'lamp');
  await page.getByTestId('field-label').fill('Through the outage');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('notice-save-error')).toContainText("Couldn't save");
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('field-label')).toHaveValue('Through the outage');
  await page.unroute('**/api/config');
  await page.getByTestId('save-retry').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('notice-save-error')).toHaveCount(0);
  expect(disk().pads[0]!.buttons[0]!.label).toBe('Through the outage');
});

test("recent runs show a failed run's exit code and stderr", async ({ page, hasTouch }) => {
  await edit(page);
  await select(page, hasTouch, 'boom');
  await page.getByTestId('editor-tab-runs').click();
  const log = page.getByTestId('run-log');
  await expect(log).toBeVisible();
  await page.getByTestId('run-test').click();
  const run = page.getByTestId('run-item').first();
  await expect(run).toContainText('Exit 3');
  await expect(run).toContainText('boom: disk on fire');
  await expect(page.getByTestId('run-stderr').first()).toHaveText('boom: disk on fire');
  await expect(page.getByTestId('run-stdout').first()).toHaveText('@status trying');
  // A button that isn't on the host yet has no runs to show.
  const empty = page.getByTestId('cell-2-0');
  if (hasTouch) await empty.tap();
  else await empty.click();
  // New buttons open on their Button tab.
  await expect(page.getByTestId('field-label')).toHaveValue('Button 3');
  await page.getByTestId('editor-tab-runs').click();
  await expect(log).toContainText("isn't on the host yet");
  await expect(page.getByTestId('run-test')).toBeDisabled();
});
