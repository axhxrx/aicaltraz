/**
 * Thin top bar: pad tabs, connection indicator, menu button. Navigation takes a deliberate touch:
 * a glove brushing a tab doesn't switch pads (≥ 80 ms down without sliding), and on a locked pad
 * the menu opens only on a long press.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WirePad } from '../../core/protocol.ts';
import type { ConnStatus } from '../backend/types.ts';
import { awake } from '../lib/keepawake.ts';
import { settings } from '../lib/settings.ts';
import { useStore } from '../lib/store.ts';
import type { PadMark } from '../run/session.ts';
import { Menu, Moon } from './icons.tsx';

const CONN: Record<ConnStatus, string> = { online: 'LIVE', connecting: 'CONNECTING', offline: 'OFFLINE', unauthorized: 'REJECTED' };

/** A touch shorter than this on a tab or the menu button is a brush, not a tap. */
export const NAV_MIN_MS = 80;
/** How far a finger may slide on a tab and still tap it (more is a scroll, or a slip). */
const NAV_DRIFT_PX = 12;
/** Locked pads: the menu opens after a press this long. */
export const LOCK_MENU_MS = 1000;

/**
 * Pointer handlers that activate on a deliberate press: a touch or pen down ≥ NAV_MIN_MS without
 * sliding (a mouse click as usual), or, with `longMs`, any pointer held that long. A keyboard
 * activation (Enter/Space on the focused control) counts unless `longMs` is set.
 */
function useDeliberate(activate: () => void, longMs = 0) {
  const st = useRef<{ type: string; t0: number; x: number; y: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const [holding, setHolding] = useState(false);
  /** performance.now() of the last pointerdown: a click right after one is that pointer's, not the keyboard's. */
  const lastDown = useRef(-Infinity);
  const act = useRef(activate);
  act.current = activate;
  const stop = () => {
    clearTimeout(st.current?.timer);
    st.current = null;
    setHolding(false);
  };
  useEffect(() => () => clearTimeout(st.current?.timer), []);
  const handlers = {
    onPointerDown(e: PointerEvent) {
      lastDown.current = performance.now();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // No focus: Enter/Space from a remote must not land on a tab or the menu button.
      e.preventDefault();
      const s = { type: e.pointerType, t0: e.timeStamp, x: e.clientX, y: e.clientY } as NonNullable<typeof st.current>;
      clearTimeout(st.current?.timer);
      st.current = s;
      if (longMs) {
        setHolding(true);
        s.timer = setTimeout(() => {
          if (st.current !== s) return;
          stop();
          act.current();
        }, longMs);
      }
    },
    onPointerMove(e: PointerEvent) {
      const s = st.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > NAV_DRIFT_PX) stop();
    },
    onPointerUp(e: PointerEvent) {
      const s = st.current;
      if (!s) return;
      stop();
      if (longMs) return;
      if (s.type !== 'mouse' && e.timeStamp - s.t0 < NAV_MIN_MS) return;
      act.current();
    },
    onPointerCancel: stop,
    onPointerLeave: stop,
    onClick() {
      // Pointer presses are decided above (a touch's click can even say detail 0); this is the keyboard.
      if (performance.now() - lastDown.current > 1500 && !longMs) act.current();
    },
  };
  return { holding, handlers };
}

function Tab(p: { pad: WirePad; active: boolean; mark?: PadMark; onPad(id: string): void }) {
  const { handlers } = useDeliberate(() => p.onPad(p.pad.id));
  const ref = useRef<HTMLButtonElement>(null);
  // The active tab is always in view, however many pads there are (the tab strip scrolls).
  useEffect(() => {
    if (p.active) ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [p.active]);
  return (
    <button ref={ref} type="button" role="tab" class="bp-tab" aria-selected={p.active} data-testid={`tab-${p.pad.id}`} data-mark={p.active ? undefined : p.mark} {...handlers}>
      {p.pad.name}
      {!p.active && p.mark && <i class={`bp-tab-dot is-${p.mark}`} aria-label={p.mark === 'failure' ? 'something failed here' : 'running'} />}
    </button>
  );
}

/** Keep-awake is off, or isn't holding the screen (e.g. it needs a tap first): the screen may go dark. */
function useSleepy(): boolean {
  const s = useStore(settings);
  const aw = useStore(awake);
  const [settled, setSettled] = useState(false);
  // Starting up takes a moment (and often a first tap); don't flash the warning meanwhile.
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 3000);
    return () => clearTimeout(t);
  }, []);
  return !s.keepAwake || (settled && !aw.active);
}

export function TopBar(p: {
  pads: WirePad[];
  /** The pad on screen (null: none, e.g. the one asked for doesn't exist). */
  padId: string | null;
  title?: string;
  showTabs: boolean;
  status: ConnStatus;
  demo: boolean;
  hostFull: boolean;
  lock: boolean;
  marks: Record<string, PadMark>;
  onPad(id: string): void;
  onMenu(): void;
}) {
  const current = p.pads.find((x) => x.id === p.padId);
  const menu = useDeliberate(p.onMenu, p.lock ? LOCK_MENU_MS : 0);
  const sleepy = useSleepy();
  const label = p.status === 'online' && p.demo ? 'DEMO' : (p.status === 'offline' || p.status === 'connecting') && p.hostFull ? 'HOST FULL' : CONN[p.status];
  return (
    <header class="bp-bar">
      {p.showTabs ? (
        <nav class="bp-tabs" role="tablist" data-scroll-x>
          {p.pads.map((pad) => (
            <Tab key={pad.id} pad={pad} active={pad.id === p.padId} mark={p.marks[pad.id]} onPad={p.onPad} />
          ))}
        </nav>
      ) : (
        <div class="bp-bar-title">{p.title ?? current?.name ?? 'ButtPad'}</div>
      )}
      {sleepy && (
        <span class="bp-sleepy" data-testid="sleepy" role="status" title="Keep screen awake is off (menu)">
          <Moon />
          <span>SCREEN MAY SLEEP</span>
        </span>
      )}
      <div class="bp-conn" data-status={p.status} data-demo={p.demo ? '' : undefined} data-testid="conn" role="status" aria-label={`connection: ${p.demo && p.status === 'online' ? 'demo' : p.status}`}>
        <i class="bp-dot" />
        <span>{label}</span>
      </div>
      <button
        type="button"
        class={`bp-icon-btn bp-menu-btn${menu.holding ? ' is-holding' : ''}`}
        aria-label={p.lock ? 'Menu (press and hold)' : 'Menu'}
        data-testid="menu-btn"
        style={{ '--hold-ms': `${LOCK_MENU_MS}ms` }}
        {...menu.handlers}
      >
        <Menu />
      </button>
    </header>
  );
}
