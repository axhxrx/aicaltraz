/**
 * The authoritative per-button state machine. Pure: (state, event) -> (state, effects). The host
 * (server) performs the effects (spawn, kill, timers) and feeds the results back in as events.
 *
 *   READY --press--> RUNNING --exit 0--> SUCCESS --resultHoldMs--> READY
 *                       |   --exit≠0 / timeout / spawn error / cancelled--> FAILURE --> READY
 *                       +--press: ignore | cancel (kill) | queue (run again on exit)
 *
 * Client-only states (ARMING during a hold, CONFIRM between presses, OFFLINE) never reach here.
 */

export type FailureReason = 'exit' | 'timeout' | 'spawn' | 'cancelled';

export type RunState =
  | { phase: 'ready'; runId: number }
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
  | { phase: 'success'; runId: number; startedAt: number; endedAt: number; text?: string; exitCode: number }
  | {
      phase: 'failure';
      runId: number;
      startedAt: number;
      endedAt: number;
      text?: string;
      exitCode: number | null;
      reason: FailureReason;
    };

export type MachineEvent =
  | { type: 'press'; now: number }
  | { type: 'progress'; runId: number; progress?: number; status?: string }
  | { type: 'exit'; runId: number; now: number; exitCode: number | null; text?: string; reason?: 'timeout' | 'spawn' }
  | { type: 'reset'; runId: number };

export type Effect =
  | { type: 'start'; runId: number }
  | { type: 'kill'; runId: number }
  | { type: 'scheduleReset'; runId: number; afterMs: number };

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
      if (o.whileRunning === 'queue') return [{ ...s, queued: true }, []];
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
      if (s.queued) {
        const runId = s.runId + 1;
        return [{ phase: 'running', runId, startedAt: e.now }, [{ type: 'start', runId }]];
      }
      const base = { runId: s.runId, startedAt: s.startedAt, endedAt: e.now, text: e.text };
      const reset: Effect = { type: 'scheduleReset', runId: s.runId, afterMs: o.resultHoldMs };
      if (s.cancelling) return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: 'cancelled' }, [reset]];
      if (e.reason) return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: e.reason }, [reset]];
      if (e.exitCode === 0) return [{ ...base, phase: 'success', exitCode: 0 }, [reset]];
      return [{ ...base, phase: 'failure', exitCode: e.exitCode, reason: 'exit' }, [reset]];
    }

    case 'reset': {
      if ((s.phase === 'success' || s.phase === 'failure') && s.runId === e.runId) return [{ phase: 'ready', runId: s.runId }, []];
      return [s, []];
    }
  }
}
