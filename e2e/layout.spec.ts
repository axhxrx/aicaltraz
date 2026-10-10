/**
 * Layout: in every state, a button's text fits its box (nothing clipped), in short landscape
 * buttons too; CJK labels break between phrases and get the size their box allows.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';
import { btn, seedDemo } from './helpers.ts';

const sh = (script: string) => ({ type: 'shell' as const, script });
const LABELS = ['Backdrop sunset on', 'Turn all lights off now', 'Upload selects', 'Lights off at end', 'Fog machine on', 'Key light', 'Render preview', 'Card backup', 'ALL OFF', '照明をすべて消す', 'Mark clip', 'Hazer'];
const SCRIPTS = ["echo '@status fading in'; sleep 60", 'sleep 60', 'echo 12 photos uploaded', "echo 'card full: 0 bytes free' >&2; exit 3", "echo '@progress 40'; sleep 60", 'echo ok', "echo '@status encoding frame 75/600'; sleep 60", 'sleep 60', 'echo ok', 'sleep 60', 'echo ok', 'sleep 60'];
const STATES: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'p',
      name: 'States',
      cols: 3,
      rows: 4,
      buttons: LABELS.map((label, i) => ({
        id: `b${i}`,
        label,
        x: i % 3,
        y: Math.floor(i / 3),
        trigger: 'tap' as const,
        resultHoldMs: 60_000,
        action: sh(SCRIPTS[i]!),
        ...(i === 6 ? { whileRunning: 'cancel' as const } : i === 7 ? { timeoutMs: 300 } : {}),
      })),
    },
  ],
};

/**
 * Each visible item of each button's content that sticks out of the content box (or is cut short),
 * measured at rest: entrance animations (the ✗ shaking in at 108%) finish first.
 */
const overflows = async (page: Page) => {
  // (Not the drain bars: those run as long as resultHoldMs.)
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number(a.effect?.getComputedTiming().endTime) <= 2000).map((a) => a.finished.catch(() => {}))));
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.bp-btn')].flatMap((b) => {
      const c = b.querySelector('.bp-content')!;
      const box = c.getBoundingClientRect();
      return [...c.children]
        .filter((k) => getComputedStyle(k).display !== 'none' && getComputedStyle(k).position !== 'absolute')
        .filter((k) => {
          const r = k.getBoundingClientRect();
          return r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 2 || r.bottom > box.bottom + 2 || k.scrollWidth > k.clientWidth + 2;
        })
        .map((k) => `${b.dataset.visual}:${b.querySelector('.bp-label')?.textContent} → ${k.getAttribute('class')}`);
    }),
  );
};

for (const vp of [
  { width: 844, height: 390 },
  { width: 390, height: 844 },
]) {
  test(`every state fits its button at ${vp.width}×${vp.height} (live and offline)`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'sets its own viewport: once is enough');
    await page.setViewportSize(vp);
    await seedDemo(page, STATES);
    await page.goto('/?demo&exact');
    await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
    await page.evaluate(() => Promise.all(['b0', 'b1', 'b2', 'b3', 'b4', 'b6', 'b7', 'b9'].map((id) => window.__buttpad!.backend.press('p', id))));
    await expect(btn(page, 'b7')).toHaveAttribute('data-visual', 'failure');
    await expect(btn(page, 'b6')).toContainText('TO CANCEL');
    for (const [id, visual] of [['b0', 'running'], ['b2', 'success'], ['b3', 'failure'], ['b4', 'running'], ['b5', 'ready']] as const)
      await expect(btn(page, id)).toHaveAttribute('data-visual', visual);
    expect(await overflows(page)).toEqual([]);
    // A failure's reason is its headline, readable in a short landscape button too (not "c…").
    await expect(btn(page, 'b3')).toContainText('card full');
    const title = await btn(page, 'b3').locator('.bp-headline').evaluate((el) => ({ w: el.scrollWidth, box: el.clientWidth, font: parseFloat(getComputedStyle(el).fontSize) }));
    expect(title.w).toBeLessThanOrEqual(title.box + 1);
    expect(title.font).toBeGreaterThanOrEqual(12);

    await page.evaluate(() => (window.__buttpad!.backend as unknown as { setOnline(v: boolean): void }).setOnline(false));
    await expect(btn(page, 'b0')).toHaveAttribute('data-visual', 'offline');
    expect(await overflows(page)).toEqual([]);
  });
}

test('CJK labels break between phrases and are as big as the same words with spaces', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'one viewport is enough');
  const pairs = [
    ['照明をすべて消す', '照明を すべて 消す'],
    ['カメラ録画開始', 'カメラ 録画 開始'],
    ['撮影開始 Rec', '撮影 開始 Rec'],
  ];
  const labels = pairs.flat();
  await seedDemo(page, {
    version: 1,
    pads: [{ id: 'p', name: 'P', cols: 2, rows: 3, buttons: labels.map((label, i) => ({ id: `b${i}`, label, x: i % 2, y: Math.floor(i / 2), action: sh('echo') })) }],
  });
  await page.goto('/?demo&exact');
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  const sizes = await page.evaluate(() => [...document.querySelectorAll('.bp-label')].map((l) => parseFloat(getComputedStyle(l).fontSize)));
  for (let i = 0; i < pairs.length; i++) {
    const [solid, spaced] = [sizes[2 * i]!, sizes[2 * i + 1]!];
    // Before: 照明をすべて消す came out at 59% of its spaced twin (one long unbreakable line).
    expect(solid / spaced, `${pairs[i]![0]}: ${solid}px vs ${spaced}px`).toBeGreaterThan(0.9);
  }
  // Japanese is tagged as such (glyph choice, phrase-aware breaking where the browser has it).
  await expect(btn(page, 'b0').locator('.bp-label')).toHaveAttribute('lang', 'ja');
  // The lines break at phrase boundaries: no line ends in the middle of すべて.
  const lines = await btn(page, 'b0')
    .locator('.bp-label')
    .evaluate((el) => {
      const text = el.textContent!;
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const tops = new Map<number, string>();
      for (let n = node.nextNode(); n; n = node.nextNode())
        for (let i = 0; i < n.textContent!.length; i++) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          tops.set(top, (tops.get(top) ?? '') + n.textContent![i]);
        }
      return { text, lines: [...tops.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) };
    });
  expect(lines.lines.join('')).toBe(lines.text);
  for (const line of lines.lines) expect(['照明を', 'すべて', '消す', '照明をすべて', 'すべて消す', '照明をすべて消す']).toContain(line);
});
