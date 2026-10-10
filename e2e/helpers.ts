/** Shared e2e helpers: gestures (CDP touch on touch projects, mouse otherwise) and state probes. */
import { expect, type Locator, type Page } from '@playwright/test';
import type { ConfigInput } from '../src/core/config.ts';

export const btn = (page: Page, id: string): Locator => page.getByTestId(`btn-${id}`);

export async function expectVisual(page: Page, id: string, visual: string, timeout = 5000): Promise<void> {
  await expect(btn(page, id)).toHaveAttribute('data-visual', visual, { timeout });
}

/** Records every backend.press() from now on; the returned getter lists the button ids so far. */
export async function trackPresses(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    type P = (pad: string, id: string, onSent?: () => void) => Promise<unknown>;
    const b = window.__buttpad!.backend as unknown as { press: P };
    const orig = b.press.bind(b);
    const w = window as unknown as { __presses: string[] };
    w.__presses = [];
    b.press = (pad, id, onSent) => (w.__presses.push(id), orig(pad, id, onSent));
  });
  return () => page.evaluate(() => (window as unknown as { __presses: string[] }).__presses.slice());
}

/** Before the app loads: navigator.vibrate records its patterns (window.__vib, as JSON strings). */
export async function recordVibrations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vib: string[] };
    w.__vib = [];
    navigator.vibrate = ((p: VibratePattern) => (w.__vib.push(JSON.stringify(p)), true)) as Navigator['vibrate'];
  });
  return () => page.evaluate(() => (window as unknown as { __vib: string[] }).__vib.slice());
}

/** Haptic patterns (src/web/lib/feedback.ts), as recordVibrations() sees them. */
export const VIB = { touch: '8', fire: '35', failure: '[320]', success: '[40,70,40]', busy: '[18,50,18,50,18]', denied: '[70,50,70]', cancel: '[12,120,12]', unknown: '[100,80,100,80,100]' };

/** Seeds the demo backend's config (localStorage) before the app boots. */
export async function seedDemo(page: Page, config: ConfigInput): Promise<void> {
  await page.addInitScript((cfg) => {
    if (!sessionStorage.getItem('e2e.seeded')) {
      localStorage.setItem('buttpad.demo.config', cfg);
      sessionStorage.setItem('e2e.seeded', '1');
    }
  }, JSON.stringify(config));
}

type Pt = { x: number; y: number };

/**
 * Fingers on the screen. On touch projects each finger is a CDP touch point (so several can be
 * down at once, like real multi-touch); on mouse projects there is one pointer.
 */
export class Fingers {
  private active = new Map<number, Pt>();
  private cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>> | null = null;

  constructor(
    private readonly page: Page,
    readonly touch: boolean,
  ) {}

  /** CDP diffs touchStart/touchMove against the previous points, but touchEnd lists the points that lift. */
  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', points = this.active) {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    const touchPoints = [...points].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 }));
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  }

  async center(id: string): Promise<Pt> {
    const box = await btn(this.page, id).boundingBox();
    if (!box) throw new Error(`no button ${id}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async down(buttonId: string, finger = 1, offset: Pt = { x: 0, y: 0 }): Promise<void> {
    const c = await this.center(buttonId);
    const p = { x: c.x + offset.x, y: c.y + offset.y };
    this.active.set(finger, p);
    if (this.touch) await this.send('touchStart');
    else {
      await this.page.mouse.move(p.x, p.y);
      await this.page.mouse.down();
    }
  }

  async move(dx: number, dy: number, finger = 1): Promise<void> {
    const p = this.active.get(finger);
    if (!p) throw new Error(`finger ${finger} is not down`);
    // A few steps, like a real slide.
    for (let i = 1; i <= 4; i++) {
      const q = { x: p.x + (dx * i) / 4, y: p.y + (dy * i) / 4 };
      this.active.set(finger, q);
      if (this.touch) await this.send('touchMove');
      else await this.page.mouse.move(q.x, q.y);
    }
  }

  async up(finger = 1): Promise<void> {
    const p = this.active.get(finger);
    this.active.delete(finger);
    if (this.touch) await this.send('touchEnd', new Map(p ? [[finger, p]] : []));
    else await this.page.mouse.up();
  }

  async hold(buttonId: string, ms: number): Promise<void> {
    await this.down(buttonId);
    await this.page.waitForTimeout(ms);
    await this.up();
  }

  /**
   * One finger down/up stamped with an explicit event time (epoch ms), whenever it actually gets
   * there: for tests that stall the page's main thread and mustn't depend on Node's timers.
   */
  async downAt(buttonId: string, at: number): Promise<void> {
    const p = await this.center(buttonId);
    this.active.set(1, p);
    await this.stamped('down', p, at);
  }

  async upAt(at: number): Promise<void> {
    const p = this.active.get(1);
    if (!p) throw new Error('no finger is down');
    this.active.delete(1);
    await this.stamped('up', p, at);
  }

  private async stamped(kind: 'down' | 'up', p: Pt, at: number) {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    const timestamp = at / 1000;
    if (this.touch) {
      const touchPoints = [{ id: 1, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 }];
      await this.cdp.send('Input.dispatchTouchEvent', { type: kind === 'down' ? 'touchStart' : 'touchEnd', touchPoints, timestamp });
      return;
    }
    if (kind === 'down') await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, timestamp });
    await this.cdp.send('Input.dispatchMouseEvent', { type: kind === 'down' ? 'mousePressed' : 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: kind === 'down' ? 1 : 0, clickCount: 1, timestamp });
  }

  async tap(buttonId: string): Promise<void> {
    await this.down(buttonId);
    await this.page.waitForTimeout(40);
    await this.up();
  }
}

/** Deterministic buttons for flow tests (shell scripts: the demo simulates them, a host runs them). */
export const FLOW_CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 3,
      buttons: [
        { id: 'hold', label: 'Hold me', x: 0, y: 0, holdMs: 400, resultHoldMs: 1200, key: 'h', action: { type: 'shell', script: "echo '@status working'; sleep 0.6; echo 'held ok'" } },
        { id: 'tap', label: 'Tap me', color: '#db2777', x: 1, y: 0, trigger: 'tap', resultHoldMs: 1000, key: 't', action: { type: 'shell', script: "sleep 0.3; echo 'tapped ok'" } },
        { id: 'double', label: 'Double', color: '#7c3aed', x: 2, y: 0, trigger: 'double', resultHoldMs: 1000, action: { type: 'shell', script: "sleep 0.3; echo 'double ok'" } },
        { id: 'confirm', label: 'Danger', color: '#4338ca', x: 0, y: 1, holdMs: 300, confirm: true, confirmWindowMs: 1500, resultHoldMs: 1000, action: { type: 'shell', script: "sleep 0.3; echo 'confirmed'" } },
        { id: 'slow', label: 'Slow', color: '#0891b2', x: 1, y: 1, trigger: 'tap', resultHoldMs: 800, action: { type: 'shell', script: "echo '@status busy'; sleep 2.5; echo 'slow done'" } },
        { id: 'fail', label: 'Fail', color: '#f97316', x: 2, y: 1, trigger: 'tap', resultHoldMs: 1500, action: { type: 'shell', script: "echo 'disk full' >&2; exit 2" } },
        { id: 'cancel', label: 'Cancel me', color: '#0d9488', x: 0, y: 2, trigger: 'tap', whileRunning: 'cancel', resultHoldMs: 1500, action: { type: 'shell', script: "echo '@progress 10'; sleep 1; echo '@progress 50'; sleep 5; echo 'never'" } },
        { id: 'queue', label: 'Queue', color: '#2563eb', x: 1, y: 2, trigger: 'tap', whileRunning: 'queue', resultHoldMs: 800, action: { type: 'shell', script: "sleep 0.8; echo 'queued run'" } },
        { id: 'hold2', label: 'Hold two', color: '#ea580c', x: 2, y: 2, holdMs: 400, resultHoldMs: 1200, action: { type: 'shell', script: "sleep 0.6; echo 'second ok'" } },
      ],
    },
    {
      id: 'other',
      name: 'Other',
      cols: 1,
      rows: 1,
      buttons: [{ id: 'solo', label: 'Solo', x: 0, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo solo' } }],
    },
  ],
};
