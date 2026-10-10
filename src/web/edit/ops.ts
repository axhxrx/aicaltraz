/** Pure draft helpers: placement checks, ids, colors, new buttons/pads, action conversion. */
import { Button, Pad, type Action, type Config } from '../../core/config.ts';

/** JSON with sorted keys and undefined dropped: equal configs compare equal regardless of key order. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

export const same = (a: unknown, b: unknown) => a === b || stable(a) === stable(b);

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

/** sRGB bytes → OKLCH lightness, chroma, hue (degrees). */
export function oklch([r, g, b]: readonly [number, number, number]): { l: number; c: number; h: number } {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l: L, c: Math.hypot(a, bb), h: h < 0 ? h + 360 : h };
}

/**
 * Does a READY color read as a result? SUCCESS floods green (#2bd46e, hue ≈151°) and FAILURE red
 * (#e3262b, ≈26°): a button that is already that color makes the two hard to tell apart. By OKLCH
 * hue and chroma, so the palette's pink, orange and teal are fine.
 */
export function stateLookalike(rgb: readonly [number, number, number]): 'success' | 'failure' | null {
  const { c, h } = oklch(rgb);
  if (c < 0.1) return null;
  if (h >= 10 && h <= 36) return 'failure';
  if (h >= 125 && h <= 170) return 'success';
  return null;
}

// ---- new things -------------------------------------------------------------------------------

/** What a new button runs until it's set up: it fails, saying so (a ✓ "Done" would hide that nothing is set up yet). */
export const NO_ACTION_TEXT = 'No action set — edit this button';
export const STARTER_SCRIPT = `echo '${NO_ACTION_TEXT}' >&2; exit 1`;
/** Earlier versions' starter scripts: placeholders too. */
const OLD_STARTERS = new Set(["echo '@status working'; sleep 1; echo 'Done'"]);

/** A new button's placeholder action, never set up: switching its type starts the other type blank. */
export const isPlaceholder = (a: Action) =>
  a.type === 'shell' && (a.script === STARTER_SCRIPT || OLD_STARTERS.has(a.script)) && a.shell === undefined && a.cwd === undefined && a.env === undefined;

/**
 * `reserved`: ids to stay clear of besides the pad's own, i.e. the host's buttons on this pad. A new
 * button must never take the id of one deleted in the draft: until the save, that id still names
 * the host's button (its action, its run history).
 */
export function newButton(pad: Pad, x: number, y: number, reserved: Iterable<string> = []): Button {
  const ids = new Set([...pad.buttons.map((b) => b.id), ...reserved]);
  let n = pad.buttons.length + 1;
  while (ids.has(`button-${n}`)) n++;
  return Button.parse({ id: `button-${n}`, label: `Button ${n}`, color: nextColor(pad), x, y, action: { type: 'shell', script: STARTER_SCRIPT } });
}

export function newPad(cfg: Config, reserved: Iterable<string> = []): Pad {
  const ids = new Set([...cfg.pads.map((p) => p.id), ...reserved]);
  let n = cfg.pads.length + 1;
  while (ids.has(`pad-${n}`)) n++;
  return Pad.parse({ id: `pad-${n}`, name: `Pad ${n}`, cols: 2, rows: 3 });
}

// ---- stops ------------------------------------------------------------------------------------

/**
 * A `stops` pattern after a rename or delete. `from`/`to`: a button (`pad/button`) or a pad (`pad`,
 * which carries its `pad/…` patterns along). `to` null: it was deleted, and patterns naming it go (null).
 */
export function renamePattern(pattern: string, from: string, to: string | null): string | null {
  if (from.includes('/')) return pattern === from ? to : pattern;
  if (!pattern.startsWith(`${from}/`)) return pattern;
  return to === null ? null : `${to}/${pattern.slice(from.length + 1)}`;
}

/** What `pattern` names in `cfg` (itself left out, as the host does): `null` when it names nothing there. */
export function stopTargets(cfg: Pick<Config, 'pads'>, pattern: string, self?: { pad: string; button: string }): { pad: Pad; button: Button }[] | null {
  const all = cfg.pads.flatMap((pad) => pad.buttons.map((button) => ({ pad, button })));
  const out =
    pattern === '*'
      ? all
      : pattern.endsWith('/*')
        ? cfg.pads.some((p) => p.id === pattern.slice(0, -2))
          ? all.filter((t) => t.pad.id === pattern.slice(0, -2))
          : null
        : all.filter((t) => `${t.pad.id}/${t.button.id}` === pattern);
  if (!out || (!out.length && pattern !== '*' && !pattern.endsWith('/*'))) return null;
  return self ? out.filter((t) => t.pad.id !== self.pad || t.button.id !== self.button) : out;
}

/** A copy for "Duplicate": new id and spot, and no key binding (one key, one button). */
export function copyOf(b: Button, spot: Rect, id: string): Button {
  const { key: _key, ...rest } = structuredClone(b);
  return { ...rest, ...spot, id, label: b.label ? `${b.label} copy` : '' };
}

// ---- actions ----------------------------------------------------------------------------------

/**
 * Characters a shell word may have and still mean exactly itself in sh, bash, zsh and fish: no
 * quotes, `~`, `$`, globs, backslashes or other syntax. (`=` is fine inside an argument, but not in
 * a command word: `NAME=value` there is an environment assignment.)
 */
const PLAIN = /^[\w./:@%+,-]+$/;
const PLAIN_ARG = /^[\w./:@%+,=-]+$/;
/** Words that mean something else to a shell than a program of that name. */
const SHELL_WORDS = new Set(
  'cd export unset source . exec eval set alias unalias exit return shift trap ulimit umask wait read readonly local declare typeset times hash type command builtin jobs fg bg time if then else elif fi for while until do done case esac function select coproc'.split(' '),
);

/** Does `s` mean exactly itself to a shell, as the command word (`cmd`) or as an argument? */
const plain = (s: string, cmd: boolean) => (cmd ? PLAIN.test(s) && !SHELL_WORDS.has(s) : PLAIN_ARG.test(s) && !s.startsWith('='));

/** Quoted for a POSIX shell, unless it means exactly itself as it is. */
export const shQuote = (s: string, cmd = false) => (plain(s, cmd) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The words of a script that is nothing but a program and its arguments, or null if it uses
 * anything a shell would interpret (quotes, `~`, `NAME=value`, globs, `$`, pipes, `;`, builtins…).
 */
export function simpleWords(script: string): string[] | null {
  const words = script.trim().split(/[ \t]+/);
  return words.every((w, i) => plain(w, i === 0)) ? words : null;
}

/** Shells whose `-c SCRIPT` runs SCRIPT, by file name. */
const SHELLS = /^(?:.*[/\\])?(?:sh|bash|zsh|dash|ksh|mksh|ash|fish)$/;

/**
 * Switch exec ⇄ shell keeping the behavior: simple commands split into argv, anything else via
 * `sh -c` (and back). To `none`: nothing to keep. From `none` or a placeholder (a new button's
 * starter): there's nothing to keep either, so the new type starts blank (no sample `-c` args).
 */
export function convertAction(a: Action, type: Action['type']): Action {
  if (a.type === type) return a;
  if (type === 'none') return { type };
  if (a.type === 'none' || isPlaceholder(a)) return type === 'exec' ? { type, command: '', args: [] } : { type, script: '' };
  const common = { ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.env !== undefined ? { env: a.env } : {}) };
  if (type === 'shell') {
    const ex = a as Extract<Action, { type: 'exec' }>;
    // `sh -c SCRIPT` is that script, run by that shell.
    if (SHELLS.test(ex.command) && ex.args.length === 2 && ex.args[0] === '-c' && ex.args[1]!.trim()) return { type, script: ex.args[1]!, shell: ex.command, ...common };
    const words = ex.command ? [ex.command, ...ex.args] : ex.args;
    return { type, script: words.map((w, i) => shQuote(w, i === 0)).join(' '), ...common };
  }
  const sh = a as Extract<Action, { type: 'shell' }>;
  const words = simpleWords(sh.script);
  if (words) return { type, command: words[0]!, args: words.slice(1), ...common };
  return { type, command: sh.shell ?? '/bin/sh', args: ['-c', sh.script], ...common };
}
