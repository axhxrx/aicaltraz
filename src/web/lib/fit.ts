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
  // Break opportunities: spaces, and after a hyphen inside a word ("Double-|tap").
  const chunks = norm
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => word.split(/(?<=\p{L}-)(?=\p{L})/u).map((part, i) => ({ part, spaced: i === 0 })));
  if (!chunks.length) return [];
  const w = chunks.map((c) => measureEm(c.part, weight));
  const space = measureEm(' ', weight);
  const n = chunks.length;
  // span(i, j) = width of chunks i..j-1 on one line
  const span = (i: number, j: number) => {
    let sum = 0;
    for (let k = i; k < j; k++) sum += w[k]! + (k > i && chunks[k]!.spaced ? space : 0);
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
