/**
 * The pure visual of one button: a ButtonVM in, DOM out. No input handling of its own (handlers
 * are passed through), so edit mode can render the same face with a static READY vm.
 */
import { Fragment, type HTMLAttributes, type JSX } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { wall } from '../lib/clock.ts';
import { inkFor } from '../lib/color.ts';
import { fmtElapsed } from '../lib/env.ts';
import { chunks, fitFontSize, langOf, lineFontSize, lineWidths, useFontEpoch } from '../lib/fit.ts';
import { Check, Cross, Devices, DoubleTap, Hold, Interrupted, Keyboard, Lock, Question, Stop, Tap, Warn } from '../ui/icons.tsx';
import type { FlashKind } from './controller.ts';
import { holdChip, isResult, verbOf, type ButtonVM, type Visual } from './view.ts';

export interface FaceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'class'> {
  vm: ButtonVM;
  /** Local clock (lib/clock.ts wall()) for elapsed/countdowns. */
  now: number;
  class?: string;
  style?: Record<string, string>;
  /** The ✕ on a result kept on screen (run mode): clears it without a press. */
  onDismiss?: () => void;
}

const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.045)', offset: 0.32 }, { transform: 'scale(0.99)', offset: 0.7 }, { transform: 'scale(1)' }];
const SHAKE: Keyframe[] = [0, -4, 4, -3, 3, -1.5, 0].map((x) => ({ transform: `translateX(${x}%)` }));
const calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Pop/shake are decoration; the fill, flash and colors carry the meaning, so they stay. */
const move = (el: HTMLElement | null, k: Keyframe[], o: KeyframeAnimationOptions) => !calm?.matches && el?.animate(k, o);

/** Longest text rendered (labels are ≤ 200 characters by the schema; anything longer is cut). */
const MAX_TEXT = 400;

/**
 * Multi-line text sized to its box (see lib/fit.ts); `weight` must match the CSS. It is laid out
 * from the same chunks it was measured with: a space or a <wbr> between two, and no other breaks
 * (CSS keep-all), so the browser wraps it the way the size was computed for (CJK included).
 */
function Fit({ text, class: cls, weight = 900, lines }: { text: string; class: string; weight?: number; lines?: number }) {
  useFontEpoch();
  const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  const parts = useMemo(() => chunks(shown), [shown]);
  if (!parts.length) return null;
  return (
    <div class={cls} lang={langOf(shown)} style={{ fontSize: fitFontSize(shown, weight, lines) }}>
      {parts.map((c, i) => (
        <Fragment key={i}>
          {i === 0 ? null : c.spaced ? ' ' : <wbr />}
          {c.text}
        </Fragment>
      ))}
    </div>
  );
}

const Sub = ({ text, class: cls = '' }: { text: string; class?: string }) => <Fit class={`bp-sub${cls ? ` ${cls}` : ''}`} text={text} weight={700} lines={2} />;

/**
 * One line that shrinks to fit the width: clock, %, pill. `under`: never bigger than `scale` × the
 * size that text gets as a label (the element carries the label's --fit-* variables, CSS).
 */
function Line({ text, class: cls, extraEm = 0, trackEm = 0, under }: { text: string; class: string; extraEm?: number; trackEm?: number; under?: string }) {
  useFontEpoch();
  const size = lineFontSize(text, extraEm, trackEm);
  return (
    <div class={cls} style={{ fontSize: under ? `min(${size}, calc(${fitFontSize(under)} * 0.9))` : size }}>
      {text}
    </div>
  );
}

function Hints({ vm }: { vm: ButtonVM }) {
  const T = vm.trigger === 'hold' ? Hold : vm.trigger === 'tap' ? Tap : DoubleTap;
  // HOLD 1.5s: on a narrow button the word goes first (the icon says it), the duration stays.
  const [word, extra] = vm.trigger === 'hold' ? [holdChip(vm.holdMs).slice(0, 4), holdChip(vm.holdMs).slice(4)] : [vm.trigger === 'tap' ? 'TAP' : '2× TAP', ''];
  return (
    <div class="bp-hints">
      <span class={`bp-chip bp-trigger${extra ? ' has-extra' : ''}${vm.trigger === 'double' ? ' is-double' : ''}`}>
        <T />
        <span class="bp-chip-text">
          <span class="bp-chip-word">{word}</span>
          {extra}
        </span>
        {vm.confirm && <Lock />}
      </span>
      {vm.keyHint && (
        <span class="bp-chip bp-key">
          <Keyboard />
          <span class="bp-chip-text">{vm.keyHint}</span>
        </span>
      )}
    </div>
  );
}

const LAST_GLYPH = { ok: '✓', bad: '✗', stopped: '■', warn: '!' } as const;

/**
 * The top edge: another device's run, how the last run ended, or the ✕ of a result kept on screen
 * (left); latched device state (right).
 */
function TopBand({ vm, onDismiss }: { vm: ButtonVM; onDismiss?: () => void }) {
  const left = vm.other ? (
    <span class="bp-mark bp-other" data-testid={`other-${vm.id}`}>
      <Devices />
      <span class="bp-chip-text">OTHER DEVICE</span>
    </span>
  ) : vm.last ? (
    <span class={`bp-mark bp-last is-${vm.last.tone}`} data-testid={`last-${vm.id}`}>
      <i>{LAST_GLYPH[vm.last.tone]}</i>
      <span class="bp-chip-text">
        <span class="bp-long">{vm.last.ago}</span>
        <span class="bp-short">{vm.last.ago.replace(/ (\w) ago$/, '$1')}</span>
      </span>
    </span>
  ) : vm.sticky && onDismiss ? (
    <button
      type="button"
      class="bp-dismiss"
      data-testid={`dismiss-${vm.id}`}
      aria-label={`Clear this result (${vm.label || vm.id})`}
      // Its own touch: not a press of the button under it.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
    >
      ✕
    </button>
  ) : null;
  if (!left && !vm.latched) return null;
  return (
    <div class="bp-top">
      {left ?? <span />}
      {vm.latched && (
        <span class="bp-latched" data-testid={`latched-${vm.id}`}>
          {vm.latched}
        </span>
      )}
    </div>
  );
}

const GLYPH: Partial<Record<Visual, (p: { class?: string }) => JSX.Element>> = { failure: Cross, stopped: Stop, unknown: Question, interrupted: Interrupted };

function Content({ vm, now }: { vm: ButtonVM; now: number }) {
  const label = <Fit class="bp-label" text={vm.label} />;
  switch (vm.visual) {
    case 'ready':
    case 'arming':
      return (
        <>
          {label}
          {vm.doubleWait && <Line class="bp-pill bp-again" text="TAP AGAIN" extraEm={1.9} trackEm={0.07} />}
          <Hints vm={vm} />
        </>
      );
    case 'confirm':
      return (
        <>
          {label}
          <Fit class="bp-head" text={`${vm.confirmVerb ?? verbOf(vm.trigger)} AGAIN TO CONFIRM`} />
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
      const pill = vm.cancelling ? 'CANCELLING…' : vm.queued ? '+1 QUEUED' : vm.cancelHint ? `${verbOf(vm.trigger)} TO CANCEL` : null;
      return (
        <>
          {label}
          <Line class="bp-num" text={det ? `${Math.round(vm.progress!)}%` : elapsed} under={vm.label || undefined} />
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
          {vm.nextQueued ? <NextQueued /> : vm.elapsedMs !== undefined && <div class="bp-time">{fmtElapsed(vm.elapsedMs)}</div>}
        </>
      );
    case 'failure':
    case 'stopped':
    case 'unknown':
    case 'interrupted': {
      const G = GLYPH[vm.visual]!;
      return (
        <>
          {label}
          <G class="bp-icon" />
          {vm.title && <Fit class="bp-headline" text={vm.title} lines={2} />}
          {vm.detail && <Sub class="bp-detail" text={vm.detail} />}
          {vm.nextQueued ? <NextQueued /> : vm.sticky && <div class="bp-sticky">{`${verbOf(vm.trigger)} TO RETRY`}</div>}
        </>
      );
    }
    case 'offline': {
      // What the host was last seen doing (its look stays underneath, dimmed and still).
      const u = vm.under;
      const was =
        u === 'running'
          ? `LAST SEEN RUNNING${vm.progress !== undefined ? ` · ${Math.round(vm.progress)}%` : vm.seenElapsed !== undefined ? ` · ${fmtElapsed(vm.seenElapsed)}` : ''}`
          : u === 'success'
            ? 'LAST RUN OK'
            : isResult(u)
              ? `LAST RUN: ${vm.code ?? vm.title ?? 'FAILED'}`
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

const NextQueued = () => <div class="bp-next">NEXT RUN QUEUED</div>;

const Dots = () => (
  <div class="bp-dots" aria-hidden="true">
    <i />
    <i />
    <i />
  </div>
);

/** Flash badges: [big word, smaller second line]. */
function badgeOf(kind: FlashKind, vm: ButtonVM): [string, string?] | undefined {
  switch (kind) {
    case 'busy':
    case 'cooldown':
      return ['BUSY'];
    case 'later':
      return ['BUSY', 'TRY AGAIN'];
    case 'already':
      return ['ALREADY', 'RUNNING'];
    case 'queued':
      return ['ALREADY', 'QUEUED'];
    case 'unknown':
      return ['NOT ON HOST'];
    case 'slipped':
      return ['SLIPPED', `${verbOf(vm.trigger)} AGAIN`];
    case 'denied':
      return undefined;
  }
}
const SHAKES: FlashKind[] = ['busy', 'later', 'denied', 'already'];
/** As big as the button allows: the word (plus padding) fits 88% of the width. */
const badgeSize = (word: string) => `clamp(12px, min(17cqh, calc(88cqw / ${((lineWidths(word)[0] ?? 3) + 1.1 + 0.04 * word.length).toFixed(3)})), 110px)`;

/** Forced-colors mode paints every face the same: the state goes in words too. */
const FC_WORD: Partial<Record<Visual, string>> = {
  confirm: 'CONFIRM?',
  sending: 'SENDING',
  running: 'RUNNING',
  success: 'DONE',
  failure: 'FAILED',
  stopped: 'STOPPED',
  unknown: 'UNKNOWN',
  interrupted: 'INTERRUPTED',
  offline: 'OFFLINE',
};

export function ButtonFace({ vm, now, class: cls, style, onDismiss, ...rest }: FaceProps) {
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
    a.currentTime = Math.min(vm.arming.ms, Math.max(0, wall() - vm.arming.at));
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
    if (!vm.firedAt || wall() - vm.firedAt > 400) return;
    move(face.current, POP, { duration: 320, easing: 'cubic-bezier(.2,.8,.3,1)' });
    flash.current?.animate([{ opacity: 0.65 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
    const el = arm.current;
    if (el && armAnim.current) {
      armAnim.current.cancel();
      armAnim.current = el.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(0)', opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
    }
  }, [vm.firedAt]);

  // BUSY / pressed while offline / someone else's run: shake.
  useLayoutEffect(() => {
    if (vm.flash && SHAKES.includes(vm.flash.kind)) move(face.current, SHAKE, { duration: 420, easing: 'ease-out' });
  }, [vm.flash?.at]);

  // Countdown bars: start where the host (or the confirm window) says they started.
  const drain = useMemo(() => {
    if (isResult(v) && vm.endedAt !== undefined && vm.resultHoldMs) return { kind: 'result', duration: vm.resultHoldMs, delay: Math.min(0, vm.endedAt - wall()) };
    if (v === 'confirm' && vm.confirmUntil && vm.confirmMs) return { kind: 'confirm', duration: vm.confirmMs, delay: Math.min(0, vm.confirmUntil - vm.confirmMs - wall()) };
    return null;
  }, [v, vm.endedAt, vm.confirmUntil, vm.resultHoldMs]);

  const ink = inkFor(vm.color);
  // Offline: the last-known state's layers stay, under the OFFLINE look.
  const u = v === 'offline' ? vm.under : v;
  const badge = vm.flash ? badgeOf(vm.flash.kind, vm) : undefined;
  const top = !!(vm.latched || vm.last || vm.other || (vm.sticky && onDismiss));
  return (
    <div
      class={`bp-btn${cls ? ` ${cls}` : ''}${top ? ' has-top' : ''}`}
      data-visual={v}
      data-under={v === 'offline' ? vm.under : undefined}
      data-testid={`btn-${vm.id}`}
      data-flash={vm.flash?.kind}
      data-sticky={vm.sticky ? '' : undefined}
      role="button"
      aria-label={`${vm.label || vm.id}: ${v}${vm.title ? ` (${vm.title})` : ''}${v === 'offline' && vm.under && vm.under !== 'ready' ? ` (last seen ${vm.under})` : ''}${vm.latched ? `, ${vm.latched}` : ''}`}
      style={{ '--bg': vm.color, '--ink': ink, ...style }}
      {...rest}
    >
      <div ref={face} class={`bp-face${vm.pressed ? ' is-pressed' : ''}`}>
        <div class="bp-base" />
        {u === 'running' && <div class={`bp-stripes${vm.progress !== undefined ? ' is-under' : ''}`} />}
        {u === 'running' && vm.progress !== undefined && <div class="bp-prog" style={{ '--p': String(vm.progress / 100) }} />}
        {isResult(v) && <div key={`${v}${vm.endedAt}`} class="bp-flood" />}
        {v === 'offline' && isResult(u) && <div class={`bp-tint is-${u}`} />}
        {(v === 'failure' || v === 'interrupted') && <div class="bp-pulse" />}
        <div ref={arm} class="bp-arm" />
        <div ref={flash} class="bp-flash" />
        {(v === 'confirm' || v === 'offline' || v === 'unknown' || v === 'interrupted') && <div class="bp-frame" />}
        <TopBand vm={vm} onDismiss={onDismiss} />
        <div class="bp-content">
          <Content vm={vm} now={now} />
        </div>
        {FC_WORD[v] && (
          <span class="bp-fc" aria-hidden="true">
            {FC_WORD[v]}
          </span>
        )}
        {vm.doubleWait && (
          <div class="bp-pips" aria-hidden="true">
            <i />
            <i />
          </div>
        )}
        {drain && <div key={`${drain.kind}${vm.endedAt ?? vm.confirmUntil}`} class={`bp-drain bp-drain-${drain.kind}`} style={{ animationDuration: `${drain.duration}ms`, animationDelay: `${drain.delay}ms` }} />}
        {vm.flash && badge && (
          <div key={vm.flash.at} class={`bp-badge${isResult(v) ? ' is-small' : ''}`} style={{ fontSize: isResult(v) ? undefined : badgeSize(badge[0]), animationDuration: `${vm.flash.ms ?? 1200}ms` }}>
            {badge[0]}
            {badge[1] && <small>{badge[1]}</small>}
          </div>
        )}
      </div>
    </div>
  );
}
