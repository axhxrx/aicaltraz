/**
 * The authoritative per-button state machine. Pure: (state, event) -> (state, effects). The host
 * (server) performs the effects (spawn, kill, timers) and feeds the results back in as events.
 *
 *   READY --press--> RUNNING --exit 0--> SUCCESS --resultHoldMs--> READY
 *                       |   --exit≠0 / timeout / spawn error / cancelled--> FAILURE --> READY
 *                       +--press: ignore | cancel (kill) | queue (run again on exit)
 *
 * A queued re-run starts REQUEUE_GAP_MS after the previous run's result is shown, so nobody
 * misses a failure. READY carries the last result (`last`) so it survives reconnects.
 *
 * Client-only states (ARMING during a hold, CONFIRM between presses, OFFLINE) never reach here.
 */

/** `interrupted`: the host stopped (or crashed) while it was running. */
export type FailureReason = 'exit' | 'timeout' | 'spawn' | 'cancelled' | 'interrupted';

/** How a button's previous run ended, kept on READY. */
export interface LastResult {
  runId: number;
  ok: boolean;
  reason?: FailureReason;
  text?: string;
  endedAt: number;
}

/** How long a finished run's result shows before a queued re-run starts. */
export const REQUEUE_GAP_MS = 800;

export type RunState =
  | { phase: 'ready'; runId: number; last?: LastResult }
  | {
      phase: 'running';
      runId: number;
      startedAt: number;
      /** 0..100 when the script reports `@progress N`; absent = indeterminate. */
      progress?: number;
      /** Latest `@status ...` line. */
      status?: string;
      cancelling?: boolean;
      queued?: boolean;
    }
  | {
      phase: 'success';
      runId: number;
      startedAt: number;
      endedAt: number;
      text?: string;
      exitCode: number;
      /** A re-run starts in REQUEUE_GAP_MS. */
      queued?: boolean;
    }
  | {
      phase: 'failure';
      runId: number;
      startedAt: number;
      endedAt: number;
      text?: string;
      exitCode: number | null;
      reason: FailureReason;
      queued?: boolean;
    };

export type MachineEvent =
  | { type: 'press'; now: number }
  | { type: 'progress'; runId: number; progress?: number; status?: string }
  | { type: 'exit'; runId: number; now: number; exitCode: number | null; text?: string; reason?: 'timeout' | 'spawn' }
  | { type: 'reset'; runId: number }
  | { type: 'requeue'; runId: number; now: number };

export type Effect =
  | { type: 'start'; runId: number }
  | { type: 'kill'; runId: number }
  | { type: 'scheduleReset'; runId: number; afterMs: number }
  /** Feed back `requeue` after afterMs. */
  | { type: 'scheduleRequeue'; runId: number; afterMs: number };

export interface MachineOpts {
  whileRunning: 'ignore' | 'cancel' | 'queue';
  resultHoldMs: number;
}

export const initialState = (): RunState => ({ phase: 'ready', runId: 0 });

export function transition(s: RunState, e: MachineEvent, o: MachineOpts): [RunState, Effect[]] {
  switch (e.type) {
    case 'press': {
      if (s.phase !== 'running') {
        const runId = s.runId + 1;
        return [{ phase: 'running', runId, startedAt: e.now }, [{ type: 'start', runId }]];
      }
      if (o.whileRunning === 'cancel') {
        // A cancel also drops a queued re-run (queued is possible after a config change from 'queue').
        const { queued: _queued, ...rest } = s;
        if (s.cancelling) return [s.queued ? rest : s, []];
        return [{ ...rest, cancelling: true }, [{ type: 'kill', runId: s.runId }]];
      }
      // Already queued: unchanged (same object), so the host can answer `ignored`.
      if (o.whileRunning === 'queue') return [s.queued ? s : { ...s, queued: true }, []];
      return [s, []];
    }

    case 'progress': {
      if (s.phase !== 'running' || s.runId !== e.runId) return [s, []];
      const next = { ...s };
      if (e.progress !== undefined) next.progress = Math.max(0, Math.min(100, e.progress));
      if (e.status !== undefined) next.status = e.status;
      return [next, []];
    }

    case 'exit': {
      if (s.phase !== 'running' || s.runId !== e.runId) return [s, []];
      // A queue press is the latest intent, so it wins even over a cancel (possible across a config change).
      const base = { runId: s.runId, startedAt: s.startedAt, endedAt: e.now, text: e.text, ...(s.queued ? { queued: true } : {}) };
      const next: Effect = s.queued
        ? { type: 'scheduleRequeue', runId: s.runId, afterMs: REQUEUE_GAP_MS }
        : { type: 'scheduleReset', runId: s.runId, afterMs: o.resultHoldMs };
      if (s.cancelling) return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: 'cancelled' }, [next]];
      if (e.reason) return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: e.reason }, [next]];
      if (e.exitCode === 0) return [{ ...base, phase: 'success', exitCode: 0 }, [next]];
      return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: 'exit' }, [next]];
    }

    case 'reset': {
      if ((s.phase === 'success' || s.phase === 'failure') && s.runId === e.runId && !s.queued)
        return [{ phase: 'ready', runId: s.runId, last: lastResult(s) }, []];
      return [s, []];
    }

    case 'requeue': {
      if ((s.phase === 'success' || s.phase === 'failure') && s.runId === e.runId && s.queued) {
        const runId = s.runId + 1;
        return [{ phase: 'running', runId, startedAt: e.now }, [{ type: 'start', runId }]];
      }
      return [s, []];
    }
  }
}

function lastResult(s: Extract<RunState, { phase: 'success' | 'failure' }>): LastResult {
  const last: LastResult = { runId: s.runId, ok: s.phase === 'success', endedAt: s.endedAt };
  if (s.phase === 'failure') last.reason = s.reason;
  if (s.text !== undefined) last.text = s.text;
  return last;
}
