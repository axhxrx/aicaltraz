/**
 * Durations in the editor: stored in ms (the config's unit), shown and typed in seconds. "10" in
 * "Show result for" means 10 s, not 10 ms; a unit may be typed too ("500 ms", "2 min", "1 h"), and a
 * comma keyboard's "2,5" is 2.5.
 */

/** "400 ms", "2.5 s", "1.5 min", "2 h". */
export const secs = (ms: number) =>
  ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : ms >= 1000 || ms === 0 ? `${+(ms / 1000).toFixed(1)} s` : `${ms} ms`;

/** The field's text for a value: seconds, as short as exact ("2.5", "0.05", "120"). */
export const fmtSeconds = (ms: number) => String(+(ms / 1000).toFixed(3));

const UNIT: Record<string, number> = { ms: 1, s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000 };

/** What was typed, in ms (whole), or null when it isn't a duration (yet): "2.5", "2,5", "90", "500ms", "2 min". */
export function parseDuration(t: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*([a-z]*)\.?\s*$/i.exec(t);
  if (!m) return null;
  const k = m[2] ? UNIT[m[2].toLowerCase()] : 1000;
  if (k === undefined) return null;
  const n = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * k) : null;
}

/** A bound in words for a time field's range error: "60 s (1 min)", "0.1 s". */
export const bound = (ms: number) => `${fmtSeconds(ms)} s${ms >= 60_000 ? ` (${secs(ms)})` : ''}`;

/** Button fields that are durations in ms. */
export const TIME_FIELDS = new Set(['holdMs', 'confirmWindowMs', 'cooldownMs', 'timeoutMs', 'resultHoldMs', 'maxLatenessMs']);
