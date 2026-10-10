/** Run mode: the pad grid, live buttons (pointer + keyboard), wired to a Backend. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { buttonKey } from '../../core/config.ts';
import type { WireButton, WirePad } from '../../core/protocol.ts';
import type { Backend } from '../backend/types.ts';
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
  ctrl.setCtx({ button, host, online: link === 'online', press: () => backend.press(padId, button.id), kick: () => backend.kick() });
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
        if (ctrl.down(src(e), e.clientX, e.clientY)) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => ctrl.move(src(e), e.clientX, e.clientY)}
      onPointerUp={(e) => ctrl.up(src(e))}
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

/** BLE remotes/clickers pair as keyboards: keydown starts the press, keyup releases. */
function useKeys(pad: WirePad, registry: Registry, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const held = new Map<string, string>();
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const b = matchKey(pad.buttons, e.key);
      if (!b) return;
      e.preventDefault();
      if (e.repeat) return;
      const code = e.code || e.key;
      if (held.has(code)) return;
      held.set(code, b.id);
      registry.get(b.id)?.down(`k${code}`, 0, 0);
    };
    const up = (e: KeyboardEvent) => {
      const code = e.code || e.key;
      const id = held.get(code);
      if (id === undefined) return;
      held.delete(code);
      e.preventDefault();
      registry.get(id)?.up(`k${code}`);
    };
    const blur = () => {
      for (const [code, id] of held) registry.get(id)?.abort(`k${code}`);
      held.clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      blur();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [pad, registry, enabled]);
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
