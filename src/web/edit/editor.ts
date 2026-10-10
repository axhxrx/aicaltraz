/**
 * The edit-mode draft: a local copy of the host config with undo/redo, plus the view (pad and
 * selected button, by index: ids can be mid-edit or even duplicated while the user types).
 * Framework-free; components read `store` with useStore.
 */
import type { Button, Config, Pad } from '../../core/config.ts';
import { createStore, type Store } from '../lib/store.ts';
import { clipped, convertAction, fits, freeSpot, newButton, newPad, sameRect, slug, uniqueId, type Fit, type Rect } from './ops.ts';

export interface View {
  pad: number;
  sel: number | null;
}

interface Entry {
  config: Config;
  view: View;
}

export interface EdState {
  draft: Config;
  view: View;
  past: Entry[];
  future: Entry[];
  /** The host config the draft started from, and its revision (PUT baseRev). */
  base: Config;
  baseRev: string;
}

const HISTORY = 200;
/** Edits to the same field closer together than this are one undo step (typing). */
const MERGE_MS = 1500;

/** JSON with sorted keys and undefined dropped: equal configs compare equal regardless of key order. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

export class Editor {
  readonly store: Store<EdState>;
  private mergeKey: string | null = null;
  private mergeAt = 0;
  /** New (unsaved) pads/buttons whose id still follows their name/label. Keyed by object identity. */
  private fresh = new WeakSet<object>();

  constructor(config: Config, rev: string, pad = 0) {
    this.store = createStore<EdState>({ draft: config, base: config, baseRev: rev, view: { pad: clampIx(pad, config.pads.length), sel: null }, past: [], future: [] });
  }

  get state(): EdState {
    return this.store.get();
  }
  get pad(): Pad {
    const s = this.state;
    return s.draft.pads[s.view.pad]!;
  }
  get dirty(): boolean {
    const s = this.state;
    return s.draft !== s.base && stable(s.draft) !== stable(s.base);
  }

  // ---- history ----------------------------------------------------------------------------

  /** One undoable change. Changes sharing `merge` within MERGE_MS collapse into one step. */
  private commit(next: Config, view: Partial<View> = {}, merge?: string) {
    const s = this.state;
    if (next === s.draft) return;
    const now = Date.now();
    const same = !!merge && merge === this.mergeKey && now - this.mergeAt < MERGE_MS && s.past.length > 0;
    this.mergeKey = merge ?? null;
    this.mergeAt = now;
    const past = same ? s.past : [...s.past, { config: s.draft, view: s.view }].slice(-HISTORY);
    this.store.set({ ...s, draft: next, past, future: [], view: { ...s.view, ...view } });
  }

  undo(): boolean {
    const s = this.state;
    const e = s.past.at(-1);
    if (!e) return false;
    this.mergeKey = null;
    this.store.set({ ...s, draft: e.config, view: e.view, past: s.past.slice(0, -1), future: [...s.future, { config: s.draft, view: s.view }] });
    return true;
  }

  redo(): boolean {
    const s = this.state;
    const e = s.future.at(-1);
    if (!e) return false;
    this.mergeKey = null;
    this.store.set({ ...s, draft: e.config, view: e.view, future: s.future.slice(0, -1), past: [...s.past, { config: s.draft, view: s.view }] });
    return true;
  }

  // ---- view -------------------------------------------------------------------------------

  select(sel: number | null): void {
    const s = this.state;
    this.mergeKey = null;
    if (sel !== s.view.sel) this.store.set({ ...s, view: { ...s.view, sel } });
  }

  showPad(pad: number): void {
    const s = this.state;
    this.mergeKey = null;
    this.store.set({ ...s, view: { pad: clampIx(pad, s.draft.pads.length), sel: null } });
  }

  /**
   * Start over from a host config (adopt a newer one, discard, load theirs). History is dropped;
   * the view stays on the same pad/button when they still exist.
   */
  reset(config: Config, rev: string): void {
    const s = this.state;
    const pad = s.draft.pads[s.view.pad];
    const pi = config.pads.findIndex((p) => p.id === pad?.id);
    const selId = s.view.sel !== null ? pad?.buttons[s.view.sel]?.id : undefined;
    const si = pi >= 0 && selId !== undefined ? config.pads[pi]!.buttons.findIndex((b) => b.id === selId) : -1;
    this.mergeKey = null;
    this.fresh = new WeakSet();
    this.store.set({
      draft: config,
      base: config,
      baseRev: rev,
      view: { pad: pi >= 0 ? pi : clampIx(s.view.pad, config.pads.length), sel: si >= 0 ? si : null },
      past: [],
      future: [],
    });
  }

  /** Unsaved new pad/button whose id still follows its name/label. */
  isFresh(o: object): boolean {
    return this.fresh.has(o);
  }

  /** The host accepted `sent` as `rev`. Edits made meanwhile stay in the draft. */
  saved(sent: Config, rev: string): void {
    // Saved things have real ids now: renaming a label must not silently change them any more.
    this.fresh = new WeakSet();
    this.store.set((s) => ({ ...s, base: sent, baseRev: rev }));
  }

  // ---- edits ------------------------------------------------------------------------------

  private withPad(cfg: Config, pi: number, fn: (p: Pad) => Pad): Config {
    const old = cfg.pads[pi];
    if (!old) return cfg;
    const p = fn(old);
    if (p === old) return cfg;
    if (this.fresh.has(old)) this.fresh.add(p);
    return { ...cfg, pads: cfg.pads.map((x, i) => (i === pi ? p : x)) };
  }

  private withButton(cfg: Config, pi: number, bi: number, fn: (b: Button, pad: Pad) => Button, keepFresh = true): Config {
    return this.withPad(cfg, pi, (pad) => {
      const old = pad.buttons[bi];
      if (!old) return pad;
      const b = fn(old, pad);
      if (b === old) return pad;
      if (keepFresh && this.fresh.has(old)) this.fresh.add(b);
      return { ...pad, buttons: pad.buttons.map((x, i) => (i === bi ? b : x)) };
    });
  }

  /** Patch the selected (or given) button. `field` names the merge group for typing. */
  patchButton(patch: Partial<Button>, field?: string, bi = this.state.view.sel ?? -1): void {
    const s = this.state;
    const cur = this.pad.buttons[bi];
    if (!cur || same(cur, patch)) return;
    const manualId = 'id' in patch;
    const next = this.withButton(
      s.draft,
      s.view.pad,
      bi,
      (b, pad) => {
        const nb = { ...b, ...patch };
        if (patch.label !== undefined && !manualId && this.fresh.has(b)) {
          nb.id = uniqueId(slug(patch.label) || 'button', pad.buttons.filter((_, i) => i !== bi).map((x) => x.id));
        }
        return nb;
      },
      !manualId,
    );
    this.commit(next, {}, field && `b:${s.view.pad}:${bi}:${field}`);
  }

  setActionType(type: 'exec' | 'shell'): void {
    const b = this.button();
    if (b && b.action.type !== type) this.patchButton({ action: convertAction(b.action, type) });
  }

  button(bi = this.state.view.sel): Button | null {
    return bi === null ? null : (this.pad.buttons[bi] ?? null);
  }

  /** New button at an empty cell; selects it. */
  addButton(x: number, y: number): number | null {
    const s = this.state;
    const pad = this.pad;
    if (!fits(pad, { x, y, w: 1, h: 1 }).ok) return null;
    const b = newButton(pad, x, y);
    this.fresh.add(b);
    const bi = pad.buttons.length;
    this.commit(
      this.withPad(s.draft, s.view.pad, (p) => ({ ...p, buttons: [...p.buttons, b] })),
      { sel: bi },
    );
    return bi;
  }

  /** Move/resize; refused (and nothing changes) unless it fits. */
  place(bi: number, r: Rect): Fit {
    const s = this.state;
    const b = this.pad.buttons[bi];
    if (!b) return { ok: false, reason: 'bounds' };
    const f = fits(this.pad, r, bi);
    if (f.ok && !sameRect(b, r)) this.commit(this.withButton(s.draft, s.view.pad, bi, (x) => ({ ...x, ...r })), { sel: bi });
    return f;
  }

  removeButton(bi = this.state.view.sel ?? -1): Button | null {
    const s = this.state;
    const b = this.pad.buttons[bi];
    if (!b) return null;
    this.commit(
      this.withPad(s.draft, s.view.pad, (p) => ({ ...p, buttons: p.buttons.filter((_, i) => i !== bi) })),
      { sel: null },
    );
    return b;
  }

  /** New 1×1 button in the first free cell (keyboard / "Add a button"). */
  addAnywhere(): number | null {
    const spot = freeSpot(this.pad, 1, 1);
    return spot ? this.addButton(spot.x, spot.y) : null;
  }

  /** Copy into the first free spot (same size if possible). Null: the pad is full. */
  duplicate(bi = this.state.view.sel ?? -1): number | null {
    const s = this.state;
    const pad = this.pad;
    const b = pad.buttons[bi];
    if (!b) return null;
    const spot = freeSpot(pad, b.w, b.h) ?? freeSpot(pad, 1, 1);
    if (!spot) return null;
    const label = b.label ? `${b.label} copy` : '';
    const id = uniqueId(slug(label) || `${b.id}-copy`, pad.buttons.map((x) => x.id));
    const copy: Button = { ...structuredClone(b), ...spot, id, label };
    this.fresh.add(copy);
    const ni = pad.buttons.length;
    this.commit(
      this.withPad(s.draft, s.view.pad, (p) => ({ ...p, buttons: [...p.buttons, copy] })),
      { sel: ni },
    );
    return ni;
  }

  // ---- pads -------------------------------------------------------------------------------

  patchPad(patch: Partial<Omit<Pad, 'buttons'>>, field?: string): void {
    const s = this.state;
    if (same(this.pad, patch)) return;
    const manualId = 'id' in patch;
    const pi = s.view.pad;
    const next = this.withPad(s.draft, pi, (p) => {
      const np = { ...p, ...patch };
      if (patch.name !== undefined && !manualId && this.fresh.has(p)) {
        np.id = uniqueId(slug(patch.name) || 'pad', s.draft.pads.filter((_, i) => i !== pi).map((x) => x.id));
      }
      return np;
    });
    // A hand-typed id is final.
    if (manualId) this.fresh.delete(next.pads[pi] ?? {});
    this.commit(next, {}, field && `p:${pi}:${field}`);
  }

  /** Grid size; refused with the buttons in the way when shrinking would clip them. */
  resizePad(cols: number, rows: number): { ok: true } | { ok: false; blockers: Button[] } {
    const pad = this.pad;
    const blockers = clipped(pad, cols, rows);
    if (blockers.length) return { ok: false, blockers };
    if (cols !== pad.cols || rows !== pad.rows) this.patchPad({ cols, rows });
    return { ok: true };
  }

  addPad(): void {
    const s = this.state;
    const p = newPad(s.draft);
    this.fresh.add(p);
    this.commit({ ...s.draft, pads: [...s.draft.pads, p] }, { pad: s.draft.pads.length, sel: null });
  }

  removePad(pi = this.state.view.pad): boolean {
    const s = this.state;
    if (s.draft.pads.length <= 1 || !s.draft.pads[pi]) return false;
    const pads = s.draft.pads.filter((_, i) => i !== pi);
    this.commit({ ...s.draft, pads }, { pad: Math.min(pi, pads.length - 1), sel: null });
    return true;
  }

  movePad(dir: -1 | 1): void {
    const s = this.state;
    const pi = s.view.pad;
    const to = pi + dir;
    if (to < 0 || to >= s.draft.pads.length) return;
    const pads = [...s.draft.pads];
    [pads[pi], pads[to]] = [pads[to]!, pads[pi]!];
    this.commit({ ...s.draft, pads }, { pad: to });
  }
}

const clampIx = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));
/** Would `patch` change nothing on `o`? (No-op edits make no undo steps.) */
const same = (o: object, patch: object) => Object.entries(patch).every(([k, v]) => stable(v) === stable((o as Record<string, unknown>)[k]));
