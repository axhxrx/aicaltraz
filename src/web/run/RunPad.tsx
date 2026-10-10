/** Run mode: the pad grid and its live buttons (pointer input), wired to the run session. */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { buttonKey } from '../../core/config.ts';
import type { WireButton, WirePad } from '../../core/protocol.ts';
import { wall } from '../lib/clock.ts';
import { eventTime } from '../lib/env.ts';
import { useStore } from '../lib/store.ts';
import { ButtonFace } from './ButtonFace.tsx';
import type { RunSession } from './session.ts';
import { READY, tickFor, viewOf } from './view.ts';

// Edit mode checks key conflicts with the same matcher run mode uses.
export { matchKey } from './session.ts';

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

/** Re-render every `ms` while > 0 (running clocks, "12 s ago"). */
function useTicker(ms: number): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!ms) return;
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function RunButton({ session, pad, button }: { session: RunSession; pad: WirePad; button: WireButton }) {
  const { backend } = session;
  const key = buttonKey(pad.id, button.id);
  const ctrl = session.controller(pad, button);
  const host = useStore(backend.snapshot, (s) => s.states[key]) ?? READY;
  const link = useStore(backend.snapshot, (s) => s.status);
  const skew = useStore(backend.snapshot, (s) => s.clockSkew);
  const latched = useStore(backend.snapshot, (s) => s.latched[key]);
  const lastSeen = useStore(backend.snapshot, (s) => s.lastSeen);
  const local = useStore(ctrl.local);

  const now = wall();
  const vm = viewOf(button, host, local, link, skew, now, { latched, lastSeen });
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
        if (!ctrl.down(src(e), e.clientX, e.clientY, eventTime(e), e.pointerType)) return;
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
      onDismiss={() => ctrl.dismiss()}
    />
  );
}

export function RunPad({ session, pad }: { session: RunSession; pad: WirePad }) {
  const link = useStore(session.backend.snapshot, (s) => s.status);
  useEffect(() => {
    session.setVisible(pad.id);
    return () => session.setVisible(null);
  }, [session, pad.id]);
  return (
    <PadGrid pad={pad} data-link={link} data-pad={pad.id} data-run="">
      {pad.buttons.map((b) => (
        <RunButton key={buttonKey(pad.id, b.id)} session={session} pad={pad} button={b} />
      ))}
    </PadGrid>
  );
}
