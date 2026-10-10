/** Run mode: the pad grid, live buttons (pointer + keyboard), wired to a Backend. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buttonKey } from '../../core/config.ts';
import type { WireButton, WirePad } from '../../core/protocol.ts';
import type { Backend } from '../backend/types.ts';
import { eventTime } from '../lib/env.ts';
import { useStore } from '../lib/store.ts';
import { ButtonFace } from './ButtonFace.tsx';
import { ButtonController } from './controller.ts';
import { READY, tickFor, viewOf } from './view.ts';

/** Layout only (CSS grid cols×rows; buttons placed by x,y,w,h). Shared with edit mode. */
export function PadGrid({ pad, children, ...rest }: { pad: Pick<WirePad, 'cols' | 'rows'>; children?: JSX.Element | JSX.Element[] } & Record<string, unknown>) {
  return (
    <div class="bp-grid" style={{ '--cols': String(pad.cols), '--rows': String(pad.rows) }} {...rest}>
      {children}
    </div>
  );
}

export const cellStyle = (b: Pick<WireButton, 'x' | 'y' | 'w' | 'h'>): Record<string, string> => ({
  gridColumn: `${b.x + 1} / span ${b.w}`,
  gridRow: `${b.y + 1} / span ${b.h}`,
});

/** Re-render every `ms` while > 0 (running clocks). */
function useTicker(ms: number): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!ms) return;
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

type Registry = Map<string, ButtonController>;

function RunButton({ backend, padId, button, registry }: { backend: Backend; padId: string; button: WireButton; registry: Registry }) {
  const key = buttonKey(padId, button.id);
  const host = useStore(backend.snapshot, (s) => s.states[key]) ?? READY;
  const link = useStore(backend.snapshot, (s) => s.status);
  const skew = useStore(backend.snapshot, (s) => s.clockSkew);
  const ctrl = useMemo(() => new ButtonController(), []);
  ctrl.setCtx({
    button,
    // Live, not this render's copies: an ack or a dropped link lands between renders.
    host: () => backend.snapshot.get().states[key] ?? READY,
    online: () => backend.snapshot.get().status === 'online',
    press: (onSent) => backend.press(padId, button.id, onSent),
    kick: () => backend.kick(),
  });
  const local = useStore(ctrl.local);
  useEffect(() => ctrl.onHost(host), [host]);
  useEffect(() => ctrl.onLink(link === 'online'), [link]);
  useEffect(() => {
    registry.set(button.id, ctrl);
    return () => registry.get(button.id) === ctrl && registry.delete(button.id);
  }, [button.id]);
  useEffect(() => () => ctrl.dispose(), []);

  const now = Date.now();
  const vm = viewOf(button, host, local, link, skew, now);
  useTicker(tickFor(vm, now));

  const src = (e: PointerEvent) => `p${e.pointerId}`;
  return (
    <ButtonFace
      vm={vm}
      now={now}
      style={cellStyle(button)}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        if (!ctrl.down(src(e), e.clientX, e.clientY, eventTime(e))) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is gone already (its up is queued right behind) */
        }
      }}
      onPointerMove={(e) => ctrl.move(src(e), e.clientX, e.clientY, eventTime(e))}
      onPointerUp={(e) => ctrl.up(src(e), eventTime(e))}
      onPointerCancel={(e) => ctrl.abort(src(e))}
      onLostPointerCapture={(e) => ctrl.abort(src(e))}
    />
  );
}

const ALIASES: Record<string, string> = { space: ' ', spacebar: ' ', esc: 'Escape', return: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const norm = (k: string) => ALIASES[k.toLowerCase()] ?? k;

export function matchKey(buttons: WireButton[], key: string): WireButton | undefined {
  return (
    buttons.find((b) => b.key !== undefined && norm(b.key) === key) ??
    (key.length === 1 ? buttons.find((b) => b.key !== undefined && b.key.length === 1 && b.key.toLowerCase() === key.toLowerCase()) : undefined)
  );
}

const typing = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]');
/** Enter/Space on a focused control (menu button, tabs) belong to that control. */
const control = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a[href], summary, [role=switch], [role=tab]');

/**
 * BLE remotes/clickers pair as keyboards, and send keydown and keyup in one go: a mapped key fires
 * its button on keydown, hold and tap triggers alike (holding a key is no gesture; auto-repeat is
 * ignored). A double fires on the second keydown within 400 ms. Confirm still applies.
 */
function useKeys(pad: WirePad, registry: Registry, enabled: boolean) {
  // The latest pad, without re-subscribing on every config broadcast.
  const padRef = useRef(pad);
  padRef.current = pad;
  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if ((e.key === 'Enter' || e.key === ' ') && control(e.target)) return;
      const b = matchKey(padRef.current.buttons, e.key);
      if (!b) return;
      e.preventDefault();
      const code = e.code || e.key;
      if (e.repeat || held.has(code)) return;
      held.add(code);
      registry.get(b.id)?.key(eventTime(e));
    };
    const up = (e: KeyboardEvent) => {
      if (held.delete(e.code || e.key)) e.preventDefault();
    };
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [pad.id, registry, enabled]);
}

export function RunPad({ backend, pad, keys = true }: { backend: Backend; pad: WirePad; keys?: boolean }) {
  const registry = useMemo<Registry>(() => new Map(), []);
  const link = useStore(backend.snapshot, (s) => s.status);
  useKeys(pad, registry, keys);
  return (
    <PadGrid pad={pad} data-link={link} data-pad={pad.id}>
      {pad.buttons.map((b) => (
        <RunButton key={buttonKey(pad.id, b.id)} backend={backend} padId={pad.id} button={b} registry={registry} />
      ))}
    </PadGrid>
  );
}
