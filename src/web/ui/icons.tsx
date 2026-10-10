/** Inline SVG icons; they inherit `color` and scale with font-size (1em) unless sized by CSS. */
import type { JSX } from 'preact';

type P = { class?: string };
const svg = (p: P, children: JSX.Element | JSX.Element[], vb = '0 0 24 24') => (
  <svg class={p.class} viewBox={vb} fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Check = (p: P) => svg(p, <path d="M2.6 12.8l6 6L21.4 5.8" stroke-width="3.6" />);
export const Cross = (p: P) => svg(p, <path d="M4.6 4.6l14.8 14.8M19.4 4.6L4.6 19.4" stroke-width="3.6" />);
export const Warn = (p: P) =>
  svg(p, [
    <path key="t" d="M12 3.2L22.4 20.8H1.6z" stroke-width="2.4" />,
    <path key="l" d="M12 9.5v5" stroke-width="2.8" />,
    <circle key="d" cx="12" cy="17.9" r="0.4" stroke-width="2.6" />,
  ]);
export const Hold = (p: P) =>
  svg(p, [<circle key="a" cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />, <circle key="b" cx="12" cy="12" r="8.6" stroke-width="2.4" stroke-dasharray="3.2 2.6" />]);
export const Tap = (p: P) => svg(p, <circle cx="12" cy="12" r="5.2" fill="currentColor" stroke="none" />);
export const DoubleTap = (p: P) =>
  svg(p, [<circle key="a" cx="7" cy="12" r="4.4" fill="currentColor" stroke="none" />, <circle key="b" cx="17" cy="12" r="4.4" fill="currentColor" stroke="none" />]);
export const Lock = (p: P) =>
  svg(p, [<rect key="b" x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor" stroke="none" />, <path key="s" d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" stroke-width="2.6" />]);
export const Keyboard = (p: P) =>
  svg(p, [
    <rect key="r" x="2.5" y="6" width="19" height="12" rx="2.2" stroke-width="2" />,
    <path key="k" d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" stroke-width="2.2" />,
  ]);
export const Menu = (p: P) => svg(p, <path d="M4 7h16M4 12h16M4 17h16" stroke-width="2.6" />);
export const Close = (p: P) => svg(p, <path d="M6 6l12 12M18 6L6 18" stroke-width="2.6" />);
export const Expand = (p: P) => svg(p, <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke-width="2.4" />);
export const Sun = (p: P) =>
  svg(p, [<circle key="c" cx="12" cy="12" r="4" stroke-width="2.4" />, <path key="r" d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" stroke-width="2.2" />]);
export const Speaker = (p: P) =>
  svg(p, [<path key="b" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-width="1.6" />, <path key="w" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke-width="2.2" />]);
export const Vibrate = (p: P) =>
  svg(p, [<rect key="p" x="7.5" y="3.5" width="9" height="17" rx="2" stroke-width="2.2" />, <path key="w" d="M3.5 8.5v7M20.5 8.5v7" stroke-width="2.2" />]);
export const Pencil = (p: P) => svg(p, <path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19zM13.5 7l3.5 3.5" stroke-width="2.2" />);
export const Link = (p: P) =>
  svg(p, <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" stroke-width="2.2" />);
export const Bolt = (p: P) => svg(p, <path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z" fill="currentColor" stroke-width="1.4" />);
/** STOPPED: a plain square. */
export const Stop = (p: P) => svg(p, <rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" stroke="none" />);
/** Outcome unknown (NO RESPONSE, IT RAN). */
export const Question = (p: P) =>
  svg(p, [<path key="q" d="M8.4 8.6a3.7 3.7 0 1 1 5.3 3.4c-1.1.6-1.7 1.4-1.7 2.6v.6" stroke-width="3" />, <circle key="d" cx="12" cy="19.6" r="0.5" stroke-width="3.2" />]);
/** The host stopped mid-run. */
export const Interrupted = (p: P) => svg(p, [<path key="z" d="M13.5 2.8L6 13.2h5.6L10 21.2l8-11.2h-5.7z" stroke-width="2.4" />]);
/** A run started on another device. */
export const Devices = (p: P) =>
  svg(p, [<rect key="a" x="2.8" y="5" width="9.5" height="14.5" rx="1.8" stroke-width="2.2" />, <rect key="b" x="14.6" y="8.4" width="6.6" height="11.1" rx="1.5" stroke-width="2.2" />]);
/** The screen may sleep. */
export const Moon = (p: P) => svg(p, <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" fill="currentColor" stroke-width="1.6" />);
