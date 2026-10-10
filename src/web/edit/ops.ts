/** Pure draft helpers: placement checks, ids, colors, new buttons/pads, action conversion. */
import { Button, Pad, type Action, type Config } from '../../core/config.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Fit = { ok: true } | { ok: false; reason: 'bounds' } | { ok: false; reason: 'overlap'; other: Button };

export const rectOf = (b: Rect): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
export const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Can `r` go on `pad` (ignoring the button at index `self`)? */
export function fits(pad: Pick<Pad, 'cols' | 'rows' | 'buttons'>, r: Rect, self = -1): Fit {
  if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > pad.cols || r.y + r.h > pad.rows) return { ok: false, reason: 'bounds' };
  const other = pad.buttons.find((b, i) => i !== self && overlaps(b, r));
  return other ? { ok: false, reason: 'overlap', other } : { ok: true };
}

/** Index of the button covering cell x,y, or -1. */
export const occupant = (pad: Pad, x: number, y: number) => pad.buttons.findIndex((b) => overlaps(b, { x, y, w: 1, h: 1 }));

/** Buttons that would stick out of a cols×rows grid. */
export const clipped = (pad: Pad, cols: number, rows: number) => pad.buttons.filter((b) => b.x + b.w > cols || b.y + b.h > rows);

export const nameOf = (b: Pick<Button, 'label' | 'id'>) => (b.label.trim() ? `“${b.label.trim()}”` : b.id);

/** "“A”", "“A” and “B”", "“A”, “B” and 2 more". */
export function names(list: Pick<Button, 'label' | 'id'>[]): string {
  const n = list.map(nameOf);
  if (n.length <= 2) return n.join(' and ');
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} more`;
}

/** Why a placement was refused ("overlaps “Fill light”"), for toasts and the drag preview. */
export const refusal = (f: Fit, pad: Pick<Pad, 'cols' | 'rows'>) =>
  f.ok ? '' : f.reason === 'bounds' ? `outside the ${pad.cols}×${pad.rows} grid` : `overlaps ${nameOf(f.other)}`;

/** Free spot for a w×h button, scanning row by row. */
export function freeSpot(pad: Pad, w: number, h: number): Rect | null {
  for (let y = 0; y + h <= pad.rows; y++) for (let x = 0; x + w <= pad.cols; x++) if (fits(pad, { x, y, w, h }).ok) return { x, y, w, h };
  return null;
}

// ---- ids --------------------------------------------------------------------------------------

export const ID_RE = /^[\w-]+$/;

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) if (!set.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- colors -----------------------------------------------------------------------------------

/** Saturated, high-visibility, and clear of the SUCCESS green / FAILURE red / OFFLINE grey. */
export const PALETTE = ['#2f6fde', '#facc15', '#db2777', '#7c3aed', '#f97316', '#0891b2', '#4338ca', '#0d9488', '#c026d3', '#f4f4f5'];

export function nextColor(pad: Pad): string {
  const used = new Set(pad.buttons.map((b) => b.color.toLowerCase()));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[pad.buttons.length % PALETTE.length]!;
}

// ---- new things -------------------------------------------------------------------------------

/** Harmless, and shows off status + result text on the first press. */
export const STARTER_SCRIPT = "echo '@status working'; sleep 1; echo 'Done'";

export function newButton(pad: Pad, x: number, y: number): Button {
  const ids = new Set(pad.buttons.map((b) => b.id));
  let n = pad.buttons.length + 1;
  while (ids.has(`button-${n}`)) n++;
  return Button.parse({ id: `button-${n}`, label: `Button ${n}`, color: nextColor(pad), x, y, action: { type: 'shell', script: STARTER_SCRIPT } });
}

export function newPad(cfg: Config): Pad {
  const ids = new Set(cfg.pads.map((p) => p.id));
  let n = cfg.pads.length + 1;
  while (ids.has(`pad-${n}`)) n++;
  return Pad.parse({ id: `pad-${n}`, name: `Pad ${n}`, cols: 2, rows: 3 });
}

// ---- actions ----------------------------------------------------------------------------------

const SAFE_WORD = /^[\w./:=@%+,~-]+$/;
export const shQuote = (s: string) => (SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Words of a simple command line (quotes only), or null if it uses any other shell syntax. */
function simpleWords(script: string): string[] | null {
  if (/[\n;&|<>$`\\(){}*?[\]#]/.test(script)) return null;
  const out: string[] = [];
  for (const m of script.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
    if (m[3]?.match(/['"]/)) return null;
    out.push(m[1] ?? m[2] ?? m[3]!);
  }
  return out;
}

/** Switch exec ⇄ shell keeping the behavior (simple commands split into argv, anything else via sh -c). */
export function convertAction(a: Action, type: Action['type']): Action {
  if (a.type === type) return a;
  const common = { ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.env !== undefined ? { env: a.env } : {}) };
  if (type === 'shell') {
    const ex = a as Extract<Action, { type: 'exec' }>;
    return { type, script: [ex.command, ...ex.args].filter((w, i) => i > 0 || w).map(shQuote).join(' '), ...common };
  }
  const sh = a as Extract<Action, { type: 'shell' }>;
  const words = simpleWords(sh.script);
  if (words) return { type, command: words[0] ?? '', args: words.slice(1), ...common };
  return { type, command: sh.shell ?? '/bin/sh', args: ['-c', sh.script], ...common };
}
