/**
 * Edit mode against the in-browser demo backend: canvas gestures (CDP touch on the phone project,
 * the mouse on desktop), the button editor, pads, undo/redo, client-side validation, saving.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, seedDemo } from './helpers.ts';

/**
 *   [alpha][beta ][  .  ]
 *   [gamma  gamma][  .  ]      + pad "Second" (2×2, one button)
 *   [  .  ][  .  ][  .  ]
 */
const CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 3,
      buttons: [
        { id: 'alpha', label: 'Alpha', color: '#2f6fde', x: 0, y: 0, action: { type: 'shell', script: 'echo alpha' } },
        { id: 'beta', label: 'Beta', color: '#db2777', x: 1, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo beta' } },
        { id: 'gamma', label: 'Gamma', color: '#7c3aed', x: 0, y: 1, w: 2, action: { type: 'exec', command: 'echo', args: ['gamma'] } },
      ],
    },
    { id: 'second', name: 'Second', cols: 2, rows: 2, buttons: [{ id: 'solo', label: 'Solo', x: 0, y: 0, action: { type: 'shell', script: 'echo solo' } }] },
  ],
};

type Pt = { x: number; y: number };

/** One finger (CDP touch) on touch projects, the mouse otherwise. */
class Pointer {
  private cdp: CDPSession | null = null;
  private at: Pt = { x: 0, y: 0 };
  constructor(
    private readonly page: Page,
    private readonly touch: boolean,
  ) {}
  private async touchEvent(type: 'touchStart' | 'touchMove' | 'touchEnd', p?: Pt) {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ id: 1, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 }] : [] });
  }
  async down(p: Pt) {
    this.at = p;
    if (this.touch) await this.touchEvent('touchStart', p);
    else (await this.page.mouse.move(p.x, p.y), await this.page.mouse.down());
  }
  async moveTo(p: Pt, steps = 6) {
    const a = this.at;
    for (let i = 1; i <= steps; i++) {
      const q = { x: a.x + ((p.x - a.x) * i) / steps, y: a.y + ((p.y - a.y) * i) / steps };
      if (this.touch) await this.touchEvent('touchMove', q);
      else await this.page.mouse.move(q.x, q.y);
    }
    this.at = p;
  }
  async up() {
    if (this.touch) await this.touchEvent('touchEnd');
    else await this.page.mouse.up();
  }
  async tap(p: Pt) {
    await this.down(p);
    await this.page.waitForTimeout(30);
    await this.up();
  }
  async drag(from: Pt, to: Pt) {
    await this.down(from);
    await this.moveTo(to);
    await this.up();
  }
}

const item = (page: Page, id: string) => page.getByTestId(`edit-btn-${id}`);
const cell = (page: Page, x: number, y: number) => page.getByTestId(`cell-${x}-${y}`);

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
}
const center = async (l: Locator): Promise<Pt> => {
  const b = await box(l);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const cornerOf = async (l: Locator): Promise<Pt> => {
  const b = await box(l);
  return { x: b.x + b.width - 2, y: b.y + b.height - 2 };
};

async function expectRect(l: Locator, r: { x: number; y: number; w: number; h: number }) {
  for (const k of ['x', 'y', 'w', 'h'] as const) await expect(l).toHaveAttribute(`data-${k}`, String(r[k]));
}

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('buttpad.demo.config') ?? 'null'));
const status = (page: Page) => page.getByTestId('edit-status');

let p: Pointer;

test.beforeEach(async ({ page, hasTouch }) => {
  await seedDemo(page, CONFIG);
  await page.goto('/?demo&exact&pad=main');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-mode')).toBeVisible();
  p = new Pointer(page, hasTouch);
});

test('the canvas shows the real faces over visible cells', async ({ page }) => {
  await expect(page.locator('.ed-cell')).toHaveCount(9);
  await expect(page.locator('.ed-cell.is-empty')).toHaveCount(5);
  await expect(btn(page, 'alpha')).toHaveAttribute('data-visual', 'ready');
  await expect(btn(page, 'beta')).toContainText('TAP');
  await expectRect(item(page, 'gamma'), { x: 0, y: 1, w: 2, h: 1 });
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('edit-save')).toBeDisabled();
});

test('tapping an empty cell adds a button there and opens its editor', async ({ page }) => {
  await p.tap(await center(cell(page, 2, 0)));
  const b = item(page, 'button-4');
  await expectRect(b, { x: 2, y: 0, w: 1, h: 1 });
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('button-editor')).toBeVisible();
  await expect(page.getByTestId('field-label')).toHaveValue('Button 4');
  await expect(btn(page, 'button-4')).toHaveAttribute('data-visual', 'ready');
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('edit-save')).toBeEnabled();
  // A new button's id follows its label (until saved or typed by hand).
  await page.getByTestId('field-label').fill('Desk lamp');
  await expect(item(page, 'desk-lamp')).toBeVisible();
  await expect(page.getByTestId('field-id')).toHaveValue('desk-lamp');
});

test('dragging a button moves it, snapping to cells, with a live preview', async ({ page }) => {
  const from = await center(item(page, 'alpha'));
  const to = await center(cell(page, 2, 2));
  await p.down(from);
  await p.moveTo(to);
  // Live preview: it already shows at the candidate cell while the finger is down.
  await expect(item(page, 'alpha')).toHaveAttribute('data-drag', 'move');
  await expectRect(item(page, 'alpha'), { x: 2, y: 2, w: 1, h: 1 });
  await expect(page.locator('.ed-ghost')).toHaveCount(1);
  await p.up();
  await expect(item(page, 'alpha')).not.toHaveAttribute('data-drag');
  await expectRect(item(page, 'alpha'), { x: 2, y: 2, w: 1, h: 1 });
  await expect(cell(page, 0, 0)).toHaveClass(/is-empty/);
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
});

test('dragging the corner handle resizes', async ({ page }) => {
  await p.tap(await center(item(page, 'beta')));
  await expect(page.getByTestId('button-editor')).toBeVisible();
  const handle = page.getByTestId('resize-handle');
  await p.down(await center(handle));
  await p.moveTo(await cornerOf(cell(page, 2, 0)));
  await expect(item(page, 'beta')).toHaveAttribute('data-drag', 'resize');
  await expect(item(page, 'beta')).toContainText('2 × 1');
  await p.up();
  await expectRect(item(page, 'beta'), { x: 1, y: 0, w: 2, h: 1 });
  // Smaller again.
  await p.drag(await center(handle), await cornerOf(cell(page, 1, 0)));
  await expectRect(item(page, 'beta'), { x: 1, y: 0, w: 1, h: 1 });
  // Gamma grows into the free cell on its right.
  await p.tap(await center(item(page, 'gamma')));
  await p.drag(await center(handle), await cornerOf(cell(page, 2, 1)));
  await expectRect(item(page, 'gamma'), { x: 0, y: 1, w: 3, h: 1 });
});

test('overlap and out-of-bounds are refused: red while dragging, then it snaps back', async ({ page }) => {
  await p.down(await center(item(page, 'alpha')));
  await p.moveTo(await center(item(page, 'beta')));
  await expect(item(page, 'alpha')).toHaveAttribute('data-refused', 'overlap');
  await expect(item(page, 'alpha').locator('.ed-refuse')).toHaveText('Overlaps “Beta”');
  await p.up();
  await expect(page.getByTestId('toast')).toContainText('overlaps “Beta”');
  await expectRect(item(page, 'alpha'), { x: 0, y: 0, w: 1, h: 1 });
  await expect(item(page, 'alpha')).not.toHaveAttribute('data-refused');

  await p.tap(await center(item(page, 'gamma')));
  await expect(page.getByTestId('button-editor')).toBeVisible();
  const h = await center(page.getByTestId('resize-handle'));
  const pitch = (await box(cell(page, 1, 0))).x - (await box(cell(page, 0, 0))).x;
  await p.down(h);
  await p.moveTo({ x: h.x + pitch * 2, y: h.y });
  await expect(item(page, 'gamma')).toHaveAttribute('data-refused', 'bounds');
  await expect(item(page, 'gamma').locator('.ed-refuse')).toHaveText('Outside the 3×3 grid');
  await p.up();
  await expect(page.getByTestId('toast')).toContainText('outside the 3×3 grid');
  await expectRect(item(page, 'gamma'), { x: 0, y: 1, w: 2, h: 1 });
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
});

test('keyboard: arrows move, Shift+arrows resize, Delete removes, Esc deselects, Ctrl/Cmd+Z undo', async ({ page, hasTouch }) => {
  test.skip(hasTouch, 'desktop keyboard shortcuts');
  const beta = item(page, 'beta');
  await beta.click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 1 });
  await page.keyboard.press('Shift+ArrowDown');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 2 });
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('toast')).toContainText('overlaps “Gamma”');
  await expect(beta).toHaveAttribute('data-refused', 'flash');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 2 });
  await page.keyboard.press('ControlOrMeta+z');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 1 });
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 2 });
  await page.keyboard.press('Delete');
  await expect(beta).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(beta).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(beta).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('pad-editor')).toBeVisible();
  // Typing in a field never moves the button.
  await beta.click();
  await page.getByTestId('field-label').click();
  await page.keyboard.press('ArrowLeft');
  await expectRect(beta, { x: 2, y: 1, w: 1, h: 2 });
});

test('undo and redo walk the history (toolbar)', async ({ page }) => {
  await p.tap(await center(cell(page, 2, 2)));
  await page.getByTestId('field-label').fill('Lamp');
  await expect(item(page, 'lamp')).toBeVisible();
  await page.getByTestId('edit-undo').click();
  await expect(item(page, 'button-4')).toBeVisible();
  await page.getByTestId('edit-undo').click();
  await expect(item(page, 'button-4')).toHaveCount(0);
  await expect(page.getByTestId('edit-undo')).toBeDisabled();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await page.getByTestId('edit-redo').click();
  await page.getByTestId('edit-redo').click();
  await expect(item(page, 'lamp')).toBeVisible();
  await expect(page.getByTestId('edit-redo')).toBeDisabled();
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
});

test('pads: add, rename (id follows), change id, reorder, delete with confirm', async ({ page }) => {
  await page.getByTestId('edit-add-pad').click();
  await expect(page.getByTestId('edit-tab-pad-3')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pad-editor')).toBeVisible();
  await expect(page.locator('.ed-cell')).toHaveCount(6);
  await page.getByTestId('pad-name').fill('Lights');
  await expect(page.getByTestId('edit-tab-lights')).toHaveText('Lights');
  await expect(page.getByTestId('pad-id')).toHaveValue('lights');
  await page.getByTestId('pad-id').fill('studio');
  await expect(page.getByTestId('edit-tab-studio')).toBeVisible();
  await page.getByTestId('pad-name').fill('Studio lights');
  await expect(page.getByTestId('pad-id')).toHaveValue('studio');
  await page.getByTestId('pad-move-left').click();
  await expect(page.locator('.ed-padtab')).toHaveText(['Main', 'Studio lights', 'Second']);
  await expect(page.getByTestId('pad-move-left')).toBeEnabled();
  await page.getByTestId('pad-delete').click();
  await expect(page.getByTestId('dialog-delete-pad')).toBeVisible();
  await page.getByTestId('delete-pad-confirm').click();
  await expect(page.locator('.ed-padtab')).toHaveText(['Main', 'Second']);
  await expect(page.getByTestId('toast')).toContainText('Deleted pad “Studio lights”');
  // The only pad can't be deleted.
  await page.getByTestId('edit-tab-second').click();
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-delete').click();
  await page.getByTestId('delete-pad-confirm').click();
  await page.getByTestId('edit-tab-main').click();
  await page.getByTestId('edit-pad-settings').click();
  await expect(page.getByTestId('pad-delete')).toBeDisabled();
});

test('grid size: shrinking that would clip buttons is refused, naming them', async ({ page }) => {
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-cols-dec').click();
  await expect(page.getByTestId('pad-cols-value')).toHaveText('2');
  await expect(page.locator('.ed-cell')).toHaveCount(6);
  await page.getByTestId('pad-cols-dec').click();
  await expect(page.getByTestId('pad-size-error')).toHaveText("Can't shrink to 1 × 3: “Beta” and “Gamma” are in the way. Move or resize them first.");
  await expect(page.getByTestId('pad-cols-value')).toHaveText('2');
  await expect(item(page, 'beta')).toHaveAttribute('data-refused', 'flash');
  await page.getByTestId('pad-rows-dec').click();
  await page.getByTestId('pad-rows-dec').click();
  await expect(page.getByTestId('pad-size-error')).toContainText('“Gamma” is in the way');
  await expect(page.getByTestId('pad-rows-value')).toHaveText('2');
  await page.getByTestId('pad-rows-inc').click();
  await page.getByTestId('pad-rows-inc').click();
  await expect(page.getByTestId('pad-rows-value')).toHaveText('4');
  await expect(page.locator('.ed-cell')).toHaveCount(8);
});

test('validation errors show inline, mark the button and block saving', async ({ page }) => {
  const before = await saved(page);
  await p.tap(await center(item(page, 'gamma')));
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-command').fill('');
  await expect(page.getByTestId('error-command')).toHaveText("Can't be empty");
  await expect(item(page, 'gamma')).toHaveClass(/has-problem/);
  await expect(status(page)).toHaveText('1 problem');
  await page.getByTestId('editor-tab-button').click();
  await page.getByTestId('field-id').fill('no spaces');
  await expect(page.getByTestId('error-id')).toHaveText('Letters, digits, _ and - only');
  await page.getByTestId('field-holdMs').fill('50');
  await expect(page.getByTestId('error-holdMs')).toHaveText('Must be at least 100 ms');
  await page.getByTestId('edit-save').click();
  const notice = page.getByTestId('notice-problems');
  await expect(notice).toContainText("Can't save yet: 3 problems");
  await expect(notice).toContainText('Main › “Gamma” · Command: Can\'t be empty');
  expect(await saved(page)).toEqual(before);
  // Fix them: the notice goes away and the save goes through.
  await page.getByTestId('field-id').fill('gamma');
  await page.getByTestId('field-holdMs').fill('600');
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-command').fill('printf');
  await expect(notice).toHaveCount(0);
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[2]).toMatchObject({ id: 'gamma', holdMs: 600, action: { command: 'printf', args: ['gamma'] } });
});

test('edit look, press and action fields, save: run mode shows it', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-label').fill('Key light');
  await page.getByTestId('field-color-swatch-facc15').click();
  await page.getByTestId('field-trigger-tap').click();
  await expect(page.getByTestId('field-holdMs')).toHaveCount(0);
  await page.getByTestId('field-confirm').click();
  await page.getByTestId('field-confirmWindowMs').fill('2000');
  await page.getByTestId('field-key').click();
  await expect(page.getByTestId('field-key')).toContainText('Press a key');
  await page.keyboard.press('K');
  await expect(page.getByTestId('field-key')).toContainText('Key “k”');
  await page.getByTestId('field-while-cancel').click();
  await page.getByTestId('field-timeoutMs').fill('5000');
  await expect(item(page, 'alpha')).toContainText('Key light');

  await page.getByTestId('editor-tab-action').click();
  await expect(page.getByTestId('output-tips')).toContainText('@progress');
  await page.getByTestId('field-action-type-exec').click();
  await expect(page.getByTestId('field-command')).toHaveValue('echo');
  await expect(page.getByTestId('field-arg-0')).toHaveValue('alpha');
  await page.getByTestId('field-arg-add').click();
  await page.getByTestId('field-arg-1').fill('--loud');
  await page.getByTestId('field-arg-1-up').click();
  await expect(page.getByTestId('field-arg-0')).toHaveValue('--loud');
  await page.getByTestId('field-arg-add').click();
  await page.getByTestId('field-arg-2-remove').click();
  await page.getByTestId('field-cwd').fill('/tmp');
  await page.getByTestId('env-add').click();
  await page.getByTestId('env-key-0').fill('LEVEL');
  await page.getByTestId('env-value-0').fill('80');

  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('toast')).toContainText('Saved');
  expect((await saved(page)).pads[0].buttons[0]).toMatchObject({
    id: 'alpha',
    label: 'Key light',
    color: '#facc15',
    trigger: 'tap',
    confirm: true,
    confirmWindowMs: 2000,
    key: 'k',
    whileRunning: 'cancel',
    timeoutMs: 5000,
    action: { type: 'exec', command: 'echo', args: ['--loud', 'alpha'], cwd: '/tmp', env: { LEVEL: '80' } },
  });
  await page.getByTestId('edit-close').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(btn(page, 'alpha')).toContainText('Key light');
  await expect(btn(page, 'alpha')).toContainText('TAP');
});

test('shell script edits and the action type round trip', async ({ page }) => {
  await p.tap(await center(item(page, 'beta')));
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-script').fill("echo '@status warming'; sleep 1; echo done");
  await page.getByTestId('field-shell').fill('/bin/bash');
  await page.getByTestId('field-action-type-exec').click();
  await expect(page.getByTestId('field-command')).toHaveValue('/bin/bash');
  await expect(page.getByTestId('field-arg-0')).toHaveValue('-c');
  await page.getByTestId('edit-undo').click();
  await expect(page.getByTestId('field-script')).toHaveValue("echo '@status warming'; sleep 1; echo done");
});

test('leaving with unsaved changes asks: keep editing, discard, or save', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-label').fill('Changed');
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await page.getByTestId('edit-close').click();
  await expect(page.getByTestId('dialog-leave')).toBeVisible();
  await page.getByTestId('leave-cancel').click();
  await expect(page.getByTestId('dialog-leave')).toHaveCount(0);
  await page.getByTestId('edit-close').click();
  await page.getByTestId('leave-discard').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(btn(page, 'alpha')).toContainText('Alpha');

  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-label').fill('Saved on the way out');
  await page.getByTestId('edit-close').click();
  await page.getByTestId('leave-save').click();
  await expect(page.getByTestId('edit-mode')).toHaveCount(0);
  await expect(btn(page, 'alpha')).toContainText('Saved on the way out');
});

test('discard goes back to the host config', async ({ page }) => {
  await p.tap(await center(cell(page, 2, 1)));
  await expect(item(page, 'button-4')).toBeVisible();
  await page.getByTestId('edit-status').click();
  await expect(page.getByTestId('dialog-discard')).toBeVisible();
  await page.getByTestId('discard-confirm').click();
  await expect(item(page, 'button-4')).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
});

test('duplicate and delete, with undo from the toast', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('editor-duplicate').click();
  const copy = item(page, 'alpha-copy');
  await expectRect(copy, { x: 2, y: 0, w: 1, h: 1 });
  await expect(copy).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('field-label')).toHaveValue('Alpha copy');
  await page.getByTestId('editor-delete').click();
  await expect(copy).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('Deleted “Alpha copy”');
  await page.getByTestId('toast-action').click();
  await expect(copy).toBeVisible();
  // A full pad has no room for a copy.
  await page.getByTestId('edit-tab-second').click();
  await p.tap(await center(cell(page, 1, 0)));
  await p.tap(await center(cell(page, 0, 1)));
  await p.tap(await center(cell(page, 1, 1)));
  await page.getByTestId('editor-duplicate').click();
  await expect(page.getByTestId('toast')).toContainText('No room for a copy');
});

test('dialogs that could throw work away focus their safe way out (Enter keeps editing)', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-label').fill('Changed');
  await page.getByTestId('edit-discard').click();
  await expect(page.getByTestId('discard-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialog-discard')).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await page.getByTestId('edit-close').click();
  await expect(page.getByTestId('leave-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialog-leave')).toHaveCount(0);
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-delete').click();
  await expect(page.getByTestId('delete-pad-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialog-delete-pad')).toHaveCount(0);
  await expect(page.locator('.ed-padtab')).toHaveCount(2);
  await expect(item(page, 'alpha')).toContainText('Changed');
});

test('Discard is one tap away on phones too (not only in the status chip), and undoable', async ({ page }) => {
  await p.tap(await center(cell(page, 2, 1)));
  await expect(item(page, 'button-4')).toBeVisible();
  await expect(page.getByTestId('edit-discard')).toBeVisible();
  await page.getByTestId('edit-discard').click();
  await page.getByTestId('discard-confirm').click();
  await expect(item(page, 'button-4')).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  await expect(page.getByTestId('edit-discard')).toHaveCount(0);
  await page.getByTestId('toast-action').click();
  await expect(item(page, 'button-4')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
});

test('⌘S while binding a key saves (it does not bind "s"); Backspace on a notice link leaves the button alone', async ({ page, hasTouch }) => {
  test.skip(hasTouch, 'desktop keyboard shortcuts');
  await item(page, 'alpha').click();
  await page.getByTestId('field-label').fill('Key light');
  await page.getByTestId('field-key').click();
  await expect(page.getByTestId('field-key')).toContainText('Press a key');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[0]).toMatchObject({ label: 'Key light' });
  expect((await saved(page)).pads[0].buttons[0].key).toBeUndefined();
  // Still listening: the remote's key binds.
  await page.keyboard.press('k');
  await expect(page.getByTestId('field-key')).toContainText('Key “k”');

  await page.getByTestId('field-id').fill('bad id!');
  await page.getByTestId('edit-save').click();
  await page.getByTestId('problem-item').first().click();
  await expect(page.getByTestId('problem-item').first()).toBeFocused();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await expect(page.locator('.ed-item')).toHaveCount(3);
});

test('Shell ⇄ Program keeps what a command means: ~ and NAME=value stay a script (sh -c), and come back as they were', async ({ page }) => {
  await p.tap(await center(item(page, 'beta')));
  await page.getByTestId('editor-tab-action').click();
  for (const script of ['ls -d ~', 'LC_ALL=C date']) {
    await page.getByTestId('field-script').fill(script);
    await page.getByTestId('field-action-type-exec').click();
    await expect(page.getByTestId('field-command')).toHaveValue('/bin/sh');
    await expect(page.getByTestId('field-arg-0')).toHaveValue('-c');
    await expect(page.getByTestId('field-arg-1')).toHaveValue(script);
    await page.getByTestId('field-action-type-shell').click();
    await expect(page.getByTestId('field-script')).toHaveValue(script);
    await expect(page.getByTestId('field-shell')).toHaveValue('');
  }
  // A plain word list does become argv, and an edited argv comes back properly quoted.
  await page.getByTestId('field-script').fill('echo hello');
  await page.getByTestId('field-action-type-exec').click();
  await expect(page.getByTestId('field-command')).toHaveValue('echo');
  await expect(page.getByTestId('field-arg-0')).toHaveValue('hello');
  await page.getByTestId('field-arg-0').fill("it's ~ here");
  await page.getByTestId('field-action-type-shell').click();
  await expect(page.getByTestId('field-script')).toHaveValue(`echo 'it'\\''s ~ here'`);
});

test('an empty argument is flagged but allowed; a bad env name is an inline error that blocks saving', async ({ page }) => {
  await p.tap(await center(item(page, 'gamma')));
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-arg-add').click();
  await expect(page.getByTestId('field-arg-1')).toBeFocused();
  await expect(page.getByTestId('field-arg-1-empty')).toHaveCount(0);
  await page.getByTestId('field-cwd').click();
  await expect(page.getByTestId('field-arg-1-empty')).toContainText('Empty');
  await expect(status(page)).toHaveAttribute('data-state', 'dirty');
  await page.getByTestId('env-add').click();
  await page.getByTestId('env-key-0').fill('FOO ');
  await expect(page.getByTestId('env-error-0')).toHaveText('Letters, digits and _ only, not starting with a digit');
  await expect(status(page)).toHaveText('1 problem');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('notice-problems')).toContainText('Variable FOO');
  await page.getByTestId('env-key-0').fill('FOO');
  await expect(page.getByTestId('env-error-0')).toHaveCount(0);
  await page.getByTestId('env-value-0').fill('bar');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[2].action).toEqual({ type: 'exec', command: 'echo', args: ['gamma', ''], env: { FOO: 'bar' } });
});

test('duplicate leaves the key binding behind; changing ids says what breaks; hints say where paths start', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-key').click();
  await page.keyboard.press('k');
  await expect(page.getByTestId('field-key')).toContainText('Key “k”');
  await page.getByTestId('editor-duplicate').click();
  await expect(page.getByTestId('field-label')).toHaveValue('Alpha copy');
  await expect(page.getByTestId('field-key')).toContainText('Press to bind a key');
  // The original's id is on the host: changing it says what that breaks.
  await p.tap(await center(item(page, 'alpha')));
  await expect(page.getByTestId('id-warning')).toHaveCount(0);
  await page.getByTestId('field-id').fill('alpha2');
  await expect(page.getByTestId('id-warning')).toContainText('POST /api/press/main/alpha');
  await page.getByTestId('editor-tab-action').click();
  // The host's default shell is /bin/sh, never $SHELL.
  await expect(page.getByTestId('field-shell')).toHaveAttribute('placeholder', '/bin/sh');
  await page.getByTestId('field-action-type-exec').click();
  await expect(page.getByTestId('button-editor')).toContainText('A relative path (./x.sh) starts in the working folder');
  await expect(page.getByTestId('button-editor')).toContainText("Default: the config file's folder");
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-id').fill('mainx');
  await expect(page.getByTestId('pad-id-warning')).toContainText('?pad=main');
});

test('the color field keeps every keystroke of a fast-typed hex code', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  const field = page.getByTestId('field-color-text');
  await field.click();
  await field.press('ControlOrMeta+a');
  // As fast as keys come: "#d62" and "#d628" are valid colors on the way (#rgb, #rgba).
  await page.keyboard.type('#d62828');
  await expect(field).toHaveValue('#d62828');
  await page.waitForTimeout(300);
  await expect(field).toHaveValue('#d62828');
  await page.getByTestId('field-label').click();
  await expect(field).toHaveValue('#d62828');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[0].color).toBe('#d62828');
});

test('a new button fails visibly until it is set up; switched to Program it starts blank (no sample -c args)', async ({ page }) => {
  await p.tap(await center(cell(page, 2, 0)));
  await page.getByTestId('editor-tab-action').click();
  await expect(page.getByTestId('field-script')).toHaveValue("echo 'No action set — edit this button' >&2; exit 1");
  await expect(page.getByTestId('placeholder-note')).toBeVisible();
  await page.getByTestId('field-action-type-exec').click();
  await expect(page.getByTestId('field-command')).toHaveValue('');
  await expect(page.locator('input[data-testid^="field-arg-"]')).toHaveCount(0);
  // Straight back: the placeholder again.
  await page.getByTestId('field-action-type-shell').click();
  await expect(page.getByTestId('field-script')).toHaveValue("echo 'No action set — edit this button' >&2; exit 1");
  // The flow that saved `haze.sh -c "echo…" 5` before: Program, a command, one argument.
  await page.getByTestId('field-action-type-exec').click();
  await page.getByTestId('field-command').fill('./scripts/haze.sh');
  await page.getByTestId('field-arg-add').click();
  await page.keyboard.type('5');
  // A second new button, left as it is.
  await p.tap(await center(cell(page, 2, 1)));
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  const buttons = (await saved(page)).pads[0].buttons;
  expect(buttons[3].action).toEqual({ type: 'exec', command: './scripts/haze.sh', args: ['5'] });
  expect(buttons[4]).toMatchObject({ id: 'button-5', action: { type: 'shell', script: "echo 'No action set — edit this button' >&2; exit 1" } });
  // Pressed before it's set up: a ✗ that says why, not a ✓ "Done".
  await p.tap(await center(item(page, 'button-5')));
  await page.getByTestId('editor-tab-runs').click();
  await page.getByTestId('run-test').click();
  await expect(page.getByTestId('run-item').first()).toContainText('Exit 1');
  await expect(page.getByTestId('run-item').first()).toContainText('No action set — edit this button');
});

test('a duplicate glows where it landed: no refused red, no shake', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('editor-duplicate').click();
  const copy = item(page, 'alpha-copy');
  await expect(copy).toHaveAttribute('data-added', '');
  await expect(copy).not.toHaveAttribute('data-refused');
  await expect(copy.locator('.ed-ring')).toHaveCSS('animation-name', 'ed-added');
  await expect(copy.locator('.bp-face')).not.toHaveCSS('animation-name', 'ed-shake');
  await expect(copy).not.toHaveAttribute('data-added', { timeout: 2000 });
});

test('a READY color that reads like success green or failure red gets a (non-blocking) warning', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  const text = page.getByTestId('field-color-text');
  const warning = page.getByTestId('color-warning');
  await expect(warning).toHaveCount(0);
  for (const [color, look] of [
    ['#d62828', 'failure'],
    ['#8b0000', 'failure'],
    ['#22c55e', 'success'],
    ['#10b981', 'success'],
  ] as const) {
    await text.fill(color);
    await expect(warning).toHaveAttribute('data-look', look);
  }
  await expect(warning).toContainText('SUCCESS');
  // The palette's pink, orange and teal are fine.
  for (const c of ['db2777', 'f97316', '0d9488']) {
    await page.getByTestId(`field-color-swatch-${c}`).click();
    await expect(warning).toHaveCount(0);
  }
  await text.fill('#d62828');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[0].color).toBe('#d62828');
});

test('"Nothing (stop others)" and Stops: pick buttons, a pad or everything; renames and deletes keep them in step', async ({ page }) => {
  await p.tap(await center(item(page, 'beta')));
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-action-type-none').click();
  await expect(page.getByTestId('field-script')).toHaveCount(0);
  await expect(page.getByTestId('field-cwd')).toHaveCount(0);
  await expect(page.getByTestId('output-tips')).toHaveCount(0);
  await expect(page.getByTestId('none-stops-nothing')).toBeVisible();
  // Itself isn't offered.
  await expect(page.getByTestId('stop-main/beta')).toHaveCount(0);
  await page.getByTestId('stop-main/alpha').click();
  await page.getByTestId('stop-main/gamma').click();
  await page.getByTestId('stop-second/*').click();
  await expect(page.getByTestId('none-stops-nothing')).toHaveCount(0);
  await expect(page.getByTestId('stop-second/solo')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('stop-second/solo')).toBeDisabled();
  await expect(page.getByTestId('stops-summary')).toHaveText("Stops 3 buttons when they're running.");
  await page.getByTestId('stop-all').click();
  await expect(page.getByTestId('stop-main/alpha')).toBeDisabled();
  await expect(page.getByTestId('stops-summary')).toHaveText('Stops everything else that runs.');
  await page.getByTestId('stop-all').click();
  // Alpha gets a new id: beta still stops it. Gamma goes: so does beta's pattern for it.
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('editor-tab-button').click();
  await page.getByTestId('field-id').fill('alpha2');
  await p.tap(await center(item(page, 'gamma')));
  await page.getByTestId('editor-delete').click();
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  const beta = (await saved(page)).pads[0].buttons.find((b: { id: string }) => b.id === 'beta');
  expect(beta.action).toEqual({ type: 'none' });
  expect(beta.stops).toEqual(['main/alpha2', 'second/*']);
  // The pad's id changes: its pattern follows.
  await page.getByTestId('edit-tab-second').click();
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-id').fill('other');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons.find((b: { id: string }) => b.id === 'beta').stops).toEqual(['main/alpha2', 'other/*']);
  // Switching straight back from Nothing gives the script it had.
  await page.getByTestId('edit-tab-main').click();
  await p.tap(await center(item(page, 'beta')));
  await page.getByTestId('editor-tab-action').click();
  await page.getByTestId('field-action-type-shell').click();
  await expect(page.getByTestId('field-script')).toHaveValue('echo beta');
});

test('a pattern that names nothing is listed to remove; Stops on a scripted button too', async ({ page }) => {
  const cfg: ConfigInput = { ...CONFIG, pads: [{ ...CONFIG.pads[0]!, buttons: CONFIG.pads[0]!.buttons!.map((b) => (b.id === 'alpha' ? { ...b, stops: ['gone/*', 'main/beta'] } : b)) }, CONFIG.pads[1]!] };
  await page.evaluate((c) => localStorage.setItem('buttpad.demo.config', c), JSON.stringify(cfg));
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await page.getByTestId('menu-btn').click();
  await page.getByTestId('menu-edit').click();
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('editor-tab-action').click();
  await expect(page.getByTestId('field-script')).toHaveValue('echo alpha');
  await expect(page.getByTestId('stop-main/beta')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('stop-gone')).toContainText('gone/*');
  await page.getByTestId('stop-gone-remove-gone/*').click();
  await expect(page.getByTestId('stop-gone')).toHaveCount(0);
  await page.getByTestId('stop-main/beta').click();
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[0]).not.toHaveProperty('stops');
});

test('cooldown and the time fields: hints say the range, arrows stay inside it, out of range is an error in words', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await expect(page.getByTestId('field-cooldownMs')).toHaveValue('400');
  await expect(page.getByTestId('button-editor')).toContainText('stops key chatter and bounces');
  await page.getByTestId('field-cooldownMs').fill('1000');
  await page.getByTestId('field-confirm').click();
  await page.getByTestId('field-confirmWindowMs').fill('70000');
  await expect(page.getByTestId('error-confirmWindowMs')).toHaveText('Must be at most 60000 ms (1 min)');
  await page.getByTestId('field-confirmWindowMs').fill('59950');
  await page.getByTestId('field-confirmWindowMs').press('ArrowUp');
  await expect(page.getByTestId('field-confirmWindowMs')).toHaveValue('60000');
  await page.getByTestId('field-resultHoldMs').fill('61000');
  await expect(page.getByTestId('error-resultHoldMs')).toHaveText('Must be at most 60000 ms (1 min)');
  await page.getByTestId('field-resultHoldMs').fill('3000');
  await page.getByTestId('field-timeoutMs').fill('90000000');
  await expect(page.getByTestId('error-timeoutMs')).toHaveText('Must be at most 86400000 ms (24 h)');
  await page.getByTestId('field-timeoutMs').fill('120000');
  await expect(page.getByTestId('button-editor')).toContainText('2 min, then it\'s killed');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0].buttons[0]).toMatchObject({ cooldownMs: 1000, confirm: true, confirmWindowMs: 60000, resultHoldMs: 3000, timeoutMs: 120000 });
});

test('a key also bound on another pad is pointed out (keys work from every pad)', async ({ page }) => {
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-key').click();
  await page.keyboard.press('k');
  await page.getByTestId('edit-tab-second').click();
  await p.tap(await center(item(page, 'solo')));
  await expect(page.getByTestId('field-key-conflict')).toHaveCount(0);
  await page.getByTestId('field-key').click();
  await page.keyboard.press('K');
  const note = page.getByTestId('field-key-conflict');
  await expect(note).toContainText('Also bound to “Alpha” on Main');
  await expect(note).toContainText('on each of these pads its own button wins');
  await expect(note).not.toContainText('does nothing');
  // With a third pad, the key is ambiguous there.
  await page.getByTestId('edit-add-pad').click();
  await page.getByTestId('edit-tab-second').click();
  await p.tap(await center(item(page, 'solo')));
  await expect(note).toContainText("from any other pad the key does nothing, since it isn’t unique");
});

test('labels and pad names are saved trimmed (and the draft is clean after), a blank pad name is an error', async ({ page }) => {
  await page.getByTestId('edit-pad-settings').click();
  await page.getByTestId('pad-name').fill('   ');
  await expect(page.getByTestId('error-pad-name')).toHaveText("Can't be empty");
  await page.getByTestId('pad-name').fill('  Studio  ');
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-label').fill('Lamp  ');
  await page.getByTestId('edit-save').click();
  await expect(status(page)).toHaveAttribute('data-state', 'clean');
  expect((await saved(page)).pads[0]).toMatchObject({ name: 'Studio', buttons: [{ label: 'Lamp' }, {}, {}] });
  await expect(page.getByTestId('field-label')).toHaveValue('Lamp');
  await expect(page.getByTestId('edit-tab-main')).toHaveText('Studio');
});

test('more than four problems: the rest of the list opens up', async ({ page, hasTouch }) => {
  test.skip(hasTouch, 'phones step through problems one by one');
  await p.tap(await center(item(page, 'alpha')));
  await page.getByTestId('field-holdMs').fill('1');
  await page.getByTestId('field-timeoutMs').fill('1');
  await page.getByTestId('field-resultHoldMs').fill('99999999');
  await page.getByTestId('field-cooldownMs').fill('99999999');
  await page.getByTestId('field-id').fill('a b');
  await page.getByTestId('field-driftPx').fill('-1');
  await page.getByTestId('edit-save').click();
  const notice = page.getByTestId('notice-problems');
  await expect(notice.getByTestId('problem-item')).toHaveCount(4);
  await notice.getByTestId('problems-more').click();
  await expect(notice.getByTestId('problem-item')).toHaveCount(6);
  await notice.getByTestId('problems-more').click();
  await expect(notice.getByTestId('problem-item')).toHaveCount(4);
});
