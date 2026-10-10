/**
 * Config file problems in words someone editing the file can act on:
 *
 *   invalid JSON at line 12, column 5: a comma is missing between "holdMs" and "key"
 *   pad "lights" › button "key": holdMs must be ≤ 5000 (line 42)
 *
 * parseConfig's own errors (`pads.0.buttons.5.holdMs: …`, index paths) stay as they are: the editor
 * maps those onto its fields, and PUT /api/config answers with them. These are for the file's errors:
 * the CLI, the host log, `configError` and a 409's `errors`.
 */
import { Button, Config, ENV_NAME_MESSAGE, ExecAction, NoneAction, Pad, ShellAction } from '../core/config.ts';

type Seg = string | number;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- JSON syntax ------------------------------------------------------------------------------

export interface JsonSyntaxError {
  /** 1-based; columns count characters (code points). */
  line: number;
  column: number;
  message: string;
}

class SyntaxAt extends Error {
  constructor(
    readonly at: number,
    message: string,
  ) {
    super(message);
  }
}

/** Nesting beyond this isn't scanned (a config nests 5 deep); JSON.parse's own message is used instead. */
const MAX_DEPTH = 500;
class TooDeep extends Error {}

const show = (c: string | undefined) => (c === undefined ? 'the end of the file' : /^[\x21-\x7e]$/.test(c) ? `"${c}"` : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);

/**
 * Strict JSON (RFC 8259) scanner: finds the first error, with a message saying what to fix, or (for
 * valid text) records where each value starts, by path.
 */
class Scanner {
  i = 0;
  private open: { ch: string; at: number }[] = [];

  constructor(
    private readonly s: string,
    private readonly positions?: Map<string, number>,
  ) {}

  run() {
    this.ws();
    if (this.i >= this.s.length) throw new SyntaxAt(0, 'the file is empty');
    this.record([]);
    this.value([], 0, 'the config');
    this.ws();
    if (this.i < this.s.length) {
      const c = this.s[this.i]!;
      throw new SyntaxAt(this.i, `unexpected ${show(c)} after the end of the JSON${c === '}' || c === ']' ? ` (one "${c}" too many?)` : ''}`);
    }
  }

  private fail(at: number, message: string): never {
    throw new SyntaxAt(at, message);
  }

  private where(at: number) {
    const { line, column } = lineCol(this.s, at);
    return `line ${line}, column ${column}`;
  }

  private eof(): never {
    const top = this.open.at(-1);
    this.fail(this.s.length, top ? `the file ends before the "${top.ch}" at ${this.where(top.at)} is closed` : 'unexpected end of the file');
  }

  private ws() {
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++;
      else if (c === 47 && (this.s[this.i + 1] === '/' || this.s[this.i + 1] === '*')) this.fail(this.i, 'comments are not allowed in JSON');
      else return;
    }
  }

  private record(path: Seg[]) {
    if (this.positions && path.length <= 12) this.positions.set(JSON.stringify(path), this.i);
  }

  private value(path: Seg[], depth: number, what: string) {
    if (depth > MAX_DEPTH) throw new TooDeep();
    this.ws();
    const c = this.s[this.i];
    switch (c) {
      case '{':
        return this.object(path, depth);
      case '[':
        return this.array(path, depth);
      case '"':
        return void this.string();
      case undefined:
        return this.eof();
      case "'":
        return this.fail(this.i, 'single quotes are not allowed in JSON: use double quotes ("…")');
      case '-':
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        return this.number();
      case '+':
        return this.fail(this.i, 'numbers can\'t start with "+"');
      case '.':
        return this.fail(this.i, 'numbers need a digit before the decimal point (0.5, not .5)');
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 64))?.[0];
    if (word === 'true' || word === 'false' || word === 'null') return void (this.i += word.length);
    if (word) {
      if (/^(true|false|null|none|nil)$/i.test(word)) this.fail(this.i, `${word} isn't JSON: write true, false or null (lowercase)`);
      if (word === 'NaN' || word === 'Infinity' || word === 'undefined') this.fail(this.i, `${word} isn't allowed in JSON`);
      const near = ['true', 'false', 'null'].find((w) => editDistance(word.toLowerCase(), w) <= 1);
      this.fail(this.i, near ? `unexpected ${word} (did you mean ${near}?)` : `unexpected ${word}: text needs double quotes ("${word}")`);
    }
    this.fail(this.i, `expected a value for ${what}, found ${show(c)}`);
  }

  private object(path: Seg[], depth: number) {
    this.open.push({ ch: '{', at: this.i });
    this.i++;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      this.open.pop();
      return;
    }
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === undefined) this.eof();
      if (c !== '"') {
        if (c === "'") this.fail(this.i, 'property names need double quotes ("…"), not single quotes');
        const word = /^[A-Za-z_$][\w$-]*/.exec(this.s.slice(this.i, this.i + 64))?.[0];
        if (word) this.fail(this.i, `property names need double quotes: "${word}"`);
        this.fail(this.i, `expected a property name in double quotes, found ${show(c)}`);
      }
      const keyAt = this.i;
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail(this.i, `expected ":" after the property name "${key}", found ${show(this.s[this.i])}`);
      this.i++;
      const sub = [...path, key];
      if (this.positions && sub.length <= 12) this.positions.set(JSON.stringify(sub), keyAt);
      this.value(sub, depth + 1, `"${key}"`);
      this.ws();
      const next = this.s[this.i];
      if (next === '}') {
        this.i++;
        this.open.pop();
        return;
      }
      if (next === undefined) this.eof();
      if (next === '"') {
        const nextKey = /^"((?:[^"\\\n]|\\.)*)"/.exec(this.s.slice(this.i, this.i + 200))?.[1];
        this.fail(this.i, `a comma is missing between "${key}" and ${nextKey !== undefined ? `"${nextKey}"` : 'the next property'}`);
      }
      if (next !== ',') this.fail(this.i, `expected "," or "}" after the value of "${key}", found ${show(next)}`);
      const comma = this.i;
      this.i++;
      this.ws();
      if (this.s[this.i] === '}') this.fail(comma, 'a comma before "}": JSON doesn\'t allow a trailing comma');
    }
  }

  private array(path: Seg[], depth: number) {
    this.open.push({ ch: '[', at: this.i });
    this.i++;
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      this.open.pop();
      return;
    }
    for (let n = 0; ; n++) {
      const sub = [...path, n];
      this.ws();
      this.record(sub);
      this.value(sub, depth + 1, 'a list item');
      this.ws();
      const next = this.s[this.i];
      if (next === ']') {
        this.i++;
        this.open.pop();
        return;
      }
      if (next === undefined) this.eof();
      if (next !== undefined && /["{[\-0-9tfn]/.test(next)) this.fail(this.i, 'a comma is missing between two list items');
      if (next !== ',') this.fail(this.i, `expected "," or "]" after a list item, found ${show(next)}`);
      const comma = this.i;
      this.i++;
      this.ws();
      if (this.s[this.i] === ']') this.fail(comma, 'a comma before "]": JSON doesn\'t allow a trailing comma');
    }
  }

  /** At the opening quote; returns the string's value. */
  private string(): string {
    const start = this.i;
    this.i++;
    let out = '';
    let from = this.i;
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (Number.isNaN(c)) this.fail(start, 'this string is never closed (a missing ")');
      if (c === 34) {
        out += this.s.slice(from, this.i);
        this.i++;
        return out;
      }
      if (c === 10 || c === 13) this.fail(this.i, `a line break inside a string: is the closing " missing? (the string starts at column ${lineCol(this.s, start).column}; write \\n for a line break)`);
      if (c < 32) this.fail(this.i, `a control character (${show(this.s[this.i])}) inside a string: write it escaped${c === 9 ? ' (\\t for a tab)' : ''}`);
      if (c === 92) {
        out += this.s.slice(from, this.i);
        const e = this.s[this.i + 1];
        if (e === 'u') {
          const hex = this.s.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(this.i, 'invalid \\u escape: it needs 4 hex digits (\\u00e9)');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          out += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[e] ?? e;
          this.i += 2;
        } else if (e === undefined) this.fail(start, 'this string is never closed (a missing ")');
        else this.fail(this.i, `invalid escape "\\${e}" in a string (write \\\\ for a backslash)`);
        from = this.i;
        continue;
      }
      this.i++;
    }
  }

  private number() {
    const s = this.s;
    const digits = () => {
      const from = this.i;
      while (s.charCodeAt(this.i) >= 48 && s.charCodeAt(this.i) <= 57) this.i++;
      return this.i - from;
    };
    if (s[this.i] === '-') {
      this.i++;
      if (!/[0-9]/.test(s[this.i] ?? '')) this.fail(this.i, 'expected a digit after "-"');
    }
    if (s[this.i] === '0') {
      this.i++;
      if (/[0-9]/.test(s[this.i] ?? '')) this.fail(this.i - 1, 'numbers can\'t have leading zeros (write 7, not 07)');
    } else digits();
    if (s[this.i] === '.') {
      this.i++;
      if (!digits()) this.fail(this.i, 'expected a digit after the decimal point');
    }
    if (s[this.i] === 'e' || s[this.i] === 'E') {
      this.i++;
      if (s[this.i] === '+' || s[this.i] === '-') this.i++;
      if (!digits()) this.fail(this.i, 'expected a digit in the exponent');
    }
    if (/[A-Za-z_$]/.test(s[this.i] ?? '')) this.fail(this.i, `unexpected ${show(s[this.i])} right after a number`);
  }
}

/** 1-based line and column (in code points) of `offset`. `starts`: line start offsets, if already computed. */
export function lineCol(text: string, offset: number, starts?: number[]): { line: number; column: number } {
  let line: number;
  let start: number;
  if (starts) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    line = lo + 1;
    start = starts[lo]!;
  } else {
    line = 1;
    start = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
      line++;
      start = i + 1;
    }
  }
  let column = 1;
  for (let i = start; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) column++; // a low surrogate continues the character before it
  }
  return { line, column };
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/** The first syntax error in `text`, or undefined when it is valid JSON (or nests too deep to tell). */
export function findJsonError(text: string): JsonSyntaxError | undefined {
  try {
    new Scanner(text).run();
    return undefined;
  } catch (e) {
    if (!(e instanceof SyntaxAt)) return undefined;
    return { ...lineCol(text, e.at), message: e.message };
  }
}

/** `invalid JSON at line 3, column 7: …` for text JSON.parse refused (`parseError` is what it threw). */
export function describeJsonError(text: string, parseError?: unknown): string {
  const found = findJsonError(text);
  if (found) return `invalid JSON at line ${found.line}, column ${found.column}: ${found.message}`;
  const msg = (parseError as Error | undefined)?.message?.replace(/^JSON Parse error: /, '') ?? 'not valid JSON';
  return `invalid JSON: ${msg}`;
}

/** Where each value (object members: their key) starts, by JSON.stringify(path). Undefined for invalid JSON. */
function valuePositions(text: string): Map<string, number> | undefined {
  const positions = new Map<string, number>();
  try {
    new Scanner(text, positions).run();
  } catch {
    return positions.size ? positions : undefined;
  }
  return positions;
}

// ---- validation errors, by name ---------------------------------------------------------------

/** Field names of each object, for "did you mean". */
function shapeKeys(schema: unknown): string[] {
  let s = schema as { shape?: Record<string, unknown>; _zod?: { def?: { innerType?: unknown } } } | undefined;
  for (let n = 0; s && !s.shape && n < 5; n++) s = s._zod?.def?.innerType as typeof s;
  return s?.shape ? Object.keys(s.shape) : [];
}
const KEYS = {
  root: shapeKeys(Config),
  server: shapeKeys(Config.shape.server),
  pad: shapeKeys(Pad),
  button: shapeKeys(Button),
  action: [...new Set([...shapeKeys(ExecAction), ...shapeKeys(ShellAction), ...shapeKeys(NoneAction)])],
};

const ACTION_KEYS: Record<string, string[]> = { exec: shapeKeys(ExecAction), shell: shapeKeys(ShellAction), none: shapeKeys(NoneAction) };

function knownKeys(path: Seg[], raw: unknown): string[] {
  const p = path.map((s) => (typeof s === 'number' ? '#' : s)).join('.');
  if (p === '') return KEYS.root;
  if (p === 'server') return KEYS.server;
  if (p === 'pads.#') return KEYS.pad;
  if (p === 'pads.#.buttons.#') return KEYS.button;
  if (p === 'pads.#.buttons.#.action') {
    const type = (valueAt(raw, path) as { type?: unknown } | undefined)?.type;
    return typeof type === 'string' && ACTION_KEYS[type] ? ACTION_KEYS[type] : KEYS.action;
  }
  return [];
}

/** ` ("script" is for shell actions)` when an action has a field of another action type. */
function otherType(key: string, path: Seg[]): string {
  if (path.at(-1) !== 'action') return '';
  const types = Object.entries(ACTION_KEYS)
    .filter(([, keys]) => keys.includes(key))
    .map(([t]) => t);
  return types.length && key !== 'type' ? ` ("${key}" is for ${types.join(' and ')} actions)` : '';
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** ` (did you mean "color"?)` for "colour", "Color", "hold_ms"… */
function suggest(key: string, known: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[-_ ]/g, '');
  known = known.filter((k) => k !== key);
  const same = known.find((k) => norm(k) === norm(key));
  if (same) return ` (did you mean "${same}"?)`;
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best && bestD <= (key.length > 5 ? 2 : 1) ? ` (did you mean "${best}"?)` : '';
}

const ID = /^[\w-]+$/;
const idOf = (v: unknown) => (isRecord(v) && typeof v.id === 'string' && ID.test(v.id) ? v.id : undefined);

/** `pad "lights"` / `button "key"` when the id names it unambiguously, else `pad #2` (1-based). */
function nameIn(list: unknown[], i: number, what: string): string {
  const id = idOf(list[i]);
  return id !== undefined && list.filter((x) => idOf(x) === id).length === 1 ? `${what} "${id}"` : `${what} #${i + 1}`;
}

/** Machine path ("pads.0.buttons.5.action.env.A.B") → path into `raw`, numbers for array indices. */
function toPath(raw: unknown, s: string): Seg[] {
  if (s === '(root)' || s === '') return [];
  const parts = s.split('.');
  const out: Seg[] = [];
  let cur: unknown = raw;
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i]!;
    if (Array.isArray(cur) && /^\d+$/.test(p)) {
      out.push(Number(p));
      cur = cur[Number(p)];
      continue;
    }
    // A key may contain dots itself (an env variable name, say): take the longest that exists.
    if (isRecord(cur) && !(p in cur))
      for (let j = parts.length - 1; j > i; j--) {
        const joined = parts.slice(i, j + 1).join('.');
        if (joined in cur) {
          p = joined;
          i = j;
          break;
        }
      }
    out.push(p);
    cur = isRecord(cur) ? cur[p] : undefined;
  }
  return out;
}

function valueAt(raw: unknown, path: Seg[]): unknown {
  let cur = raw;
  for (const p of path) cur = Array.isArray(cur) || isRecord(cur) ? (cur as Record<string | number, unknown>)[p] : undefined;
  return cur;
}

/** `holdMs`, `action.args[2]`, `action.env["A B"]`. */
function fieldName(path: Seg[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? `${i ? '.' : ''}${p}` : `[${JSON.stringify(p)}]`)).join('');
}

const quoteList = (items: string[]) => {
  const q = items.map((x) => `"${x}"`);
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} or ${q.at(-1)}`;
};

const KIND: Record<string, string> = {
  number: 'a number',
  int: 'a whole number',
  string: 'text in double quotes',
  boolean: 'true or false',
  object: 'an object ({…})',
  record: 'an object of names and values ({"NAME": "value"})',
  array: 'a list ([…])',
};

function described(got: string, value: unknown): string {
  if (got === 'string') return `the text ${JSON.stringify(value)}`;
  if (got === 'array') return 'a list';
  if (got === 'object') return 'an object';
  if (got === 'number' || got === 'boolean' || got === 'null') return String(value);
  return got;
}

/** One error, worded. `where`: `pad "x" › button "y"` (empty at the top level); `field`: the path below it. */
function phrase(msg: string, field: string, subject: string, value: unknown, raw: unknown, path: Seg[]): string {
  const S = field || subject;
  let m: RegExpExecArray | null;
  if ((m = /^Too big: expected number to be <(=?)(.+)$/.exec(msg))) return `${S} must be ${m[1] ? '≤' : '<'} ${m[2]}`;
  if ((m = /^Too small: expected number to be >(=?)(.+)$/.exec(msg))) return `${S} must be ${m[1] ? '≥' : '>'} ${m[2]}`;
  if (/^Too small: expected string to have >=1 characters?$/.test(msg)) return `${S} can't be empty`;
  if ((m = /^Too big: expected string to have <=(\d+) characters?$/.exec(msg))) return `${S} is too long (at most ${m[1]} characters)`;
  if ((m = /^Too small: expected array to have >=(\d+) items?$/.exec(msg))) return field === 'pads' ? 'pads needs at least one pad' : `${S} needs at least ${m[1]} item${m[1] === '1' ? '' : 's'}`;
  if ((m = /^Invalid input: expected (\w+), received (\w+)$/.exec(msg))) {
    const [, want, got] = m as unknown as [string, string, string];
    if (got === 'undefined') return `${S} is missing`;
    if (want === 'int' && got === 'number') return `${S} must be a whole number, not ${String(value)}`;
    if (!field && path.length === 0) return `the config must be ${KIND[want] ?? want}, not ${described(got, value)}`;
    const quoted = got === 'string' && (want === 'number' || want === 'int' || want === 'boolean') && /^\s*(-?\d+(\.\d+)?|true|false)\s*$/.test(String(value));
    return `${S} must be ${KIND[want] ?? want}, not ${described(got, value)}${quoted ? ' (remove the quotes)' : ''}`;
  }
  if ((m = /^Invalid option: expected one of (.+)$/.exec(msg))) {
    const options = m[1]!.split('|').map((o) => o.replace(/^"|"$/g, ''));
    return `${S} must be ${quoteList(options)}${value !== undefined ? `, not ${JSON.stringify(value)}` : ''}`;
  }
  if ((m = /^Invalid discriminator value\. Expected (.+)$/.exec(msg))) {
    const options = m[1]!.split('|').map((o) => o.trim().replace(/^'|'$/g, ''));
    return value === undefined ? `${S} is missing: it must be ${quoteList(options)}` : `${S} must be ${quoteList(options)}, not ${JSON.stringify(value)}`;
  }
  if ((m = /^Invalid input: expected (.+)$/.exec(msg))) return `${S} must be ${m[1]}${value !== undefined ? `, not ${JSON.stringify(value)}` : ''}`;
  if ((m = /^Unrecognized keys?: (.+)$/.exec(msg))) {
    const keys = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((k) => JSON.parse(`"${k[1]}"`) as string);
    const known = knownKeys(path, raw);
    const list = keys.map((k) => `"${k}"${otherType(k, path) || suggest(k, known)}`);
    return `${field ? `${field}: ` : ''}unknown field${keys.length === 1 ? '' : 's'} ${list.join(', ')}`;
  }
  if (msg === 'letters, digits, _ and - only') return `${S} ${JSON.stringify(value)} may only use letters, digits, _ and -`;
  if (msg === ENV_NAME_MESSAGE) {
    const name = path.at(-1);
    return `${fieldName(path.slice(0, -1).slice(-2))}: ${JSON.stringify(name)} isn't a valid variable name (${msg})`.replace(/^: /, '');
  }
  if (msg === 'use pad/button, pad/* or *') return `${S} must look like pad/button, pad/* or *, not ${JSON.stringify(value)}`;
  if ((m = /^button (?:"(?:[^"\\]|\\.)*"|#\d+) ((?:overlaps|extends outside) .*)$/.exec(msg))) return m[1]!;
  if ((m = /^duplicate (pad|button) id "(.*)"$/.exec(msg))) {
    const list = m[1] === 'pad' ? valueAt(raw, ['pads']) : valueAt(raw, path.slice(0, -2));
    const at = path.at(-2);
    const first = Array.isArray(list) && typeof at === 'number' ? list.findIndex((x, i) => i < at && isRecord(x) && x.id === m![2]) : -1;
    return `id "${m[2]}" is already used by ${m[1]} #${first + 1}`;
  }
  return field ? `${field}: ${msg}` : msg;
}

/** More than this many errors: the rest are counted, not worded (a file can be big and very broken). */
export const MAX_EXPLAINED = 100;

/**
 * parseConfig's errors for `raw` (parsed from `text`), worded for people: pads and buttons named by
 * id, plain-words messages, and the line in the file, sorted by line. Never throws: an error it can't
 * word stays as it was.
 */
export function explainConfigErrors(raw: unknown, errors: string[], text?: string): string[] {
  let positions: Map<string, number> | undefined | null = null;
  let starts: number[] | undefined;
  const lineOf = (path: Seg[]): number | undefined => {
    if (text === undefined) return undefined;
    positions ??= valuePositions(text);
    if (!positions) return undefined;
    for (let n = path.length; n >= 0; n--) {
      const at = positions.get(JSON.stringify(path.slice(0, n)));
      if (at !== undefined) return lineCol(text, at, (starts ??= lineStarts(text))).line;
    }
    return undefined;
  };
  const out = errors.slice(0, MAX_EXPLAINED).map((err, order) => {
    try {
      return { text: explainOne(raw, err, lineOf), order };
    } catch {
      return { text: { text: err, line: Infinity }, order };
    }
  });
  out.sort((a, b) => a.text.line - b.text.line || a.order - b.order);
  const worded = [...new Set(out.map((o) => o.text.text))];
  if (errors.length > MAX_EXPLAINED) worded.push(`…and ${errors.length - MAX_EXPLAINED} more`);
  return worded;
}

function explainOne(raw: unknown, err: string, lineOf: (path: Seg[]) => number | undefined): { text: string; line: number } {
  const sep = err.indexOf(': ');
  const pathStr = sep >= 0 ? err.slice(0, sep) : '(root)';
  const msg = sep >= 0 ? err.slice(sep + 2) : err;
  const path = toPath(raw, pathStr);
  const where: string[] = [];
  let rest = path;
  let subject = 'the config';
  if (path[0] === 'pads' && typeof path[1] === 'number') {
    const pads = valueAt(raw, ['pads']) as unknown[];
    where.push(nameIn(pads, path[1], 'pad'));
    subject = 'the pad';
    rest = path.slice(2);
    if (path[2] === 'buttons' && typeof path[3] === 'number') {
      where.push(nameIn(valueAt(raw, path.slice(0, 3)) as unknown[], path[3], 'button'));
      subject = 'the button';
      rest = path.slice(4);
    }
  }
  // Unknown fields: point at the first of them.
  const unknownKey = /^Unrecognized keys?: "((?:[^"\\]|\\.)*)"/.exec(msg)?.[1];
  const line = lineOf(unknownKey !== undefined ? [...path, JSON.parse(`"${unknownKey}"`) as string] : path);
  const worded = phrase(msg, fieldName(rest), subject, valueAt(raw, path), raw, path);
  return { text: `${where.length ? `${where.join(' › ')}: ` : ''}${worded}${line !== undefined ? ` (line ${line})` : ''}`, line: line ?? Infinity };
}
