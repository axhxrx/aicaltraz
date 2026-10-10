import { describe, expect, test } from 'bun:test';
import { initialState, transition, type MachineEvent, type MachineOpts, type RunState } from '../src/core/machine.ts';

const opts = (whileRunning: MachineOpts['whileRunning'] = 'ignore', resultHoldMs = 2500): MachineOpts => ({ whileRunning, resultHoldMs });

const ready: RunState = { phase: 'ready', runId: 3 };
const running: RunState = { phase: 'running', runId: 3, startedAt: 1000 };
const cancelling: RunState = { phase: 'running', runId: 3, startedAt: 1000, cancelling: true };
const queued: RunState = { phase: 'running', runId: 3, startedAt: 1000, queued: true };
const busy: RunState = { phase: 'running', runId: 3, startedAt: 1000, progress: 40, status: 'half way' };
const success: RunState = { phase: 'success', runId: 3, startedAt: 1000, endedAt: 2000, exitCode: 0, text: 'ok' };
const failure: RunState = { phase: 'failure', runId: 3, startedAt: 1000, endedAt: 2000, exitCode: 1, reason: 'exit' };

const phases = { ready, running, cancelling, queued, busy, success, failure };
const modes = ['ignore', 'cancel', 'queue'] as const;

test('initial state is ready with runId 0', () => {
  expect(initialState()).toEqual({ phase: 'ready', runId: 0 });
});

describe('press', () => {
  for (const [name, s] of Object.entries({ ready, success, failure }))
    for (const mode of modes)
      test(`${name} + press (${mode}) starts run runId+1`, () => {
        const [next, effects] = transition(s, { type: 'press', now: 5000 }, opts(mode));
        expect(next).toEqual({ phase: 'running', runId: 4, startedAt: 5000 });
        expect(effects).toEqual([{ type: 'start', runId: 4 }]);
      });

  test('running + press (ignore) changes nothing', () => {
    for (const s of [running, busy, queued, cancelling]) {
      const [next, effects] = transition(s, { type: 'press', now: 5000 }, opts('ignore'));
      expect(next).toBe(s);
      expect(effects).toEqual([]);
    }
  });

  test('running + press (cancel) marks cancelling and kills the current run', () => {
    const [next, effects] = transition(busy, { type: 'press', now: 5000 }, opts('cancel'));
    expect(next).toEqual({ ...busy, cancelling: true });
    expect(effects).toEqual([{ type: 'kill', runId: 3 }]);
  });

  test('cancelling + press (cancel) does not kill twice', () => {
    const [next, effects] = transition(cancelling, { type: 'press', now: 5000 }, opts('cancel'));
    expect(next).toBe(cancelling);
    expect(effects).toEqual([]);
  });

  test('running + press (queue) marks queued without effects, idempotently', () => {
    const [next, effects] = transition(running, { type: 'press', now: 5000 }, opts('queue'));
    expect(next).toEqual({ ...running, queued: true });
    expect(effects).toEqual([]);
    const [again, effects2] = transition(next, { type: 'press', now: 6000 }, opts('queue'));
    expect(again).toEqual({ ...running, queued: true });
    expect(effects2).toEqual([]);
  });
});

describe('progress', () => {
  test('updates progress and status of the current run', () => {
    const [a] = transition(running, { type: 'progress', runId: 3, progress: 42 }, opts());
    expect(a).toEqual({ ...running, progress: 42 });
    const [b] = transition(a, { type: 'progress', runId: 3, status: 'copying' }, opts());
    expect(b).toEqual({ ...running, progress: 42, status: 'copying' });
    const [c, effects] = transition(b, { type: 'progress', runId: 3, progress: 50, status: 'more' }, opts());
    expect(c).toEqual({ ...running, progress: 50, status: 'more' });
    expect(effects).toEqual([]);
  });

  test('clamps progress to 0..100', () => {
    expect(transition(running, { type: 'progress', runId: 3, progress: 150 }, opts())[0]).toMatchObject({ progress: 100 });
    expect(transition(running, { type: 'progress', runId: 3, progress: -5 }, opts())[0]).toMatchObject({ progress: 0 });
  });

  test('keeps cancelling/queued flags', () => {
    expect(transition(cancelling, { type: 'progress', runId: 3, progress: 1 }, opts())[0]).toMatchObject({ cancelling: true, progress: 1 });
    expect(transition(queued, { type: 'progress', runId: 3, status: 's' }, opts())[0]).toMatchObject({ queued: true, status: 's' });
  });

  test('ignores a stale runId and non-running phases', () => {
    for (const s of [running, ...[ready, success, failure]]) {
      const runId = s.phase === 'running' ? 2 : 3;
      const [next, effects] = transition(s, { type: 'progress', runId, progress: 10, status: 'x' }, opts());
      expect(next).toBe(s);
      expect(effects).toEqual([]);
    }
  });
});

describe('exit', () => {
  const exit = (e: Partial<Extract<MachineEvent, { type: 'exit' }>> = {}): MachineEvent => ({ type: 'exit', runId: 3, now: 9000, exitCode: 0, ...e });

  test('exit 0 → success, schedules reset after resultHoldMs', () => {
    const [next, effects] = transition(busy, exit({ text: 'done' }), opts('ignore', 1234));
    expect(next).toEqual({ phase: 'success', runId: 3, startedAt: 1000, endedAt: 9000, exitCode: 0, text: 'done' });
    expect(effects).toEqual([{ type: 'scheduleReset', runId: 3, afterMs: 1234 }]);
  });

  test('non-zero exit → failure "exit"', () => {
    const [next, effects] = transition(running, exit({ exitCode: 2, text: 'boom' }), opts());
    expect(next).toEqual({ phase: 'failure', runId: 3, startedAt: 1000, endedAt: 9000, exitCode: 2, text: 'boom', reason: 'exit' });
    expect(effects).toEqual([{ type: 'scheduleReset', runId: 3, afterMs: 2500 }]);
  });

  test('killed by a signal (exitCode null) → failure "exit"', () => {
    expect(transition(running, exit({ exitCode: null }), opts())[0]).toMatchObject({ phase: 'failure', exitCode: null, reason: 'exit' });
  });

  test('timeout and spawn reasons win over the exit code', () => {
    expect(transition(running, exit({ exitCode: 0, reason: 'timeout' }), opts())[0]).toMatchObject({ phase: 'failure', reason: 'timeout', exitCode: 0 });
    expect(transition(running, exit({ exitCode: null, reason: 'spawn', text: 'command not found: x' }), opts())[0]).toMatchObject({
      phase: 'failure',
      reason: 'spawn',
      text: 'command not found: x',
    });
  });

  test('a cancelled run fails as "cancelled", whatever the exit says', () => {
    for (const e of [exit({ exitCode: 0 }), exit({ exitCode: null }), exit({ exitCode: 1, reason: 'timeout' })])
      expect(transition(cancelling, e, opts('cancel'))[0]).toMatchObject({ phase: 'failure', reason: 'cancelled' });
  });

  test('queued run restarts immediately with runId+1 instead of finishing', () => {
    const [next, effects] = transition({ ...queued, progress: 80, status: 'x' }, exit({ exitCode: 1 }), opts('queue'));
    expect(next).toEqual({ phase: 'running', runId: 4, startedAt: 9000 });
    expect(effects).toEqual([{ type: 'start', runId: 4 }]);
  });

  test('queued wins over cancelling (both can only coexist after a config change)', () => {
    const [next, effects] = transition({ ...running, queued: true, cancelling: true }, exit(), opts('cancel'));
    expect(next).toMatchObject({ phase: 'running', runId: 4 });
    expect(effects).toEqual([{ type: 'start', runId: 4 }]);
  });

  test('ignores a stale runId and non-running phases', () => {
    for (const s of [running, queued, cancelling]) {
      const [next, effects] = transition(s, exit({ runId: 2 }), opts('queue'));
      expect(next).toBe(s);
      expect(effects).toEqual([]);
    }
    for (const s of [ready, success, failure]) {
      const [next, effects] = transition(s, exit(), opts());
      expect(next).toBe(s);
      expect(effects).toEqual([]);
    }
  });
});

describe('reset', () => {
  test('success/failure → ready, keeping runId', () => {
    for (const s of [success, failure]) {
      const [next, effects] = transition(s, { type: 'reset', runId: 3 }, opts());
      expect(next).toEqual({ phase: 'ready', runId: 3 });
      expect(effects).toEqual([]);
    }
  });

  test('stale reset (a newer run started meanwhile) is ignored', () => {
    for (const s of [success, failure]) expect(transition(s, { type: 'reset', runId: 2 }, opts())[0]).toBe(s);
    const [rerun] = transition(success, { type: 'press', now: 1 }, opts());
    expect(transition(rerun, { type: 'reset', runId: 3 }, opts())[0]).toBe(rerun);
  });

  test('ready/running ignore reset', () => {
    for (const s of [ready, running, cancelling, queued]) expect(transition(s, { type: 'reset', runId: 3 }, opts())[0]).toBe(s);
  });
});

test('every event × phase never throws and only emits known effects', () => {
  const events: MachineEvent[] = [
    { type: 'press', now: 1 },
    { type: 'progress', runId: 3, progress: 5 },
    { type: 'progress', runId: 9, status: 'stale' },
    { type: 'exit', runId: 3, now: 2, exitCode: 0 },
    { type: 'exit', runId: 3, now: 2, exitCode: 1, reason: 'timeout' },
    { type: 'exit', runId: 9, now: 2, exitCode: 0 },
    { type: 'reset', runId: 3 },
    { type: 'reset', runId: 9 },
  ];
  for (const s of Object.values(phases))
    for (const e of events)
      for (const mode of modes) {
        const [next, effects] = transition(s, e, opts(mode));
        expect(['ready', 'running', 'success', 'failure']).toContain(next.phase);
        expect(next.runId === s.runId || next.runId === s.runId + 1).toBe(true);
        for (const eff of effects) expect(['start', 'kill', 'scheduleReset']).toContain(eff.type);
      }
});

test('full lifecycle: press → progress → exit → reset → press', () => {
  const o = opts('cancel', 100);
  let s = initialState();
  let effects;
  [s, effects] = transition(s, { type: 'press', now: 10 }, o);
  expect(effects).toEqual([{ type: 'start', runId: 1 }]);
  [s] = transition(s, { type: 'progress', runId: 1, progress: 50, status: 'half' }, o);
  [s, effects] = transition(s, { type: 'press', now: 20 }, o);
  expect(effects).toEqual([{ type: 'kill', runId: 1 }]);
  [s, effects] = transition(s, { type: 'exit', runId: 1, now: 30, exitCode: null }, o);
  expect(s).toEqual({ phase: 'failure', runId: 1, startedAt: 10, endedAt: 30, exitCode: null, reason: 'cancelled', text: undefined });
  expect(effects).toEqual([{ type: 'scheduleReset', runId: 1, afterMs: 100 }]);
  [s] = transition(s, { type: 'reset', runId: 1 }, o);
  expect(s).toEqual({ phase: 'ready', runId: 1 });
  [s, effects] = transition(s, { type: 'press', now: 40 }, o);
  expect(s).toEqual({ phase: 'running', runId: 2, startedAt: 40 });
});
