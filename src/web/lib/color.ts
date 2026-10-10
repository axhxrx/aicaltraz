/** Color helpers: resolve any CSS color to sRGB and pick black/white ink for it. */

export type RGB = [number, number, number];

export const DEFAULT_COLOR = '#2f6fde';
export const INK_DARK = '#0b0c0e';
export const INK_LIGHT = '#ffffff';

const cache = new Map<string, RGB>();
let ctx: CanvasRenderingContext2D | null | undefined;

/** Any CSS color (named, hex, rgb(), hsl(), oklch()...) → sRGB bytes. Invalid → the default color. */
export function toRGB(color: string): RGB {
  const hit = cache.get(color);
  if (hit) return hit;
  let rgb = parseHex(color);
  if (!rgb && typeof document !== 'undefined') {
    ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (ctx && CSS.supports('color', color)) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      rgb = [d[0]!, d[1]!, d[2]!];
    }
  }
  rgb ??= parseHex(DEFAULT_COLOR)!;
  cache.set(color, rgb);
  return rgb;
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

/** APCA-W3 screen luminance. */
const apcaY = ([r, g, b]: RGB) => 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;

/** APCA lightness contrast (Lc, roughly -108..106) of text on background. */
function apca(textY: number, bgY: number): number {
  const clamp = (y: number) => (y > 0.022 ? y : y + (0.022 - y) ** 1.414);
  const t = clamp(textY);
  const bg = clamp(bgY);
  if (Math.abs(bg - t) < 0.0005) return 0;
  if (bg > t) {
    const s = (bg ** 0.56 - t ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (bg ** 0.65 - t ** 0.62) * 1.14;
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

/** Black or white, whichever reads better on `color` (APCA, slight bias to white for saturated mids). */
export function inkFor(color: string): string {
  const y = apcaY(toRGB(color));
  const onWhite = Math.abs(apca(1, y));
  const onBlack = Math.abs(apca(0, y));
  return onWhite * 1.08 >= onBlack ? INK_LIGHT : INK_DARK;
}

export const isLightInk = (ink: string) => ink === INK_LIGHT;
