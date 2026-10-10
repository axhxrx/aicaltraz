/** The menu sheet: fullscreen, keep-awake status, device settings, edit entry, pairing. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Backend } from '../backend/types.ts';
import { DemoBackend } from '../backend/demo.ts';
import { fullscreenSupported, isFullscreen, toggleFullscreen } from '../lib/env.ts';
import { haptic, hapticsSupported, sound, unlockAudio } from '../lib/feedback.ts';
import { awake } from '../lib/keepawake.ts';
import { setSetting, settings } from '../lib/settings.ts';
import { useStore } from '../lib/store.ts';
import { Bolt, Close, Expand, Hold, Link, Pencil, Speaker, Sun, Vibrate } from './icons.tsx';

function Row(p: { icon: ComponentChildren; title: string; note?: string; children?: ComponentChildren; onClick?: () => void; testid?: string; danger?: boolean }) {
  const body = (
    <>
      <span class="bp-row-icon">{p.icon}</span>
      <span class="bp-row-text">
        <span class="bp-row-title">{p.title}</span>
        {p.note && <span class="bp-row-note">{p.note}</span>}
      </span>
      {p.children}
    </>
  );
  return p.onClick ? (
    <button type="button" class={`bp-row${p.danger ? ' is-danger' : ''}`} data-testid={p.testid} onClick={p.onClick}>
      {body}
    </button>
  ) : (
    <div class="bp-row" data-testid={p.testid}>
      {body}
    </div>
  );
}

function Toggle(p: { on: boolean; disabled?: boolean; onChange(v: boolean): void; label: string; testid?: string }) {
  return (
    <button type="button" role="switch" class="bp-switch" aria-checked={p.on} aria-label={p.label} disabled={p.disabled} data-testid={p.testid} onClick={() => p.onChange(!p.on)}>
      <i />
    </button>
  );
}

/** Forgetting the token is one stray tap away from a dead remote: it takes a second tap within 4 s. */
function RepairRow(p: { onRepair(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Row
      icon={<Link />}
      title={armed ? 'Tap again to forget the token' : 'Pair again'}
      note={armed ? 'This device stops working as a remote until it is paired again' : "Forget this device's token"}
      onClick={() => (armed ? p.onRepair() : setArmed(true))}
      danger
      testid={armed ? 'menu-repair-confirm' : 'menu-repair'}
    />
  );
}

export function MenuSheet(p: { backend: Backend; lock: boolean; onClose(): void; onEdit(): void; onRepair(): void }) {
  const snap = useStore(p.backend.snapshot);
  const s = useStore(settings);
  const aw = useStore(awake);
  const fs = useStore(isFullscreen);
  const demo = p.backend instanceof DemoBackend ? p.backend : null;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const host = snap.host;
  // Locked pads open it with a long press: the click its release may make lands on whatever is under the finger now.
  const opened = useRef(p.lock ? performance.now() : -Infinity);
  return (
    <div
      class="bp-sheet-wrap"
      onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}
      onClickCapture={(e) => {
        if (performance.now() - opened.current < 600) (e.preventDefault(), e.stopPropagation());
      }}
      data-testid="menu"
    >
      <div class="bp-sheet" role="dialog" aria-label="Menu" data-scroll>
        <div class="bp-sheet-head">
          <div>
            <div class="bp-sheet-title">ButtPad</div>
            <div class="bp-sheet-sub">
              {host ? `${host.name} · ${host.version}` : 'Not connected'}
              {snap.role && ` · ${snap.role === 'admin' ? 'admin' : 'press only'}`}
            </div>
          </div>
          <button type="button" class="bp-icon-btn" aria-label="Close menu" data-testid="menu-close" onClick={p.onClose}>
            <Close />
          </button>
        </div>

        <Row icon={<Expand />} title="Fullscreen" note={fullscreenSupported() ? undefined : 'Not available here: use Share → Add to Home Screen'}>
          <Toggle label="Fullscreen" on={fs} disabled={!fullscreenSupported()} onChange={() => void toggleFullscreen()} testid="toggle-fullscreen" />
        </Row>
        <Row icon={<Sun />} title="Keep screen awake" note={aw.note} testid="keep-awake">
          <Toggle label="Keep screen awake" on={s.keepAwake} onChange={(v) => setSetting('keepAwake', v)} testid="toggle-awake" />
        </Row>
        <Row icon={<Speaker />} title="Sounds" note="Beeps on fire, success and failure">
          <Toggle
            label="Sounds"
            on={s.sound}
            onChange={(v) => {
              setSetting('sound', v);
              // This click is a user gesture: unlock audio now and let them hear it.
              if (v) (unlockAudio(), setTimeout(() => sound('success'), 60));
            }}
            testid="toggle-sound"
          />
        </Row>
        <Row icon={<Vibrate />} title="Haptics" note={hapticsSupported ? 'Vibrate on fire, success and failure' : 'Not supported by this browser'}>
          <Toggle
            label="Haptics"
            on={s.haptics && hapticsSupported}
            disabled={!hapticsSupported}
            onChange={(v) => (setSetting('haptics', v), v && haptic('fire'))}
            testid="toggle-haptics"
          />
        </Row>
        <Row icon={<Hold />} title="Rough mode" note="Gloves, a shaky mount: one button at a time, firmer taps, a pause after each press" testid="rough">
          <Toggle label="Rough mode" on={s.rough} onChange={(v) => setSetting('rough', v)} testid="toggle-rough" />
        </Row>

        {snap.role === 'admin' && !p.lock && <Row icon={<Pencil />} title="Edit pads" note="Add, move and configure buttons" onClick={p.onEdit} testid="menu-edit" />}

        {demo && (
          <>
            <div class="bp-sheet-section">Demo</div>
            <Row icon={<Bolt />} title={demo.isOnline() ? 'Simulate losing the host' : 'Reconnect to the host'} note="See how buttons look offline" onClick={() => demo.setOnline(!demo.isOnline())} testid="demo-outage" />
            <Row icon={<Bolt />} title="Drop the next press" note="See “NO RESPONSE” after 2 s" onClick={() => (demo.dropAcks(1), p.onClose())} testid="demo-drop" />
            <Row icon={<Bolt />} title="Simulate a host restart" note="What was running ends INTERRUPTED" onClick={() => (demo.restart(), p.onClose())} testid="demo-restart" />
            <Row icon={<Bolt />} title="Reset demo pads" onClick={() => (demo.reset(), p.onClose())} testid="demo-reset" />
          </>
        )}
        {/* Not on a locked (kiosk) pad: nobody there should be able to unpair it. */}
        {p.backend.kind === 'ws' && !p.lock && <RepairRow onRepair={p.onRepair} />}
        <div class="bp-sheet-foot">
          Hold, tap or double-tap per the hint on each button. Keys on a paired keyboard or clicker work too, for buttons on any pad.
          {p.lock && ' This pad is locked: press and hold the menu button to open this menu.'}
        </div>
      </div>
    </div>
  );
}
