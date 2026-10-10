/** Host state + client-local state → one visual state and the bits needed to draw it. */
import type { RunState } from '../../core/machine.ts';
import type { WireButton } from '../../core/protocol.ts';
import { CANCEL_GRACE_MS, type ConnStatus } from '../backend/types.ts';
import type { FlashKind, Local } from './controller.ts';

export type Visual = 'ready' | 'arming' | 'confirm' | 'sending' | 'running' | 'success' | 'failure' | 'offline';

export interface ButtonVM {
  id: string;
  label: string;
  color: string;
  visual: Visual;
  trigger: WireButton['trigger'];
  holdMs: number;
  confirm: boolean;
  keyHint?: string;
  /** Fill rising (hold in progress), possibly over RUNNING/SUCCESS/FAILURE. */
  arming: { at: number; ms: number } | null;
  disarmAt: number;
  firedAt: number;
  pressed: boolean;
  doubleWait: boolean;
  flash: { kind: FlashKind; at: number } | null;
  /** A press is in flight while the host shows RUNNING (cancel/queue presses). */
  sendingOverlay: boolean;
  /** Local ms timestamps. */
  startedAt?: number;
  endedAt?: number;
  progress?: number;
  status?: string;
  cancelHint?: boolean;
  cancelling?: boolean;
  queued?: boolean;
  title?: string;
  text?: string;
  resultHoldMs?: number;
  confirmUntil?: number;
  confirmMs?: number;
  /** OFFLINE: what the host was last seen doing (ready, running, success, failure), shown underneath. */
  under?: Visual;
}

export const READY: RunState = { phase: 'ready', runId: 0 };

const KEY_NAMES: Record<string, string> = { ' ': 'SPACE', Enter: '↵', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PG↑', PageDown: 'PG↓', Escape: 'ESC', Backspace: '⌫', Tab: 'TAB' };
export const keyName = (k: string) => KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k.toUpperCase().slice(0, 6));

function failureTitle(s: Extract<RunState, { phase: 'failure' }>): string {
  if (s.reason === 'timeout') return 'TIMEOUT';
  if (s.reason === 'cancelled') return 'CANCELLED';
  if (s.reason === 'spawn') return "CAN'T START";
  return s.exitCode === null ? 'KILLED' : `EXIT ${s.exitCode}`;
}

/** What the host says, as a visual (no client-local states). */
function hostView(b: WireButton, host: RunState, skew: number, now: number): Partial<ButtonVM> & { visual: Visual } {
  if (host.phase === 'running')
    return {
      visual: 'running',
      startedAt: host.startedAt + skew,
      progress: host.progress,
      status: host.status,
      // The host ignores a cancel this soon after the start (it would be a double press): don't offer one yet.
      cancelHint: b.whileRunning === 'cancel' && !host.cancelling && now - (host.startedAt + skew) >= CANCEL_GRACE_MS,
      cancelling: host.cancelling,
      queued: host.queued,
    };
  if (host.phase === 'success' || host.phase === 'failure')
    return {
      visual: host.phase,
      startedAt: host.startedAt + skew,
      endedAt: host.endedAt + skew,
      title: host.phase === 'failure' ? failureTitle(host) : undefined,
      text: host.text,
      resultHoldMs: b.resultHoldMs,
    };
  return { visual: 'ready' };
}

export function viewOf(b: WireButton, host: RunState, l: Local, link: ConnStatus, skew: number, now: number): ButtonVM {
  const vm: ButtonVM = {
    id: b.id,
    label: b.label,
    color: b.color,
    visual: 'ready',
    trigger: b.trigger,
    holdMs: b.holdMs,
    confirm: b.confirm,
    keyHint: b.key ? keyName(b.key) : undefined,
    arming: l.input === 'arming' ? { at: l.armAt, ms: l.armMs } : null,
    disarmAt: l.disarmAt,
    firedAt: l.firedAt,
    pressed: l.input === 'pressed',
    doubleWait: l.input === 'double',
    flash: l.flash,
    sendingOverlay: false,
  };
  const fromHost = hostView(b, host, skew, now);
  // While first connecting the grid is just dimmed (no grey flash on every page load).
  if (link === 'offline' || link === 'unauthorized') {
    // What the host was last seen doing stays visible under the OFFLINE look. A result runs out
    // when it would have; a run can only be shown as last seen.
    const over = (fromHost.visual === 'success' || fromHost.visual === 'failure') && now > (fromHost.endedAt ?? 0) + b.resultHoldMs;
    const under = over ? { visual: 'ready' as const } : fromHost;
    return { ...vm, ...under, cancelHint: false, visual: 'offline', under: under.visual, arming: null };
  }
  const running = fromHost.visual === 'running';
  if (l.sending && !running) {
    vm.visual = 'sending';
    return vm;
  }
  if (l.noResponse && host.runId <= l.noResponse.baseRunId && !running) {
    return { ...vm, visual: 'failure', title: 'NO RESPONSE', text: 'The host didn’t answer in 2 s', startedAt: l.noResponse.at, endedAt: l.noResponse.at, resultHoldMs: l.noResponse.until - l.noResponse.at };
  }
  if (running) return { ...vm, ...fromHost, sendingOverlay: !!l.sending };
  if (l.confirmUntil > now) return { ...vm, visual: 'confirm', confirmUntil: l.confirmUntil, confirmMs: b.confirmWindowMs };
  if (fromHost.visual !== 'ready') return { ...vm, ...fromHost };
  if (vm.arming) vm.visual = 'arming';
  return vm;
}

/** Re-render cadence a VM needs (0 = none): running clocks, the cancel hint's grace, offline results running out. */
export function tickFor(vm: ButtonVM, now: number): number {
  const under = vm.visual === 'offline' ? vm.under : vm.visual;
  if (vm.visual === 'offline' && (under === 'success' || under === 'failure')) return 500;
  if (under !== 'running' || vm.startedAt === undefined) return 0;
  return now - vm.startedAt < 10_000 ? 100 : 500;
}
