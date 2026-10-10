/** Color helpers: resolve any CSS color to sRGB and pick black/white ink for it. */

export type RGB = [number, number, number];

export const DEFAULT_COLOR = '#2f6fde';
export const INK_DARK = '#0b0c0e';
export const INK_LIGHT = '#ffffff';

/** sRGB bytes + alpha (0..1), or null: not a color a button can be painted with on its own. */
type Resolved = { rgb: RGB; alpha: number } | null;

const cache = new Map<string, Resolved>();
let ctx: CanvasRenderingContext2D | null | undefined;

/**
 * Colors that only mean something in context: `currentColor`, custom properties, `env()`… The
 * canvas would resolve them against itself (or not at all), never against the button.
 */
const CONTEXTUAL = /currentcolor|var\(|env\(|attr\(|inherit|initial|unset|revert|light-dark\(/i;

function resolve(color: string): Resolved {
  if (cache.has(color)) return cache.get(color)!;
  let out: Resolved = null;
  const hex = parseHex(color);
  if (hex) out = { rgb: hex, alpha: 1 };
  else if (typeof document !== 'undefined' && !CONTEXTUAL.test(color) && CSS.supports('color', color)) {
    ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (ctx) {
      // An assignment the canvas doesn't understand leaves the old value: two sentinels catch it.
      const takes = (sentinel: string) => {
        ctx!.fillStyle = sentinel;
        ctx!.fillStyle = color;
        return ctx!.fillStyle !== sentinel;
      };
      if (takes('#010203') || takes('#040506')) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        out = { rgb: [d[0]!, d[1]!, d[2]!], alpha: d[3]! / 255 };
      }
    }
  }
  if (cache.size > 200) cache.clear();
  cache.set(color, out);
  return out;
}

/** Any CSS color (named, hex, rgb(), hsl(), oklch()...) → sRGB bytes. Invalid → the default color. */
export function toRGB(color: string): RGB {
  return resolve(color)?.rgb ?? parseHex(DEFAULT_COLOR)!;
}

function parseHex(c: string): RGB | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export function isValidColor(c: string): boolean {
  return !!parseHex(c) || (typeof CSS !== 'undefined' && CSS.supports('color', c));
}

/**
 * The color a button is painted with: `color` if it resolves to an opaque color on its own, else
 * the default (`transparent`, `currentColor`, `var(--x)`, half-transparent or invalid colors would
 * leave the button see-through, or its ink unreadable).
 */
export function paintColor(color: string): string {
  const r = resolve(color);
  return r && r.alpha >= 0.999 ? color : DEFAULT_COLOR;
}

/** WCAG 2 relative luminance. */
function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio (1..21) of two luminances. */
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Black or white, whichever has the higher WCAG contrast on `color` (white on orange is 2.9:1, black 7.2:1). */
export function inkFor(color: string): string {
  const y = luminance(toRGB(paintColor(color)));
  return ratio(y, 1) >= ratio(y, luminance(toRGB(INK_DARK))) ? INK_LIGHT : INK_DARK;
}

export const isLightInk = (ink: string) => ink === INK_LIGHT;
