/**
 * The clock the client times things with on its own: elapsed counters, confirm windows, result
 * countdowns, cooldowns, and the host-clock estimate behind each press's `at`.
 *
 * `wall()` is epoch ms that moves with performance.now(), so setting the device's clock (or an NTP
 * step, or a phone picking up network time) doesn't make a counter jump by hours or a confirm
 * window last an hour. Across a stretch in the background it catches up with Date.now() instead:
 * a device that slept meanwhile may have paused performance.now() (the OS clock it reads stops in
 * suspend), and real time did pass. A visible page with keep-awake doesn't sleep.
 */
import { mono } from './env.ts';

/** Date.now() and mono() disagreeing by more than this across a hidden stretch: the device slept. */
const SLEPT_MS = 1000;

let base = Date.now() - mono();
let hidden: { date: number; mono: number } | null = null;

if (typeof document !== 'undefined') {
  const onVis = () => {
    if (document.visibilityState === 'hidden') {
      hidden ??= { date: Date.now(), mono: mono() };
      return;
    }
    if (!hidden) return;
    const slept = Date.now() - hidden.date - (mono() - hidden.mono);
    hidden = null;
    if (slept > SLEPT_MS) base += slept;
  };
  document.addEventListener('visibilitychange', onVis);
  // Some browsers freeze a page instead of hiding it first (bfcache, tab discarding).
  addEventListener('pageshow', onVis);
  if (document.visibilityState === 'hidden') onVis();
}

/** Epoch ms, immune to the device's clock being set (see above). */
export const wall = (): number => mono() + base;
