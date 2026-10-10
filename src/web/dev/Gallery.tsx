/**
 * `?gallery`: every button state side by side, for design QA and screenshots (incl. grayscale).
 * Also exports `vmFor`, a static view model for a button (edit mode previews).
 */
import { useEffect, useState } from 'preact/hooks';
import type { WireButton } from '../../core/protocol.ts';
import { ButtonFace } from '../run/ButtonFace.tsx';
import type { ButtonVM } from '../run/view.ts';
import { keyName } from '../run/view.ts';

export function vmFor(b: Pick<WireButton, 'id' | 'label' | 'color' | 'trigger' | 'holdMs' | 'confirm' | 'key'>, over: Partial<ButtonVM> = {}): ButtonVM {
  return {
    id: b.id,
    label: b.label,
    color: b.color,
    visual: 'ready',
    trigger: b.trigger,
    holdMs: b.holdMs,
    confirm: b.confirm,
    keyHint: b.key ? keyName(b.key) : undefined,
    arming: null,
    disarmAt: 0,
    firedAt: 0,
    pressed: false,
    doubleWait: false,
    flash: null,
    sendingOverlay: false,
    ...over,
  };
}

const LONG = 3_600_000;

/** `t0`: fixed mount time, so animations keyed on timestamps don't restart every tick. */
function tiles(now: number): [string, ButtonVM][] {
  const b = (id: string, label: string, color: string, extra: Partial<WireButton> = {}) =>
    ({ id, label, color, trigger: 'hold', holdMs: 500, confirm: false, ...extra }) as WireButton;
  return [
    ['READY', vmFor(b('ready', 'Key light', '#facc15', { key: '1' }))],
    ['ARMING 60%', vmFor(b('arming', 'Fill light', '#2f6fde'), { visual: 'arming', arming: { at: now - LONG * 0.6, ms: LONG } })],
    ['CONFIRM', vmFor(b('confirm', 'ALL OFF', '#4338ca', { confirm: true }), { visual: 'confirm', confirmUntil: now + LONG * 0.6, confirmMs: LONG })],
    ['SENDING', vmFor(b('sending', 'Strobe', '#db2777', { trigger: 'double' }), { visual: 'sending' })],
    ['RUNNING', vmFor(b('running', 'Render preview', '#0891b2'), { visual: 'running', startedAt: now - 3400, status: 'encoding frame 75/600', cancelHint: true })],
    ['RUNNING 42%', vmFor(b('progress', 'Backdrop sunset', '#7c3aed'), { visual: 'running', startedAt: now - 2100, progress: 42, status: 'fading in' })],
    ['SUCCESS', vmFor(b('success', 'Upload selects', '#2f6fde'), { visual: 'success', startedAt: now - 2300, endedAt: now - 120, text: '12 photos uploaded', resultHoldMs: LONG })],
    ['FAILURE', vmFor(b('failure', 'Card backup', '#f97316'), { visual: 'failure', startedAt: now - 1500, endedAt: now - 120, title: 'EXIT 3', text: 'card full: 0 bytes free', resultHoldMs: LONG })],
    ['OFFLINE · WAS RUNNING', vmFor(b('offrun', 'Fog machine', '#7c3aed'), { visual: 'offline', under: 'running', startedAt: now - 12_300 })],
    ['NO RESPONSE', vmFor(b('noresp', 'Fill light', '#2f6fde', { trigger: 'tap' }), { visual: 'failure', startedAt: now, endedAt: now - 120, title: 'NO RESPONSE', text: 'The host didn’t answer in 2 s', resultHoldMs: LONG })],
    ['BUSY', vmFor(b('busy', 'Render preview', '#0891b2'), { visual: 'running', startedAt: now - 8200, flash: { kind: 'busy', at: now } })],
    ['OFFLINE', vmFor(b('offline', 'Mark clip', '#2f6fde', { trigger: 'tap' }), { visual: 'offline' })],
  ];
}

export function Gallery() {
  const [t0] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [wide, setWide] = useState(() => innerWidth > innerHeight);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    const r = () => setWide(innerWidth > innerHeight);
    addEventListener('resize', r);
    return () => (clearInterval(t), removeEventListener('resize', r));
  }, []);
  // ?gallery&cols=4&rows=6 repeats the tiles in a denser grid (small-button check).
  const q = new URLSearchParams(location.search);
  const cols = Number(q.get('cols')) || (wide ? 4 : 3);
  const rows = Number(q.get('rows')) || (wide ? 3 : 4);
  const base = tiles(t0);
  const list = Array.from({ length: cols * rows }, (_, i) => {
    const [name, vm] = base[i % base.length]!;
    return [name, { ...vm, id: `${vm.id}${i >= base.length ? i : ''}` }] as const;
  });
  return (
    <div class="app bp-gallery" style={{ '--cols': String(cols), '--rows': String(rows) }}>
      <div class="bp-grid">
        {list.map(([name, vm]) => (
          <div class="bp-gallery-cell" key={vm.id}>
            <div class="bp-gallery-name">{name}</div>
            <ButtonFace vm={vm} now={now} />
          </div>
        ))}
      </div>
    </div>
  );
}
