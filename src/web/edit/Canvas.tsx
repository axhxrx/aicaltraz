/**
 * The edit canvas: the real pad grid (PadGrid + ButtonFace, static READY look) over visible
 * cells. Tap an empty cell to add a button; drag a button to move it; drag its corner handle to
 * resize. Positions snap to cells; a refused spot (overlap / outside) shows red and snaps back.
 * Pointer events cover touch and mouse alike; one gesture at a time.
 */
import type { JSX, TargetedPointerEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Pad } from '../../core/config.ts';
import { vmFor } from '../dev/Gallery.tsx';
import { ButtonFace } from '../run/ButtonFace.tsx';
import { cellStyle, PadGrid } from '../run/RunPad.tsx';
import type { Editor } from './editor.ts';
import { Plus, Resize } from './icons.tsx';
import { fits, occupant, rectOf, refusal, sameRect, type Fit, type Rect } from './ops.ts';

/** Grid geometry in client px, measured when a gesture starts. */
interface Geo {
  left: number;
  top: number;
  /** Cell pitch (cell + gap). */
  px: number;
  py: number;
  gx: number;
  gy: number;
  padL: number;
  padT: number;
}

function measure(grid: HTMLElement, cols: number, rows: number): Geo {
  const r = grid.getBoundingClientRect();
  const cs = getComputedStyle(grid);
  const n = (v: string) => parseFloat(v) || 0;
  const [pl, pr, pt, pb, gx, gy] = [cs.paddingLeft, cs.paddingRight, cs.paddingTop, cs.paddingBottom, cs.columnGap, cs.rowGap].map(n) as [number, number, number, number, number, number];
  const cw = (r.width - pl - pr - gx * (cols - 1)) / cols;
  const ch = (r.height - pt - pb - gy * (rows - 1)) / rows;
  return { left: r.left + pl, top: r.top + pt, px: cw + gx, py: ch + gy, gx, gy, padL: pl, padT: pt };
}

const cellAt = (g: Geo, cx: number, cy: number) => ({ x: Math.floor((cx - g.left + g.gx / 2) / g.px), y: Math.floor((cy - g.top + g.gy / 2) / g.py) });

/** Absolute box for a rect, relative to the grid's padding box (may hang outside the grid). */
const boxStyle = (g: Geo, r: Rect): Record<string, string> => ({
  position: 'absolute',
  left: `${g.padL + r.x * g.px}px`,
  top: `${g.padT + r.y * g.py}px`,
  width: `${Math.max(0, r.w * g.px - g.gx)}px`,
  height: `${Math.max(0, r.h * g.py - g.gy)}px`,
});

interface Gesture {
  id: number;
  kind: 'move' | 'resize' | 'cell';
  ix: number;
  x0: number;
  y0: number;
  geo: Geo;
  orig: Rect;
  cand: Rect;
  live: boolean;
  slop: number;
}

interface Drag {
  ix: number;
  kind: 'move' | 'resize';
  geo: Geo;
  orig: Rect;
  cand: Rect;
  fit: Fit;
  /** Released on a refused spot: animating back to `orig`. */
  settling?: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface CanvasProps {
  ed: Editor;
  pad: Pad;
  sel: number | null;
  /** Indices of buttons with validation problems. */
  bad: ReadonlySet<number>;
  /** Indices of buttons running on the host right now (a save may stop them). */
  running: ReadonlySet<number>;
  /** Refused keyboard move/resize, blocked pad shrink: flash these buttons. */
  flash: { ixs: number[]; at: number } | null;
  /** A tap (no drag) on a button, or a button was just added (`added`). */
  onOpen(ix: number, added?: boolean): void;
  onDeselect(): void;
  onRefuse(message: string): void;
  /** Shown over a pad with no buttons yet. */
  emptyHint: string;
}

export function Canvas({ ed, pad, sel, bad, running, flash, onOpen, onDeselect, onRefuse, emptyHint }: CanvasProps) {
  const root = useRef<HTMLDivElement>(null);
  const g = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  // A pad switch or an undo mid-gesture: drop the gesture.
  useEffect(() => {
    g.current = null;
    setDrag(null);
  }, [pad]);

  const down = (e: TargetedPointerEvent<HTMLDivElement>) => {
    if (g.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const grid = root.current?.querySelector<HTMLElement>('.bp-grid');
    if (!grid) return;
    const t = e.target as Element;
    const geo = measure(grid, pad.cols, pad.rows);
    let kind: Gesture['kind'];
    let ix = -1;
    let orig: Rect;
    const item = t.closest<HTMLElement>('[data-ix]');
    if (t.closest('[data-handle]') && sel !== null && pad.buttons[sel]) {
      kind = 'resize';
      ix = sel;
      orig = rectOf(pad.buttons[sel]);
    } else if (item) {
      kind = 'move';
      ix = Number(item.dataset.ix);
      const b = pad.buttons[ix];
      if (!b) return;
      orig = rectOf(b);
      if (sel !== ix) ed.select(ix);
      item.focus({ preventScroll: true });
    } else {
      const c = cellAt(geo, e.clientX, e.clientY);
      if (c.x < 0 || c.y < 0 || c.x >= pad.cols || c.y >= pad.rows) return onDeselect();
      kind = 'cell';
      orig = { ...c, w: 1, h: 1 };
    }
    e.preventDefault();
    clearTimeout(settle.current);
    if (drag?.settling) setDrag(null);
    root.current!.setPointerCapture(e.pointerId);
    g.current = { id: e.pointerId, kind, ix, x0: e.clientX, y0: e.clientY, geo, orig, cand: orig, live: false, slop: e.pointerType === 'mouse' ? 4 : 9 };
  };

  const move = (e: TargetedPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (!s.live) {
      if (Math.hypot(dx, dy) < s.slop) return;
      // A slide that started on an empty cell is not a tap.
      if (s.kind === 'cell') return void (g.current = null);
      s.live = true;
    }
    if (s.kind === 'cell') return;
    const o = s.orig;
    const cand =
      s.kind === 'move'
        ? { ...o, x: o.x + Math.round(dx / s.geo.px), y: o.y + Math.round(dy / s.geo.py) }
        : { ...o, w: Math.max(1, o.w + Math.round(dx / s.geo.px)), h: Math.max(1, o.h + Math.round(dy / s.geo.py)) };
    if (sameRect(cand, s.cand) && drag) return;
    s.cand = cand;
    setDrag({ ix: s.ix, kind: s.kind, geo: s.geo, orig: o, cand, fit: fits(pad, cand, s.ix) });
  };

  const up = (e: TargetedPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    g.current = null;
    if (!s.live) {
      if (s.kind === 'cell' && occupant(pad, s.orig.x, s.orig.y) < 0) {
        const ix = ed.addButton(s.orig.x, s.orig.y);
        if (ix !== null) onOpen(ix, true);
      } else if (s.kind === 'move') onOpen(s.ix);
      return;
    }
    if (s.kind === 'cell') return;
    const f = fits(pad, s.cand, s.ix);
    if (sameRect(s.cand, s.orig) || f.ok) {
      if (f.ok) ed.place(s.ix, s.cand);
      return setDrag(null);
    }
    onRefuse(`Can't ${s.kind} it there: ${refusal(f, pad)}`);
    setDrag({ ix: s.ix, kind: s.kind, geo: s.geo, orig: s.orig, cand: s.orig, fit: f, settling: true });
    settle.current = setTimeout(() => setDrag(null), 260);
  };

  const cancel = (e: TargetedPointerEvent<HTMLDivElement>) => {
    if (!g.current || e.pointerId !== g.current.id) return;
    g.current = null;
    setDrag(null);
  };

  const covered = new Set<string>();
  for (const b of pad.buttons) for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) covered.add(`${x},${y}`);

  const kids: JSX.Element[] = [];
  for (let y = 0; y < pad.rows; y++)
    for (let x = 0; x < pad.cols; x++) {
      const empty = !covered.has(`${x},${y}`);
      kids.push(
        <div key={`c${x},${y}`} class={`ed-cell${empty ? ' is-empty' : ''}`} data-testid={`cell-${x}-${y}`} style={cellStyle({ x, y, w: 1, h: 1 })} aria-hidden="true">
          {empty && <Plus />}
        </div>,
      );
    }
  if (drag && !drag.settling) kids.push(<div key="ghost" class="ed-ghost" style={cellStyle(drag.orig)} aria-hidden="true" />);
  pad.buttons.forEach((b, i) => {
    const d = drag?.ix === i ? drag : null;
    const r = d ? d.cand : b;
    const flashing = !!flash?.ixs.includes(i);
    const refused = d && !d.fit.ok ? (d.fit.reason as string) : flashing ? 'flash' : undefined;
    kids.push(
      <div
        key={`b${i}`}
        class={`ed-item${sel === i ? ' is-selected' : ''}${d ? (d.settling ? ' is-settling' : ' is-dragging') : ''}${bad.has(i) ? ' has-problem' : ''}`}
        style={d ? boxStyle(d.geo, d.cand) : cellStyle(b)}
        data-ix={i}
        data-testid={`edit-btn-${b.id}`}
        data-x={r.x}
        data-y={r.y}
        data-w={r.w}
        data-h={r.h}
        data-drag={d && !d.settling ? d.kind : undefined}
        data-refused={refused}
        data-running={running.has(i) ? '' : undefined}
        tabIndex={0}
        role="button"
        aria-pressed={sel === i}
        aria-label={`${b.label || b.id}: ${b.w}×${b.h} at column ${b.x + 1}, row ${b.y + 1}${running.has(i) ? ', running on the host' : ''}`}
        onFocus={() => sel !== i && !g.current && ed.select(i)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onOpen(i))}
      >
        <ButtonFace vm={vmFor(b)} now={0} aria-hidden="true" style={{ position: 'absolute', inset: '0' }} />
        <div class="ed-ring" key={flashing ? flash!.at : 'ring'} />
        {bad.has(i) && (
          <div class="ed-bad" aria-label="has problems">
            !
          </div>
        )}
        {running.has(i) && (
          <div class="ed-running" data-testid="running-badge" aria-hidden="true">
            <i />
            Running
          </div>
        )}
        {d && !d.settling && !d.fit.ok && <div class="ed-refuse">{cap(refusal(d.fit, pad))}</div>}
        {d && !d.settling && d.kind === 'resize' && d.fit.ok && <div class="ed-size">{`${d.cand.w} × ${d.cand.h}`}</div>}
        {sel === i && !d?.settling && (
          <div class="ed-handle" data-handle data-testid="resize-handle" aria-hidden="true">
            <Resize />
          </div>
        )}
      </div>,
    );
  });

  return (
    <div class="ed-canvas" ref={root} data-testid="edit-canvas" data-dragging={drag && !drag.settling ? '' : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <PadGrid pad={pad}>{kids}</PadGrid>
      {pad.buttons.length === 0 && <div class="ed-empty-hint">{emptyHint}</div>}
    </div>
  );
}
