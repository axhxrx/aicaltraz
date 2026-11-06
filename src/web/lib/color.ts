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
 * canvas would resolve them against itself (or not at all), never against the button. So do the
 * system colors (`Canvas`, `ButtonFace`…, and the engines' own `-webkit-link`…): they follow the
 * page's color scheme and forced colors, which the canvas's answer doesn't, so the ink picked for
 * them can be unreadable.
 */
const CONTEXTUAL =
  /currentcolor|var\(|env\(|attr\(|inherit|initial|unset|revert|light-dark\(|-(webkit|moz|internal)-|\b(accentcolor|accentcolortext|activetext|buttonborder|buttonface|buttontext|canvas|canvastext|field|fieldtext|graytext|highlight|highlighttext|linktext|mark|marktext|selecteditem|selecteditemtext|visitedtext|activeborder|activecaption|appworkspace|background|buttonhighlight|buttonshadow|captiontext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|menu|menutext|scrollbar|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|window|windowframe|windowtext)\b/i;

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

// ---- show mode (dark rooms) ------------------------------------------------------------------

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toByte = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

/** sRGB bytes → OKLCH (L 0..1, C, h in degrees). */
function oklch([r8, g8, b8]: RGB): [number, number, number] {
  const [r, g, b] = [toLinear(r8), toLinear(g8), toLinear(b8)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180) / Math.PI];
}

/** OKLCH → a #rrggbb color (out-of-gamut channels clipped). */
function fromOklch(L: number, C: number, h: number): string {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((x) => toByte(x).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 contrast ratio of two colors. */
export const contrast = (a: string, b: string) => ratio(luminance(toRGB(a)), luminance(toRGB(b)));

export interface ShowPalette {
  /** The face: the button's hue, dark (relative luminance ~0.015, where its own color may be 0.6). */
  bg: string;
  /** Label ink: light, a hint of the hue; ≥ 7:1 on `bg`, but no glaring white. */
  ink: string;
  /** The hue at medium lightness, for the face's edge: which button it is, at a glance. */
  edge: string;
  /**
   * The latched-state chip (`@state`): the face a step lighter, so it still reads as a solid chip,
   * with the ink on it (≥ 4.5:1). A chip in the ink itself was the brightest thing on a dark pad
   * (QA: 0.35 relative luminance on a 0.025 face).
   */
  chip: string;
}

const showCache = new Map<string, ShowPalette>();

/**
 * Show mode (a dark house): the same hue, dimmed. Every color lands at the same lightness, so a
 * yellow button is no brighter than a navy one, and the ink keeps a ≥ 7:1 contrast on it.
 */
export function showPalette(color: string): ShowPalette {
  const hit = showCache.get(color);
  if (hit) return hit;
  const [, C, h] = oklch(toRGB(paintColor(color)));
  const out: ShowPalette = {
    bg: fromOklch(0.25, Math.min(C, 0.07), h),
    ink: fromOklch(0.78, Math.min(C, 0.03), h),
    edge: fromOklch(0.5, Math.min(C, 0.12), h),
    chip: fromOklch(0.36, Math.min(C, 0.06), h),
  };
  if (showCache.size > 200) showCache.clear();
  showCache.set(color, out);
  return out;
}
