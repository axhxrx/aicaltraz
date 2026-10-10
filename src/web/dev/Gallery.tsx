/**
 * `?gallery`: every button state side by side, for design QA and screenshots (incl. grayscale).
 * Also exports `vmFor`, a static view model for a button (edit mode previews).
 */
import { useEffect, useState } from 'preact/hooks';
import type { WireButton } from '../../core/protocol.ts';
import { wall } from '../lib/clock.ts';
import { paintColor } from '../lib/color.ts';
import { ButtonFace } from '../run/ButtonFace.tsx';
import type { ButtonVM } from '../run/view.ts';
import { keyName } from '../run/view.ts';

export function vmFor(b: Pick<WireButton, 'id' | 'label' | 'color' | 'trigger' | 'holdMs' | 'confirm' | 'key'>, over: Partial<ButtonVM> = {}): ButtonVM {
  return {
    id: b.id,
    label: b.label,
    color: paintColor(b.color),
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

/** `now`: fixed mount time, so animations keyed on timestamps don't restart every tick. */
function tiles(now: number): [string, ButtonVM][] {
  const b = (id: string, label: string, color: string, extra: Partial<WireButton> = {}) =>
    ({ id, label, color, trigger: 'hold', holdMs: 500, confirm: false, ...extra }) as WireButton;
  return [
    ['READY', vmFor(b('ready', 'Key light', '#facc15', { key: '1' }), { last: { tone: 'ok', ago: '12 s ago' }, latched: 'ON 80%' })],
    ['ARMING 60%', vmFor(b('arming', 'Fill light', '#2f6fde', { holdMs: 1500, key: 'PageDown' }), { visual: 'arming', arming: { at: now - LONG * 0.6, ms: LONG } })],
    ['CONFIRM', vmFor(b('confirm', 'ALL OFF', '#4338ca', { confirm: true }), { visual: 'confirm', confirmUntil: now + LONG * 0.6, confirmMs: LONG, confirmVerb: 'HOLD' })],
    ['RUNNING', vmFor(b('running', 'Render preview', '#0891b2'), { visual: 'running', startedAt: now - 3400, status: 'encoding frame 75/600', cancelHint: true, other: true })],
    ['RUNNING 42%', vmFor(b('progress', 'Backdrop sunset', '#7c3aed'), { visual: 'running', startedAt: now - 2100, progress: 42, status: 'fading in' })],
    ['SUCCESS', vmFor(b('success', 'Upload selects', '#2f6fde'), { visual: 'success', endedAt: now - 120, elapsedMs: 2180, text: '12 photos uploaded', resultHoldMs: LONG })],
    ['FAILURE', vmFor(b('failure', 'Card backup', '#f97316'), { visual: 'failure', endedAt: now - 120, title: 'card full: 0 bytes free', detail: 'EXIT 3', code: 'EXIT 3', sticky: true })],
    ['STOPPED', vmFor(b('stopped', 'Haze', '#0d9488', { trigger: 'tap' }), { visual: 'stopped', endedAt: now - 120, title: 'STOPPED', detail: 'stopped by ALL OFF', code: 'STOPPED', resultHoldMs: LONG })],
    ['NO RESPONSE', vmFor(b('noresp', 'Fill light', '#2f6fde', { trigger: 'tap' }), { visual: 'unknown', endedAt: now - 120, title: 'NO RESPONSE', detail: 'The host didn’t answer in 2 s', code: 'NO RESPONSE', sticky: true })],
    ['INTERRUPTED', vmFor(b('interrupted', 'REC', '#f97316'), { visual: 'interrupted', endedAt: now - 120, title: 'INTERRUPTED', detail: 'the host stopped while it ran', code: 'INTERRUPTED', sticky: true, latched: 'REC ●' })],
    ['WAS RUNNING', vmFor(b('offrun', 'Fog machine', '#7c3aed'), { visual: 'offline', under: 'running', startedAt: now - 12_300, seenElapsed: 12_300 })],
    ['BUSY', vmFor(b('busy', 'Render preview', '#0891b2'), { visual: 'running', startedAt: now - 8200, flash: { kind: 'busy', at: now } })],
    ['SLIPPED', vmFor(b('slipped', 'Hazer', '#ea580c'), { flash: { kind: 'slipped', at: now } })],
    ['2× TAP: 1st', vmFor(b('double', 'Strobe', '#db2777', { trigger: 'double', key: ' ' }), { doubleWait: true })],
    ['OFFLINE', vmFor(b('offline', 'Mark clip', '#2f6fde', { trigger: 'tap' }), { visual: 'offline' })],
  ];
}

export function Gallery() {
  const [t0] = useState(wall);
  const [now, setNow] = useState(wall);
  const [wide, setWide] = useState(() => innerWidth > innerHeight);
  useEffect(() => {
    const t = setInterval(() => setNow(wall()), 100);
    const r = () => setWide(innerWidth > innerHeight);
    addEventListener('resize', r);
    return () => (clearInterval(t), removeEventListener('resize', r));
  }, []);
  // ?gallery&cols=4&rows=6 repeats the tiles in a denser grid (small-button check).
  const q = new URLSearchParams(location.search);
  const cols = Number(q.get('cols')) || (wide ? 5 : 3);
  const rows = Number(q.get('rows')) || (wide ? 3 : 5);
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
