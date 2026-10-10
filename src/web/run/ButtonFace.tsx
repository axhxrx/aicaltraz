/**
 * The pure visual of one button: a ButtonVM in, DOM out. No input handling of its own (handlers
 * are passed through), so edit mode can render the same face with a static READY vm.
 */
import { Fragment, type HTMLAttributes } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { inkFor } from '../lib/color.ts';
import { fmtElapsed } from '../lib/env.ts';
import { chunks, fitFontSize, langOf, lineFontSize, lineWidths, useFontEpoch } from '../lib/fit.ts';
import { Check, Cross, DoubleTap, Hold, Keyboard, Lock, Tap, Warn } from '../ui/icons.tsx';
import type { FlashKind } from './controller.ts';
import type { ButtonVM } from './view.ts';

export interface FaceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'class'> {
  vm: ButtonVM;
  /** Local clock for elapsed/countdowns. */
  now: number;
  class?: string;
  style?: Record<string, string>;
}

const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.045)', offset: 0.32 }, { transform: 'scale(0.99)', offset: 0.7 }, { transform: 'scale(1)' }];
const SHAKE: Keyframe[] = [0, -4, 4, -3, 3, -1.5, 0].map((x) => ({ transform: `translateX(${x}%)` }));
const calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Pop/shake are decoration; the fill, flash and colors carry the meaning, so they stay. */
const move = (el: HTMLElement | null, k: Keyframe[], o: KeyframeAnimationOptions) => !calm?.matches && el?.animate(k, o);

/**
 * Multi-line text sized to its box (see lib/fit.ts); `weight` must match the CSS. It is laid out
 * from the same chunks it was measured with: a space or a <wbr> between two, and no other breaks
 * (CSS keep-all), so the browser wraps it the way the size was computed for (CJK included).
 */
function Fit({ text, class: cls, weight = 900, lines }: { text: string; class: string; weight?: number; lines?: number }) {
  useFontEpoch();
  const parts = useMemo(() => chunks(text), [text]);
  if (!parts.length) return null;
  return (
    <div class={cls} lang={langOf(text)} style={{ fontSize: fitFontSize(text, weight, lines) }}>
      {parts.map((c, i) => (
        <Fragment key={i}>
          {i === 0 ? null : c.spaced ? ' ' : <wbr />}
          {c.text}
        </Fragment>
      ))}
    </div>
  );
}

const Sub = ({ text }: { text: string }) => <Fit class="bp-sub" text={text} weight={700} lines={2} />;

/** One line that shrinks to fit the width: clock, %, pill, failure title. */
function Line({ text, class: cls, extraEm = 0, trackEm = 0 }: { text: string; class: string; extraEm?: number; trackEm?: number }) {
  useFontEpoch();
  return (
    <div class={cls} style={{ fontSize: lineFontSize(text, extraEm, trackEm) }}>
      {text}
    </div>
  );
}

const verb = (t: ButtonVM['trigger']) => (t === 'hold' ? 'HOLD' : t === 'tap' ? 'TAP' : 'DOUBLE-TAP');

function Hints({ vm }: { vm: ButtonVM }) {
  const T = vm.trigger === 'hold' ? Hold : vm.trigger === 'tap' ? Tap : DoubleTap;
  return (
    <div class="bp-hints">
      <span class="bp-chip">
        <T />
        {vm.trigger === 'hold' ? 'HOLD' : vm.trigger === 'tap' ? 'TAP' : '2× TAP'}
        {vm.confirm && <Lock />}
      </span>
      {vm.keyHint && (
        <span class="bp-chip bp-key">
          <Keyboard />
          {vm.keyHint}
        </span>
      )}
    </div>
  );
}

function Content({ vm, now }: { vm: ButtonVM; now: number }) {
  const label = <Fit class="bp-label" text={vm.label} />;
  switch (vm.visual) {
    case 'ready':
    case 'arming':
      return (
        <>
          {label}
          <Hints vm={vm} />
        </>
      );
    case 'confirm':
      return (
        <>
          {label}
          <Fit class="bp-head" text={`${verb(vm.trigger)} AGAIN TO CONFIRM`} />
        </>
      );
    case 'sending':
      return (
        <>
          {label}
          <Dots />
        </>
      );
    case 'running': {
      const elapsed = fmtElapsed(now - (vm.startedAt ?? now));
      const det = vm.progress !== undefined;
      const sub = [vm.status, det ? elapsed : null].filter(Boolean).join(' · ');
      const pill = vm.cancelling ? 'CANCELLING…' : vm.queued ? '+1 QUEUED' : vm.cancelHint ? `${verb(vm.trigger)} TO CANCEL` : null;
      return (
        <>
          {label}
          <Line class="bp-num" text={det ? `${Math.round(vm.progress!)}%` : elapsed} />
          {sub && <Sub text={sub} />}
          {pill && <Line class={`bp-pill${vm.cancelling ? ' is-cancelling' : ''}`} text={pill} extraEm={1.9} trackEm={0.07} />}
          {vm.sendingOverlay && <Dots />}
        </>
      );
    }
    case 'success':
      return (
        <>
          {label}
          <Check class="bp-icon" />
          {vm.text && <Sub text={vm.text} />}
          <div class="bp-time">{fmtElapsed((vm.endedAt ?? 0) - (vm.startedAt ?? 0))}</div>
        </>
      );
    case 'failure':
      return (
        <>
          {label}
          <Cross class="bp-icon" />
          <Line class="bp-title" text={vm.title ?? ''} trackEm={0.02} />
          {vm.text && <Sub text={vm.text} />}
        </>
      );
    case 'offline': {
      // What the host was last seen doing (its look stays underneath, dimmed and still).
      const was =
        vm.under === 'running'
          ? `RUNNING · ${vm.progress !== undefined ? `${Math.round(vm.progress)}%` : fmtElapsed(now - (vm.startedAt ?? now))}`
          : vm.under === 'success'
            ? 'LAST RUN OK'
            : vm.under === 'failure'
              ? `LAST RUN: ${vm.title ?? 'FAILED'}`
              : null;
      return (
        <>
          <Warn class="bp-icon" />
          {label}
          <div class="bp-sub bp-offline-tag">OFFLINE</div>
          {was && <Line class="bp-sub bp-offline-was" text={was} trackEm={0.06} />}
        </>
      );
    }
  }
}

const Dots = () => (
  <div class="bp-dots" aria-hidden="true">
    <i />
    <i />
    <i />
  </div>
);

/** Flash badges: [big word, smaller second line]. */
const BADGE: Partial<Record<FlashKind, [string, string?]>> = {
  busy: ['BUSY'],
  later: ['BUSY', 'TRY AGAIN'],
  unknown: ['NOT ON HOST'],
  notsent: ['NOT SENT'],
  ran: ['IT RAN'],
};
const SHAKES: FlashKind[] = ['busy', 'later', 'denied', 'notsent'];
/** As big as the button allows: the word (plus padding) fits 88% of the width. */
const badgeSize = (word: string) => `clamp(12px, min(17cqh, calc(88cqw / ${((lineWidths(word)[0] ?? 3) + 1.1 + 0.04 * word.length).toFixed(3)})), 110px)`;

export function ButtonFace({ vm, now, class: cls, style, ...rest }: FaceProps) {
  const face = useRef<HTMLDivElement>(null);
  const arm = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const armAnim = useRef<Animation | null>(null);
  const v = vm.visual;

  // Hold: the fill rises over holdMs (synced to when the hold began).
  useLayoutEffect(() => {
    const el = arm.current;
    if (!el || !vm.arming) return;
    armAnim.current?.cancel();
    const a = el.animate([{ transform: 'translateY(100%)', opacity: 1 }, { transform: 'translateY(0)', opacity: 1 }], { duration: vm.arming.ms, easing: 'linear', fill: 'forwards' });
    a.currentTime = Math.min(vm.arming.ms, Math.max(0, Date.now() - vm.arming.at));
    armAnim.current = a;
  }, [vm.arming?.at]);

  // Released early / drifted: drain fast from wherever it got to.
  useLayoutEffect(() => {
    const el = arm.current;
    const a = armAnim.current;
    if (!vm.disarmAt || !el || !a) return;
    const p = Number(a.effect?.getComputedTiming().progress ?? 0);
    a.cancel();
    armAnim.current = el.animate([{ transform: `translateY(${(1 - p) * 100}%)`, opacity: 1 }, { transform: 'translateY(100%)', opacity: 1 }], {
      duration: 90 + 170 * p,
      easing: 'cubic-bezier(.5,0,.9,.6)',
      fill: 'forwards',
    });
  }, [vm.disarmAt]);

  // Fired: pop + flash, and the full fill fades away.
  useLayoutEffect(() => {
    if (!vm.firedAt || Date.now() - vm.firedAt > 400) return;
    move(face.current, POP, { duration: 320, easing: 'cubic-bezier(.2,.8,.3,1)' });
    flash.current?.animate([{ opacity: 0.65 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
    const el = arm.current;
    if (el && armAnim.current) {
      armAnim.current.cancel();
      armAnim.current = el.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(0)', opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
    }
  }, [vm.firedAt]);

  // BUSY / pressed while offline / not sent: shake.
  useLayoutEffect(() => {
    if (vm.flash && SHAKES.includes(vm.flash.kind)) move(face.current, SHAKE, { duration: 420, easing: 'ease-out' });
  }, [vm.flash?.at]);

  // Countdown bars: start where the host (or the confirm window) says they started.
  const drain = useMemo(() => {
    if ((v === 'success' || v === 'failure') && vm.endedAt !== undefined && vm.resultHoldMs)
      return { kind: 'result', duration: vm.resultHoldMs, delay: Math.min(0, vm.endedAt - Date.now()) };
    if (v === 'confirm' && vm.confirmUntil && vm.confirmMs) return { kind: 'confirm', duration: vm.confirmMs, delay: Math.min(0, vm.confirmUntil - vm.confirmMs - Date.now()) };
    return null;
  }, [v, vm.endedAt, vm.confirmUntil]);

  const ink = inkFor(vm.color);
  // Offline: the last-known state's layers stay, under the OFFLINE look.
  const u = v === 'offline' ? vm.under : v;
  const badge = vm.flash ? BADGE[vm.flash.kind] : undefined;
  return (
    <div
      class={`bp-btn${cls ? ` ${cls}` : ''}`}
      data-visual={v}
      data-under={v === 'offline' ? vm.under : undefined}
      data-testid={`btn-${vm.id}`}
      data-flash={vm.flash?.kind}
      role="button"
      aria-label={`${vm.label || vm.id}: ${v}${v === 'offline' && vm.under && vm.under !== 'ready' ? ` (last seen ${vm.under})` : ''}`}
      style={{ '--bg': vm.color, '--ink': ink, ...style }}
      {...rest}
    >
      <div ref={face} class={`bp-face${vm.pressed ? ' is-pressed' : ''}`}>
        <div class="bp-base" />
        {u === 'running' && vm.progress === undefined && <div class="bp-stripes" />}
        {u === 'running' && vm.progress !== undefined && <div class="bp-prog" style={{ '--p': String(vm.progress / 100) }} />}
        {(v === 'success' || v === 'failure') && <div key={`${v}${vm.endedAt}`} class="bp-flood" />}
        {v === 'offline' && (u === 'success' || u === 'failure') && <div class={`bp-tint is-${u}`} />}
        {v === 'failure' && <div class="bp-pulse" />}
        <div ref={arm} class="bp-arm" />
        <div ref={flash} class="bp-flash" />
        {(v === 'confirm' || v === 'offline') && <div class="bp-frame" />}
        <div class="bp-content">
          <Content vm={vm} now={now} />
        </div>
        {vm.doubleWait && (
          <div class="bp-pips" aria-hidden="true">
            <i />
            <i />
          </div>
        )}
        {drain && <div key={`${drain.kind}${vm.endedAt ?? vm.confirmUntil}`} class={`bp-drain bp-drain-${drain.kind}`} style={{ animationDuration: `${drain.duration}ms`, animationDelay: `${drain.delay}ms` }} />}
        {vm.flash && badge && (
          <div key={vm.flash.at} class="bp-badge" style={{ fontSize: badgeSize(badge[0]) }}>
            {badge[0]}
            {badge[1] && <small>{badge[1]}</small>}
          </div>
        )}
      </div>
    </div>
  );
}
