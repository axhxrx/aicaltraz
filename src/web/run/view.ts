/** Host state + client-local state → one visual state and the bits needed to draw it. */
import type { RunState } from '../../core/machine.ts';
import type { WireButton } from '../../core/protocol.ts';
import type { ConnStatus } from '../backend/types.ts';
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
  // While first connecting the grid is just dimmed (no grey flash on every page load).
  if (link === 'offline' || link === 'unauthorized') {
    vm.visual = 'offline';
    vm.arming = null;
    return vm;
  }
  const running = host.phase === 'running';
  if (l.sending && !running) {
    vm.visual = 'sending';
    return vm;
  }
  if (l.noResponse && host.runId <= l.noResponse.baseRunId && !running) {
    return { ...vm, visual: 'failure', title: 'NO RESPONSE', text: 'The host didn’t answer in 2 s', startedAt: l.noResponse.at, endedAt: l.noResponse.at, resultHoldMs: l.noResponse.until - l.noResponse.at };
  }
  if (host.phase === 'running') {
    return {
      ...vm,
      visual: 'running',
      sendingOverlay: !!l.sending,
      startedAt: host.startedAt + skew,
      progress: host.progress,
      status: host.status,
      cancelHint: b.whileRunning === 'cancel' && !host.cancelling,
      cancelling: host.cancelling,
      queued: host.queued,
    };
  }
  if (l.confirmUntil > now) return { ...vm, visual: 'confirm', confirmUntil: l.confirmUntil, confirmMs: b.confirmWindowMs };
  if (host.phase === 'success' || host.phase === 'failure') {
    return {
      ...vm,
      visual: host.phase,
      startedAt: host.startedAt + skew,
      endedAt: host.endedAt + skew,
      title: host.phase === 'failure' ? failureTitle(host) : undefined,
      text: host.text,
      resultHoldMs: b.resultHoldMs,
    };
  }
  if (vm.arming) vm.visual = 'arming';
  return vm;
}

/** Re-render cadence a VM needs for its clock (0 = none). */
export function tickFor(vm: ButtonVM, now: number): number {
  if (vm.visual !== 'running' || vm.startedAt === undefined) return 0;
  return now - vm.startedAt < 10_000 ? 100 : 500;
}
