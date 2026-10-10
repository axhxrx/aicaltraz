/**
 * Fit-to-box text sizing with container query units.
 *
 * JS measures the text once (per string): for each line count k it finds the narrowest balanced
 * k-line layout, in em. CSS then picks the font size live, so resizes cost no JS:
 *   font-size = max over k of min(fitW / width_k, fitH / (k * lineHeight))
 * where --fit-w / --fit-h are cq-based lengths set by the stylesheet for each state.
 */
import { useEffect, useState } from 'preact/hooks';

export const FONT_FAMILY = "'BP Display', 'Inter Display', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const LINE_HEIGHT = 1.08;
const MAX_LINES = 4;

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number[]>();
let epoch = 0;
const listeners = new Set<() => void>();

function measureEm(text: string, weight: number): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 0.62;
  ctx.font = `${weight} 100px ${FONT_FAMILY}`;
  return ctx.measureText(text).width / 100;
}

// ---- break opportunities ------------------------------------------------------------------------
//
// The measurement below and the browser's layout must agree on where a line may break, or a size
// computed for two lines gets laid out on one (and overflows) or on three. So the labels are
// rendered from the same chunks: between two chunks there is a space or a <wbr>, and the CSS
// (`word-break: keep-all`) allows no other breaks inside CJK text. Scripts written without spaces
// get their chunks from Intl.Segmenter (words), merged into phrases: 照明を | すべて | 消す.

/** A run of text that stays on one line. A line may break before it: at a space if `spaced`. */
export interface Chunk {
  text: string;
  spaced: boolean;
}

/** Scripts written without spaces between words. */
const NO_SPACES = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
/** Japanese particles that belong with the word before them. */
const PARTICLES = new Set(['を', 'は', 'が', 'に', 'で', 'と', 'の', 'へ', 'も', 'や', 'か', 'ね', 'よ', 'から', 'まで', 'より', 'だけ', 'など']);
/** May not start a line (kinsoku): closing punctuation, small kana, ー, iteration marks. */
const NO_START = /^[\p{Pe}\p{Pf}、。，．・：；？！ーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ々ゝゞヽヾ]/u;
/** May not end a line: opening punctuation. */
const NO_END = /[\p{Ps}\p{Pi}]$/u;
/** Without Intl.Segmenter: one CJK character (plus its marks) per part; anything else in runs. */
const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}][\p{M}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]*|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[^])+/gu;

type Seg = { segment: string; isWordLike?: boolean };
interface SegmenterLike {
  segment(s: string): Iterable<Seg>;
}
const segmenters = new Map<string, SegmenterLike | null>();

function segmenter(locale: string): SegmenterLike | null {
  if (!segmenters.has(locale)) {
    const S = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => SegmenterLike }).Segmenter;
    let s: SegmenterLike | null = null;
    try {
      s = S ? new S(locale, { granularity: 'word' }) : null;
    } catch {
      s = null;
    }
    segmenters.set(locale, s);
  }
  return segmenters.get(locale)!;
}

const navLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en';

/**
 * The language to tag a label with, so the browser picks the right glyphs and (Chromium, `ja`)
 * phrase-based line breaking. Kana means Japanese; Han alone is Japanese or Chinese, whichever
 * this device uses (or left alone).
 */
export function langOf(text: string): string | undefined {
  if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text)) return 'ja';
  if (/\p{sc=Han}/u.test(text)) return /^(ja|zh)\b/i.test(navLang()) ? navLang() : undefined;
  if (/\p{sc=Thai}/u.test(text)) return 'th';
  return undefined;
}

/** Splits one space-free token of a no-spaces script into phrases. */
function phrases(token: string, locale: string): string[] {
  const seg = segmenter(locale);
  const parts: Seg[] = seg
    ? [...seg.segment(token)]
    : // Thai & co. without a segmenter: leave it whole (the browser still breaks it, only better).
      /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(token)
      ? (token.match(CJK_CHAR) ?? [token]).map((segment) => ({ segment, isWordLike: /[\p{L}\p{N}]/u.test(segment) }))
      : [{ segment: token, isWordLike: true }];
  const out: string[] = [];
  const push = (segment: string, isWordLike?: boolean) => {
    const prev = out.at(-1);
    const glue =
      prev !== undefined && (NO_END.test(prev) || NO_START.test(segment) || PARTICLES.has(segment) || (isWordLike === false && !NO_END.test(segment)));
    if (glue) out[out.length - 1] = prev + segment;
    else out.push(segment);
  };
  for (const { segment, isWordLike } of parts) {
    // A long katakana compound (スモークマシン) is one dictionary word: let it break like the
    // browser's default would, between any two characters (ー and small kana stay attached).
    if (/^[\p{sc=Katakana}ー]{6,}$/u.test(segment)) for (const ch of segment) push(ch, true);
    else push(segment, isWordLike);
  }
  return out;
}

/**
 * Where `text` may break: at spaces, after a hyphen inside a word ("Double-|tap"), and between
 * the phrases of CJK/Thai text.
 */
export function chunks(text: string): Chunk[] {
  const locale = langOf(text) ?? navLang();
  const out: Chunk[] = [];
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const parts = NO_SPACES.test(word) ? phrases(word, locale) : word.split(/(?<=\p{L}-)(?=\p{L})/u);
    parts.forEach((p, i) => out.push({ text: p, spaced: i === 0 }));
  }
  return out;
}

/**
 * widths[k-1] = width (em) of the best k-line layout. Digits are measured as 0 (about the widest)
 * so ticking numbers neither grow the cache nor make the size jitter.
 */
export function lineWidths(text: string, weight = 900): number[] {
  const norm = text.replace(/\d/g, '0');
  const id = `${weight}|${norm}`;
  const hit = cache.get(id);
  if (hit) return hit;
  if (cache.size > 500) cache.clear();
  const parts = chunks(norm);
  if (!parts.length) return [];
  const w = parts.map((c) => measureEm(c.text, weight));
  const space = measureEm(' ', weight);
  const n = parts.length;
  // span(i, j) = width of chunks i..j-1 on one line
  const span = (i: number, j: number) => {
    let sum = 0;
    for (let k = i; k < j; k++) sum += w[k]! + (k > i && parts[k]!.spaced ? space : 0);
    return sum;
  };
  const out: number[] = [];
  // best[k][j] = min possible max-line width putting the first j words on k lines
  let prev = Array.from({ length: n + 1 }, (_, j) => (j === 0 ? 0 : span(0, j)));
  out.push(prev[n]!);
  for (let k = 2; k <= Math.min(n, MAX_LINES); k++) {
    const cur = Array<number>(n + 1).fill(Infinity);
    for (let j = k; j <= n; j++)
      for (let i = k - 1; i < j; i++) cur[j] = Math.min(cur[j]!, Math.max(prev[i]!, span(i, j)));
    out.push(cur[n]!);
    prev = cur;
  }
  cache.set(id, out);
  return out;
}

/**
 * CSS font-size expression for `text` in at most `maxLines` lines; relies on --fit-w, --fit-h,
 * --fit-max (and optional --fit-min) from the stylesheet.
 */
export function fitFontSize(text: string, weight = 900, maxLines = MAX_LINES): string {
  const widths = lineWidths(text, weight).slice(0, maxLines);
  if (!widths.length) return 'var(--fit-max)';
  const terms = widths.map((wk, i) => `min(calc(var(--fit-w) / ${(wk * 1.04).toFixed(3)}), calc(var(--fit-h) / ${((i + 1) * LINE_HEIGHT).toFixed(3)}))`);
  return `max(var(--fit-min, 0px), min(var(--fit-max), ${terms.length === 1 ? terms[0] : `max(${terms.join(', ')})`}))`;
}

/**
 * Font size that keeps `text` on one line within --iw, capped by --line-max. `extraEm` covers
 * padding, `trackEm` letter-spacing per char.
 */
export function lineFontSize(text: string, extraEm = 0, trackEm = 0): string {
  const w = (lineWidths(text)[0] ?? 1) + extraEm + trackEm * text.length;
  return `min(var(--line-max), calc(var(--iw) / ${(w * 1.06).toFixed(3)}))`;
}

/** Re-render when the display font finishes loading (measurements before that used a fallback). */
export function useFontEpoch(): number {
  const [e, setE] = useState(epoch);
  useEffect(() => {
    const fn = () => setE(epoch);
    listeners.add(fn);
    fn();
    return () => void listeners.delete(fn);
  }, []);
  return e;
}

export function loadFonts(): void {
  if (typeof document === 'undefined' || !document.fonts) return;
  Promise.all([document.fonts.load(`900 100px 'BP Display'`), document.fonts.load(`700 16px 'BP Display'`)])
    .catch(() => {})
    .finally(() => {
      cache.clear();
      epoch++;
      for (const fn of listeners) fn();
    });
}
