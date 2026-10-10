/** Edit-mode icons, drawn like ui/icons.tsx: stroke = currentColor, 24-unit grid, sized by CSS. */
import type { JSX } from 'preact';

type P = { class?: string };
const svg = (p: P, children: JSX.Element | JSX.Element[]) => (
  <svg class={p.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Undo = (p: P) => svg(p, <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke-width="2.4" />);
export const Redo = (p: P) => svg(p, <path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" stroke-width="2.4" />);
export const Plus = (p: P) => svg(p, <path d="M12 5v14M5 12h14" stroke-width="2.6" />);
export const Trash = (p: P) =>
  svg(p, [<path key="l" d="M4 7h16M10 3.5h4M6.5 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" stroke-width="2.2" />, <path key="s" d="M10 11v6M14 11v6" stroke-width="2.2" />]);
export const Copy = (p: P) =>
  svg(p, [<rect key="f" x="8.5" y="8.5" width="12" height="12" rx="2.4" stroke-width="2.2" />, <path key="b" d="M15.5 5.2V5a1.8 1.8 0 0 0-1.8-1.8H5A1.8 1.8 0 0 0 3.2 5v8.7A1.8 1.8 0 0 0 5 15.5h.2" stroke-width="2.2" />]);
export const Sliders = (p: P) =>
  svg(p, [
    <path key="l" d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke-width="2.2" />,
    <circle key="a" cx="15" cy="7" r="2.3" stroke-width="2.2" />,
    <circle key="b" cx="9" cy="17" r="2.3" stroke-width="2.2" />,
  ]);
export const Resize = (p: P) => svg(p, <path d="M9 20h11V9M20 20L9.5 9.5M4 15V4h11" stroke-width="2.4" />);
export const Play = (p: P) => svg(p, <path d="M7 4.8v14.4a.6.6 0 0 0 .9.5l11.4-7.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z" fill="currentColor" stroke-width="1.6" />);
export const Refresh = (p: P) => svg(p, <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4.5V11h-6.5" stroke-width="2.3" />);
export const ChevronLeft = (p: P) => svg(p, <path d="M14.5 5.5L8 12l6.5 6.5" stroke-width="2.6" />);
export const ChevronRight = (p: P) => svg(p, <path d="M9.5 5.5L16 12l-6.5 6.5" stroke-width="2.6" />);
export const ChevronUp = (p: P) => svg(p, <path d="M5.5 14.5L12 8l6.5 6.5" stroke-width="2.6" />);
export const ChevronDown = (p: P) => svg(p, <path d="M5.5 9.5L12 16l6.5-6.5" stroke-width="2.6" />);
export const Info = (p: P) =>
  svg(p, [<circle key="c" cx="12" cy="12" r="9" stroke-width="2.2" />, <path key="i" d="M12 11v5.5M12 7.6v.1" stroke-width="2.6" />]);
export const Dot = (p: P) => svg(p, <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />);
