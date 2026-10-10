/**
 * The edit-mode draft: a local copy of the host config with undo/redo, plus the view (pad and
 * selected button, by index: ids can be mid-edit or even duplicated while the user types).
 * Framework-free; components read `store` with useStore.
 *
 * Identity: every pad and button object has a uid that its edited versions inherit. That's how the
 * editor knows which base pad/button a draft one comes from even after its id was edited (merges,
 * merge.ts), and which new ones were saved since (their id stops following their label).
 */
import type { Action, Button, Config, Pad } from '../../core/config.ts';
import { createStore, type Store } from '../lib/store.ts';
import type { MergeResult, Origins } from './merge.ts';
import { clipped, convertAction, copyOf, fits, freeSpot, newButton, newPad, renamePattern, sameRect, slug, stable, uniqueId, type Fit, type Rect } from './ops.ts';

export { stable } from './ops.ts';

export interface View {
  pad: number;
  sel: number | null;
}

interface Entry {
  config: Config;
  view: View;
  /** Steps that also moved the base (a merge, a discard): undoing one goes back to the old base. */
  base?: { config: Config; rev: string };
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

/** Everything needed to rebuild a session's draft later (draft-store.ts keeps it in localStorage). */
export interface DraftSnapshot {
  draft: Config;
  base: Config;
  baseRev: string;
  /** Which base pad/button each draft one comes from (ids may have been edited). */
  origins: Origins;
  /** Per draft pad/button: does its id still follow its name/label? */
  fresh: { pad: boolean; buttons: boolean[] }[];
  pad: number;
}

const HISTORY = 200;
/** Edits to the same field closer together than this are one undo step (typing). */
const MERGE_MS = 1500;

export class Editor {
  readonly store: Store<EdState>;
  private mergeKey: string | null = null;
  private mergeAt = 0;
  private uids = new WeakMap<object, number>();
  private nextUid = 1;
  /** New (unsaved) pads/buttons whose id still follows their name/label, by object… */
  private fresh = new WeakSet<object>();
  /** …unless one of their versions went out in a save since (by uid). */
  private savedUids = new Set<number>();
  /** An action made by switching the type → the action it was made from (switching back gives that again). */
  private convertedFrom = new WeakMap<object, Action>();

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

  // ---- identity -----------------------------------------------------------------------------

  private uid(o: object): number {
    let u = this.uids.get(o);
    if (u === undefined) this.uids.set(o, (u = this.nextUid++));
    return u;
  }

  /** `to` is an edited version of `from`. */
  private derive(from: object, to: object) {
    if (from !== to) this.uids.set(to, this.uid(from));
  }

  /** Is `a` (a draft pad/button) a version of `b`? */
  sameThing(a: object, b: object): boolean {
    return this.uid(a) === this.uid(b);
  }

  /** Which base pad/button each draft pad/button comes from (for merge3). */
  origins(): Origins {
    const s = this.state;
    const pads = new Map(s.base.pads.map((p) => [this.uid(p), p]));
    return s.draft.pads.map((p) => {
      const bp = pads.get(this.uid(p));
      const bb = new Map(bp?.buttons.map((b) => [this.uid(b), b]) ?? []);
      return { pad: bp?.id ?? null, buttons: p.buttons.map((b) => bb.get(this.uid(b))?.id ?? null) };
    });
  }

  /** The base (host) version of a draft pad or button, if it has one. */
  baseOf(o: Pad): Pad | undefined;
  baseOf(o: Button, pad: Pad): Button | undefined;
  baseOf(o: Pad | Button, pad?: Pad): Pad | Button | undefined {
    const u = this.uid(o);
    if (!pad) return this.state.base.pads.find((p) => this.uid(p) === u);
    return this.baseOf(pad)?.buttons.find((b) => this.uid(b) === u);
  }

  /** Ids a new button on `pad` must stay clear of: the host's buttons on the pad with that id (or that the pad comes from). */
  private reserved(pad: Pad): string[] {
    return this.state.base.pads.filter((p) => p.id === pad.id || this.sameThing(p, pad)).flatMap((p) => p.buttons.map((b) => b.id));
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
    const back: Entry = { config: s.draft, view: s.view, ...(e.base ? { base: { config: s.base, rev: s.baseRev } } : {}) };
    this.store.set({ ...s, ...(e.base ? { base: e.base.config, baseRev: e.base.rev } : {}), draft: e.config, view: e.view, past: s.past.slice(0, -1), future: [...s.future, back] });
    return true;
  }

  redo(): boolean {
    const s = this.state;
    const e = s.future.at(-1);
    if (!e) return false;
    this.mergeKey = null;
    const back: Entry = { config: s.draft, view: s.view, ...(e.base ? { base: { config: s.base, rev: s.baseRev } } : {}) };
    this.store.set({ ...s, ...(e.base ? { base: e.base.config, baseRev: e.base.rev } : {}), draft: e.config, view: e.view, future: s.future.slice(0, -1), past: [...s.past, back] });
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

  /** The same pad/button in `next`, if it's still there (by identity, else by id). */
  private remap(next: Config): View {
    const s = this.state;
    const pad = s.draft.pads[s.view.pad];
    const sel = s.view.sel !== null ? pad?.buttons[s.view.sel] : undefined;
    const find = <T extends { id: string }>(list: T[], o: T | undefined) => (o ? list.findIndex((x) => this.sameThing(x, o)) : -1);
    let pi = find(next.pads, pad);
    if (pi < 0 && pad) pi = next.pads.findIndex((p) => p.id === pad.id);
    let si = pi >= 0 ? find(next.pads[pi]!.buttons, sel) : -1;
    if (si < 0 && pi >= 0 && sel) si = next.pads[pi]!.buttons.findIndex((b) => b.id === sel.id);
    return { pad: pi >= 0 ? pi : clampIx(s.view.pad, next.pads.length), sel: si >= 0 ? si : null };
  }

  /**
   * Start over from a host config (adopt a newer one while there's nothing unsaved). History is
   * dropped; the view stays on the same pad/button when they still exist.
   */
  reset(config: Config, rev: string): void {
    const view = this.remap(config);
    this.mergeKey = null;
    this.fresh = new WeakSet();
    this.savedUids = new Set();
    this.store.set({ draft: config, base: config, baseRev: rev, view, past: [], future: [] });
  }

  /** Throw the draft away for a host config, as one undoable step (undo brings the draft and its base back). */
  discard(config: Config, rev: string): void {
    this.rebase(config, config, rev);
  }

  /** A merge (merge3 of base, draft and `theirs`) becomes the draft, based on `theirs` now. Undoable. */
  applyMerge(res: MergeResult, theirs: Config, rev: string): void {
    for (const [o, l] of res.links) {
      // Merged things keep the identity of the draft's version; theirs (the new base) shares it.
      const u = this.uid(l.mine ?? l.theirs ?? o);
      this.uids.set(o, u);
      if (l.theirs) {
        this.uids.set(l.theirs, u);
        this.savedUids.add(u); // on the host now: its id is real
      }
    }
    this.rebase(res.config, theirs, rev);
  }

  private rebase(draft: Config, base: Config, rev: string) {
    const s = this.state;
    const view = this.remap(draft);
    this.mergeKey = null;
    this.store.set({
      draft,
      base,
      baseRev: rev,
      view,
      past: [...s.past, { config: s.draft, view: s.view, base: { config: s.base, rev: s.baseRev } }].slice(-HISTORY),
      future: [],
    });
  }

  /** Pick up a draft kept from an earlier session (see snapshot()). History starts empty. */
  restore(d: DraftSnapshot): void {
    this.fresh = new WeakSet();
    this.savedUids = new Set();
    this.mergeKey = null;
    d.draft.pads.forEach((p, i) => {
      const o = d.origins[i];
      const bp = o?.pad != null ? d.base.pads.find((x) => x.id === o.pad) : undefined;
      if (bp) this.uids.set(p, this.uid(bp));
      if (d.fresh[i]?.pad) this.fresh.add(p);
      p.buttons.forEach((b, j) => {
        const ob = o?.buttons[j];
        const bb = bp && ob != null ? bp.buttons.find((x) => x.id === ob) : undefined;
        if (bb) this.uids.set(b, this.uid(bb));
        if (d.fresh[i]?.buttons[j]) this.fresh.add(b);
      });
    });
    this.store.set({ draft: d.draft, base: d.base, baseRev: d.baseRev, view: { pad: clampIx(d.pad, d.draft.pads.length), sel: null }, past: [], future: [] });
  }

  snapshot(): DraftSnapshot {
    const s = this.state;
    return {
      draft: s.draft,
      base: s.base,
      baseRev: s.baseRev,
      origins: this.origins(),
      fresh: s.draft.pads.map((p) => ({ pad: this.isFresh(p), buttons: p.buttons.map((b) => this.isFresh(b)) })),
      pad: s.view.pad,
    };
  }

  /** Unsaved new pad/button whose id still follows its name/label. */
  isFresh(o: object): boolean {
    return this.fresh.has(o) && !this.savedUids.has(this.uid(o));
  }

  /**
   * Labels and pad names as the host keeps them (trimmed), so what's saved is exactly the draft.
   * Not an undo step of its own.
   */
  tidy(): void {
    const s = this.state;
    let next = s.draft;
    s.draft.pads.forEach((p, pi) => {
      if (p.name !== p.name.trim()) next = this.withPad(next, pi, (x) => ({ ...x, name: x.name.trim() }));
      p.buttons.forEach((b, bi) => {
        if (b.label !== b.label.trim()) next = this.withButton(next, pi, bi, (x) => ({ ...x, label: x.label.trim() }));
      });
    });
    if (next !== s.draft) this.store.set({ ...s, draft: next });
  }

  /** The host accepted `sent` as `rev`. Edits made meanwhile stay in the draft. */
  saved(sent: Config, rev: string): void {
    // Saved things have real ids now: renaming a label must not change them any more. Things made
    // after the save went out still follow theirs.
    for (const p of sent.pads) {
      this.savedUids.add(this.uid(p));
      for (const b of p.buttons) this.savedUids.add(this.uid(b));
    }
    // A step from before the save mustn't take the base back to before it.
    const plain = (e: Entry): Entry => (e.base ? { config: e.config, view: e.view } : e);
    this.store.set((s) => ({ ...s, base: sent, baseRev: rev, past: s.past.map(plain), future: s.future.map(plain) }));
  }

  // ---- edits ------------------------------------------------------------------------------

  private withPad(cfg: Config, pi: number, fn: (p: Pad) => Pad): Config {
    const old = cfg.pads[pi];
    if (!old) return cfg;
    const p = fn(old);
    if (p === old) return cfg;
    this.derive(old, p);
    if (this.fresh.has(old)) this.fresh.add(p);
    return { ...cfg, pads: cfg.pads.map((x, i) => (i === pi ? p : x)) };
  }

  private withButton(cfg: Config, pi: number, bi: number, fn: (b: Button, pad: Pad) => Button, keepFresh = true): Config {
    return this.withPad(cfg, pi, (pad) => {
      const old = pad.buttons[bi];
      if (!old) return pad;
      const b = fn(old, pad);
      if (b === old) return pad;
      this.derive(old, b);
      if (keepFresh && this.fresh.has(old)) this.fresh.add(b);
      return { ...pad, buttons: pad.buttons.map((x, i) => (i === bi ? b : x)) };
    });
  }

  /** Patch the selected (or given) button. `field` names the merge group for typing. */
  patchButton(patch: Partial<Button>, field?: string, bi = this.state.view.sel ?? -1): void {
    const s = this.state;
    const pi = s.view.pad;
    const cur = this.pad.buttons[bi];
    if (!cur || same(cur, patch)) return;
    const manualId = 'id' in patch;
    let next = this.withButton(
      s.draft,
      pi,
      bi,
      (b, pad) => {
        const nb = { ...b, ...patch };
        if (patch.label !== undefined && !manualId && this.isFresh(b)) {
          nb.id = uniqueId(slug(patch.label) || 'button', [...pad.buttons.filter((_, i) => i !== bi).map((x) => x.id), ...this.reserved(pad)]);
        }
        return nb;
      },
      !manualId,
    );
    // A renamed button stays stopped by the buttons that stop it (unless another one keeps the old id).
    const pad = next.pads[pi]!;
    const id = pad.buttons[bi]!.id;
    if (id !== cur.id && !pad.buttons.some((b) => b.id === cur.id)) next = this.retarget(next, (x) => renamePattern(x, `${pad.id}/${cur.id}`, `${pad.id}/${id}`));
    this.commit(next, {}, field && `b:${pi}:${bi}:${field}`);
  }

  /** Every button's `stops` patterns through `fn` (identities kept). */
  private retarget(cfg: Config, fn: (pattern: string) => string | null): Config {
    let out = cfg;
    cfg.pads.forEach((pad, pi) =>
      pad.buttons.forEach((b, bi) => {
        if (!b.stops?.some((x) => fn(x) !== x)) return;
        out = this.withButton(out, pi, bi, (x) => {
          const stops = x.stops!.map(fn).filter((p): p is string => p !== null);
          const { stops: _s, ...rest } = x;
          return stops.length ? { ...x, stops } : rest;
        });
      }),
    );
    return out;
  }

  setActionType(type: Action['type']): void {
    const b = this.button();
    if (!b || b.action.type === type) return;
    // Switching straight back gives the action as it was (conversions can't always be exact).
    const prev = this.convertedFrom.get(b.action);
    const next = prev?.type === type ? prev : convertAction(b.action, type);
    this.convertedFrom.set(next, b.action);
    this.patchButton({ action: next });
  }

  button(bi = this.state.view.sel): Button | null {
    return bi === null ? null : (this.pad.buttons[bi] ?? null);
  }

  /** New button at an empty cell; selects it. */
  addButton(x: number, y: number): number | null {
    const s = this.state;
    const pad = this.pad;
    if (!fits(pad, { x, y, w: 1, h: 1 }).ok) return null;
    const b = newButton(pad, x, y, this.reserved(pad));
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
    const pad = this.pad;
    const b = pad.buttons[bi];
    if (!b) return null;
    let next = this.withPad(s.draft, s.view.pad, (p) => ({ ...p, buttons: p.buttons.filter((_, i) => i !== bi) }));
    // Nothing stops a button that's gone (undo brings both back).
    if (!next.pads[s.view.pad]!.buttons.some((x) => x.id === b.id)) next = this.retarget(next, (x) => renamePattern(x, `${pad.id}/${b.id}`, null));
    this.commit(next, { sel: null });
    return b;
  }

  /** New 1×1 button in the first free cell (keyboard / "Add a button"). */
  addAnywhere(): number | null {
    const spot = freeSpot(this.pad, 1, 1);
    return spot ? this.addButton(spot.x, spot.y) : null;
  }

  /** Copy into the first free spot (same size if possible), without its key. Null: the pad is full. */
  duplicate(bi = this.state.view.sel ?? -1): number | null {
    const s = this.state;
    const pad = this.pad;
    const b = pad.buttons[bi];
    if (!b) return null;
    const spot = freeSpot(pad, b.w, b.h) ?? freeSpot(pad, 1, 1);
    if (!spot) return null;
    const id = uniqueId(slug(b.label ? `${b.label} copy` : '') || `${b.id}-copy`, [...pad.buttons.map((x) => x.id), ...this.reserved(pad)]);
    const copy = copyOf(b, spot, id);
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
    const was = this.pad.id;
    let next = this.withPad(s.draft, pi, (p) => {
      const np = { ...p, ...patch };
      if (patch.name !== undefined && !manualId && this.isFresh(p)) {
        np.id = uniqueId(slug(patch.name) || 'pad', s.draft.pads.filter((_, i) => i !== pi).map((x) => x.id));
      }
      return np;
    });
    // A hand-typed id is final.
    if (manualId) this.fresh.delete(next.pads[pi] ?? {});
    // Its buttons stay stopped by the buttons that stop them (unless another pad keeps the old id).
    const id = next.pads[pi]!.id;
    if (id !== was && !next.pads.some((p) => p.id === was)) next = this.retarget(next, (x) => renamePattern(x, was, id));
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
    const gone = s.draft.pads[pi];
    if (s.draft.pads.length <= 1 || !gone) return false;
    let next: Config = { ...s.draft, pads: s.draft.pads.filter((_, i) => i !== pi) };
    if (!next.pads.some((p) => p.id === gone.id)) next = this.retarget(next, (x) => renamePattern(x, gone.id, null));
    this.commit(next, { pad: Math.min(pi, next.pads.length - 1), sel: null });
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
