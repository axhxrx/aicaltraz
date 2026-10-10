/**
 * Three-way merge of configs at pad and button granularity, for a draft whose host config changed
 * meanwhile: base = the host config the draft started from, mine = the draft, theirs = the host's
 * config now. A pad or button changed on one side only is taken from that side. The same one
 * changed on both sides (differently), or deleted on one side and changed on the other, is a
 * conflict: it is listed, and `choices` picks a side per conflict (default: mine).
 *
 * Identity: theirs is matched to base by id. Mine may have renamed things (a pad or button id is
 * editable), so `origins` can say which base pad/button each of mine comes from; by default it's
 * the same id. Pure: no DOM, no editor state.
 */
import type { Button, Config, Pad } from '../../core/config.ts';
import { nameOf, same } from './ops.ts';

export type Side = 'mine' | 'theirs';

/** Per pad of mine (by index): the base pad id it comes from, and the base button id of each of its buttons. null = new. */
export type Origins = { pad: string | null; buttons: (string | null)[] }[];

export interface Conflict {
  /** Key for `choices`. */
  key: string;
  what: 'button' | 'pad' | 'order' | 'settings';
  /** "Main", "Main › “Lamp”", "Pad order". */
  title: string;
  /** What each side did to it. */
  mine: 'changed' | 'deleted' | 'added';
  theirs: 'changed' | 'deleted' | 'added';
  /** Fields each side changed: top-level keys of the button, or of the pad without its buttons. */
  mineFields: string[];
  theirsFields: string[];
}

export interface MergeResult {
  config: Config;
  /** How many of theirs' changes were taken in (buttons, pads, the pad order, settings). */
  taken: number;
  conflicts: Conflict[];
  /** Each pad and button of `config` → its counterparts (same identity) in mine and in theirs. */
  links: Map<object, { mine?: object; theirs?: object }>;
}

const settingsOf = ({ buttons: _b, ...s }: Pad) => s;
const topOf = ({ pads: _p, ...s }: Config) => s;
const padName = (p: Pad) => p.name.trim() || p.id;

/** Top-level keys whose values differ. */
function changedKeys(from: object, to: object): string[] {
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
}

export function merge3(base: Config, mine: Config, theirs: Config, opts: { origins?: Origins; choices?: Record<string, Side> } = {}): MergeResult {
  const pick = (key: string): Side => opts.choices?.[key] ?? 'mine';
  const conflicts: Conflict[] = [];
  const links = new Map<object, { mine?: object; theirs?: object }>();
  let taken = 0;
  const conflict = (c: Omit<Conflict, 'mineFields' | 'theirsFields'> & Partial<Conflict>): Side => {
    conflicts.push({ mineFields: [], theirsFields: [], ...c });
    return pick(c.key);
  };

  /** Identities (base ids) of a list matched against base, given explicit origins or by id. Each base id claimed once. */
  const identify = <T extends { id: string }>(list: T[], baseIds: Set<string>, origins: (string | null)[] | undefined): (string | null)[] => {
    const claimed = new Set<string>();
    return list.map((x, i) => {
      const o = origins ? (origins[i] ?? null) : x.id;
      if (o === null || !baseIds.has(o) || claimed.has(o)) return null;
      claimed.add(o);
      return o;
    });
  };

  // ---- buttons of a pad all three sides have ----
  const mergeButtons = (B: Pad, M: Pad, T: Pad, origins: (string | null)[] | undefined): Button[] => {
    const bBy = new Map(B.buttons.map((b) => [b.id, b]));
    const tBy = new Map(T.buttons.map((b) => [b.id, b]));
    const ident = identify(M.buttons, new Set(bBy.keys()), origins);
    const mineHas = new Set(ident.filter((o): o is string => o !== null));
    const pairedT = new Set<string>();
    const out: Button[] = [];
    const push = (b: Button, link: { mine?: Button; theirs?: Button }) => (out.push(b), links.set(b, link));
    const title = (b: Button) => `${padName(M)} › ${nameOf(b)}`;

    M.buttons.forEach((m, j) => {
      const o = ident[j] ?? null;
      if (o === null) {
        // New in mine; theirs may have added one with the same id.
        const t = bBy.has(m.id) ? undefined : tBy.get(m.id);
        if (!t || pairedT.has(t.id)) return push(m, { mine: m });
        pairedT.add(t.id);
        if (same(m, t)) return push(m, { mine: m, theirs: t });
        const side = conflict({ key: `button+:${B.id}/${m.id}`, what: 'button', title: title(m), mine: 'added', theirs: 'added', mineFields: changedKeys(t, m) });
        if (side === 'theirs') taken++;
        return push(side === 'theirs' ? t : m, { mine: m, theirs: t });
      }
      const b = bBy.get(o)!;
      const t = tBy.get(o);
      pairedT.add(o);
      const key = `button:${B.id}/${o}`;
      if (!t) {
        // Theirs deleted it.
        if (same(m, b) || conflict({ key, what: 'button', title: title(m), mine: 'changed', theirs: 'deleted', mineFields: changedKeys(b, m) }) === 'theirs') return void taken++;
        return push(m, { mine: m });
      }
      const mc = !same(m, b);
      const tc = !same(t, b);
      const theirsWins = tc && (!mc || (!same(m, t) && conflict({ key, what: 'button', title: title(m), mine: 'changed', theirs: 'changed', mineFields: changedKeys(b, m), theirsFields: changedKeys(b, t) }) === 'theirs'));
      if (theirsWins) taken++;
      push(theirsWins ? t : m, { mine: m, theirs: t });
    });
    // Base buttons mine deleted: gone, unless theirs changed them.
    for (const b of B.buttons) {
      if (mineHas.has(b.id)) continue;
      pairedT.add(b.id);
      const t = tBy.get(b.id);
      if (!t || same(t, b)) continue;
      if (conflict({ key: `button:${B.id}/${b.id}`, what: 'button', title: `${padName(M)} › ${nameOf(t)}`, mine: 'deleted', theirs: 'changed', theirsFields: changedKeys(b, t) }) === 'theirs') {
        taken++;
        push(t, { theirs: t });
      }
    }
    // Buttons theirs added.
    for (const t of T.buttons)
      if (!pairedT.has(t.id) && !bBy.has(t.id)) {
        taken++;
        push(t, { theirs: t });
      }
    return out;
  };

  /** A pad taken whole from one side (with its buttons as they are there). */
  const whole = (P: Pad, link: { mine?: Pad; theirs?: Pad }, side: Side): Pad => {
    links.set(P, link);
    for (const b of P.buttons) links.set(b, side === 'mine' ? { mine: b } : { theirs: b });
    return P;
  };

  // ---- pads ----
  const baseById = new Map(base.pads.map((p) => [p.id, p]));
  const theirsById = new Map(theirs.pads.map((p) => [p.id, p]));
  const mineIdent = identify(mine.pads, new Set(baseById.keys()), opts.origins?.map((o) => o.pad));
  const mineAt = new Map<string, number>();
  mineIdent.forEach((o, i) => o !== null && mineAt.set(o, i));
  /** Merged pads by identity: `b:<base id>`, `m:<index in mine>` (new in mine), `t:<id>` (new in theirs). */
  const out = new Map<string, Pad>();

  for (const B of base.pads) {
    const mi = mineAt.get(B.id);
    const M = mi === undefined ? undefined : mine.pads[mi];
    const T = theirsById.get(B.id);
    const key = `pad:${B.id}`;
    const id = `b:${B.id}`;
    if (M && T) {
      const sb = settingsOf(B);
      const sm = settingsOf(M);
      const st = settingsOf(T);
      const tc = !same(st, sb);
      const mc = !same(sm, sb);
      const theirsWins = tc && (!mc || (!same(sm, st) && conflict({ key, what: 'pad', title: padName(M), mine: 'changed', theirs: 'changed', mineFields: changedKeys(sb, sm), theirsFields: changedKeys(sb, st) }) === 'theirs'));
      if (theirsWins) taken++;
      const buttons = mergeButtons(B, M, T, opts.origins?.[mi!]?.buttons);
      const unchanged = !theirsWins && buttons.length === M.buttons.length && buttons.every((b, j) => b === M.buttons[j]);
      const P: Pad = unchanged ? M : { ...(theirsWins ? st : sm), buttons };
      links.set(P, { mine: M, theirs: T });
      out.set(id, P);
    } else if (M) {
      // Theirs deleted the pad.
      if (same(M, B) || conflict({ key, what: 'pad', title: padName(M), mine: 'changed', theirs: 'deleted', mineFields: changedKeys(settingsOf(B), settingsOf(M)) }) === 'theirs') taken++;
      else out.set(id, whole(M, { mine: M }, 'mine'));
    } else if (T && !same(T, B)) {
      // Mine deleted it, theirs changed it.
      if (conflict({ key, what: 'pad', title: padName(T), mine: 'deleted', theirs: 'changed', theirsFields: changedKeys(settingsOf(B), settingsOf(T)) }) === 'theirs') {
        taken++;
        out.set(id, whole(T, { theirs: T }, 'theirs'));
      }
    }
  }
  /** Pads both sides added with the same id: theirs id → index in mine. */
  const pairedT = new Map<string, number>();
  mine.pads.forEach((M, i) => {
    if (mineIdent[i] !== null) return;
    const T = baseById.has(M.id) ? undefined : theirsById.get(M.id);
    if (!T || pairedT.has(T.id)) return void out.set(`m:${i}`, whole(M, { mine: M }, 'mine'));
    // Both added a pad with this id.
    pairedT.set(T.id, i);
    const side = same(M, T) ? 'mine' : conflict({ key: `pad+:${M.id}`, what: 'pad', title: padName(M), mine: 'added', theirs: 'added', mineFields: changedKeys(settingsOf(T), settingsOf(M)) });
    if (side === 'theirs') taken++;
    out.set(`m:${i}`, whole(side === 'theirs' ? T : M, { mine: M, theirs: T }, side));
  });
  for (const T of theirs.pads)
    if (!baseById.has(T.id) && !pairedT.has(T.id)) {
      taken++;
      out.set(`t:${T.id}`, whole(T, { theirs: T }, 'theirs'));
    }

  // ---- pad order: like a unit of its own ----
  const mineSeq = mine.pads.map((_p, i) => (mineIdent[i] !== null ? `b:${mineIdent[i]}` : `m:${i}`));
  const theirsSeq = theirs.pads.map((p) => (baseById.has(p.id) ? `b:${p.id}` : pairedT.has(p.id) ? `m:${pairedT.get(p.id)}` : `t:${p.id}`));
  const common = (seq: string[]) => seq.filter((k) => k.startsWith('b:') && mineSeq.includes(k) && theirsSeq.includes(k)).join('\n');
  const baseSeq = base.pads.map((p) => `b:${p.id}`);
  const mineMoved = common(mineSeq) !== common(baseSeq);
  const theirsMoved = common(theirsSeq) !== common(baseSeq);
  let order: Side = 'mine';
  if (theirsMoved && (!mineMoved || (common(mineSeq) !== common(theirsSeq) && conflict({ key: 'order', what: 'order', title: 'Pad order', mine: 'changed', theirs: 'changed' }) === 'theirs'))) {
    order = 'theirs';
    taken++;
  }
  const [first, second] = order === 'mine' ? [mineSeq, theirsSeq] : [theirsSeq, mineSeq];
  const seq = first.filter((k) => out.has(k));
  // The other side's pads that aren't placed yet go right after their predecessor there.
  second.forEach((k, i) => {
    if (!out.has(k) || seq.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = seq.indexOf(second[j]!);
      if (p >= 0) {
        at = p + 1;
        break;
      }
    }
    seq.splice(at, 0, k);
  });
  for (const k of out.keys()) if (!seq.includes(k)) seq.push(k);
  let pads = seq.map((k) => out.get(k)!);
  if (!pads.length) {
    // Nothing left (each side deleted the other's last pad): keep theirs rather than no pads at all.
    pads = theirs.pads.map((T) => whole(T, { theirs: T }, 'theirs'));
    taken++;
  }

  // ---- settings (everything but the pads: server, $schema) ----
  const tb = topOf(base);
  const tm = topOf(mine);
  const tt = topOf(theirs);
  const topTheirs = !same(tt, tb) && (same(tm, tb) || (!same(tm, tt) && conflict({ key: 'settings', what: 'settings', title: 'Host settings', mine: 'changed', theirs: 'changed', mineFields: changedKeys(tb, tm), theirsFields: changedKeys(tb, tt) }) === 'theirs'));
  if (topTheirs) taken++;

  return { config: { ...(topTheirs ? tt : tm), pads } as Config, taken, conflicts, links };
}
