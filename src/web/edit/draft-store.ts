/**
 * Unsaved edit-mode drafts survive on this device: a rotated token (401), a pairing link opened in
 * the same tab, a reload, or a phone evicting the tab must not erase an hour of setup. One draft per
 * host (by origin; the demo has its own), in localStorage: written shortly after every change, and
 * at once when the page is hidden or the editor closes. Cleared once nothing is unsaved (a save, a
 * discard). The next edit session offers it back, merged with the host's config as it is by then.
 */
import { Button, parseConfig, type Config } from '../../core/config.ts';
import { lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import type { DraftSnapshot, Editor } from './editor.ts';

export interface StoredDraft extends DraftSnapshot {
  v: 1;
  /** When it was written (epoch ms). */
  savedAt: number;
}

/** Where the draft of this backend lives: the host's origin, or the demo. */
export const draftScope = (kind: 'ws' | 'demo') => (kind === 'demo' ? 'demo' : location.origin);
const key = (scope: string) => `buttpad.draft:${scope}`;

/** An editor with unsaved changes is open (app.tsx asks before a pairing link replaces it). */
export const unsavedEdits = createStore(false);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NUMS = ['x', 'y', 'w', 'h', 'holdMs', 'driftPx', 'confirmWindowMs', 'timeoutMs', 'resultHoldMs'];
/** Button fields a draft kept by an older version may lack (cooldownMs…), at their defaults. */
const BUTTON_DEFAULTS: Record<string, unknown> = (() => {
  const { id: _i, x: _x, y: _y, action: _a, ...d } = Button.parse({ id: 'x', x: 0, y: 0, action: { type: 'none' } });
  return d;
})();

/** Shaped like a config the editor can show (values may still have problems: it's a draft). */
function draftShaped(c: unknown): c is Config {
  if (!isObj(c) || !Array.isArray(c.pads) || !c.pads.length) return false;
  return c.pads.every(
    (p) =>
      isObj(p) &&
      typeof p.id === 'string' &&
      typeof p.name === 'string' &&
      typeof p.cols === 'number' &&
      typeof p.rows === 'number' &&
      Array.isArray(p.buttons) &&
      p.buttons.every(
        (b) =>
          isObj(b) &&
          typeof b.id === 'string' &&
          typeof b.label === 'string' &&
          typeof b.color === 'string' &&
          NUMS.every((k) => typeof b[k] === 'number') &&
          isObj(b.action) &&
          (b.action.type === 'exec'
            ? typeof b.action.command === 'string' && Array.isArray(b.action.args)
            : b.action.type === 'shell'
              ? typeof b.action.script === 'string'
              : b.action.type === 'none'),
      ),
  );
}

export function loadDraft(scope: string): StoredDraft | null {
  const d = lsJSON<StoredDraft>(key(scope));
  if (!isObj(d) || d.v !== 1 || typeof d.baseRev !== 'string' || typeof d.savedAt !== 'number') return null;
  if (isObj(d.draft) && Array.isArray(d.draft.pads))
    d.draft.pads = d.draft.pads.map((p) => (isObj(p) && Array.isArray(p.buttons) ? { ...p, buttons: p.buttons.map((b) => (isObj(b) ? ({ ...BUTTON_DEFAULTS, ...b } as typeof b) : b)) } : p));
  if (!draftShaped(d.draft)) return null;
  const base = parseConfig(d.base);
  if (!base.ok) return null;
  const origins = Array.isArray(d.origins) && d.origins.length === d.draft.pads.length ? d.origins : d.draft.pads.map((p) => ({ pad: p.id, buttons: p.buttons.map((b) => b.id) }));
  const fresh = Array.isArray(d.fresh) ? d.fresh : [];
  return { ...d, base: base.config, origins, fresh, pad: typeof d.pad === 'number' ? d.pad : 0 };
}

export const clearDraft = (scope: string) => lsSet(key(scope), null);

/** Keeps one editor's draft in storage while it has unsaved changes. */
export class DraftKeeper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Editor | null = null;
  private forgotten = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly scope: string,
    private readonly delayMs = 300,
  ) {
    const flush = () => this.flush();
    const hidden = () => document.visibilityState === 'hidden' && this.flush();
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    this.offs.push(
      () => removeEventListener('pagehide', flush),
      () => document.removeEventListener('visibilitychange', hidden),
    );
  }

  /** The draft changed: keep it (soon), or forget the stored one when nothing is unsaved. */
  update(ed: Editor): void {
    if (this.forgotten) return;
    if (!ed.dirty) {
      this.pending = null;
      clearTimeout(this.timer);
      clearDraft(this.scope);
      return;
    }
    this.pending = ed;
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const ed = this.pending;
    this.pending = null;
    if (ed?.dirty) lsSet(key(this.scope), JSON.stringify({ v: 1, savedAt: Date.now(), ...ed.snapshot() } satisfies StoredDraft));
  }

  /** The user threw the draft away (leaving without saving): don't keep it. */
  forget(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = null;
    this.forgotten = true;
    clearDraft(this.scope);
  }

  dispose(): void {
    if (!this.forgotten) this.flush();
    for (const off of this.offs) off();
  }
}
