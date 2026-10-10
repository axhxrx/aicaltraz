/**
 * Recent runs of one button (GET /api/runs): outcome, duration, when, what ran (command, folder),
 * why it couldn't start, stdout/stderr tails. Refreshes on its own while the button runs.
 *
 * "Run now" presses the button on the host. A `confirm` button asks here first (the host refuses
 * an unconfirmed press of one: `needs-confirm`), and while it runs the press is never a silent
 * cancel: it's "Cancel run" when that's what a press does (`whileRunning: cancel`), else disabled.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { buttonKey, type Button } from '../../core/config.ts';
import type { PressResult, RunRecord } from '../../core/protocol.ts';
import type { Backend } from '../backend/types.ts';
import { wall } from '../lib/clock.ts';
import { fmtElapsed } from '../lib/env.ts';
import { useStore } from '../lib/store.ts';
import { Check, Close, Cross } from '../ui/icons.tsx';
import { ChevronDown, Play, Refresh } from './icons.tsx';
import { nameOf } from './ops.ts';

/** While the button runs, the list is fetched again this often (its output grows). */
const LIVE_MS = 1000;

function outcome(r: RunRecord): { tone: 'ok' | 'bad' | 'run'; title: string } {
  if (r.endedAt === undefined) return { tone: 'run', title: 'Running…' };
  if (r.reason === 'timeout') return { tone: 'bad', title: 'Timed out' };
  if (r.reason === 'cancelled') return { tone: 'bad', title: r.error ? 'Stopped' : 'Cancelled' };
  if (r.reason === 'spawn') return { tone: 'bad', title: "Couldn't start" };
  if (r.reason === 'interrupted') return { tone: 'bad', title: 'Interrupted (the host stopped)' };
  if (r.exitCode === 0) return { tone: 'ok', title: 'OK · exit 0' };
  return { tone: 'bad', title: r.exitCode == null ? 'Killed' : `Exit ${r.exitCode}` };
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What the button would have shown: @result, else the last plain stdout line, else stderr (or why it couldn't start) on failure. */
function resultText(r: RunRecord, failed: boolean): string | undefined {
  if (r.reason === 'spawn' && r.error) return r.error;
  const out = r.stdout.split('\n');
  const res = out.findLast((l) => l.startsWith('@result'))?.replace(/^@result\s*/, '');
  if (res !== undefined) return res;
  const last = out.findLast((l) => l.trim() && !l.startsWith('@'));
  if (last !== undefined) return last;
  return failed ? (r.stderr.split('\n').findLast((l) => l.trim()) ?? r.error) : undefined;
}

const PRESS_NOTE: Partial<Record<PressResult, string>> = {
  ignored: 'The host ignored that press (already running, or pressed again too soon).',
  'unknown-button': "The host doesn't know this button yet. Save first.",
  queued: 'Queued: it runs again when the current run ends.',
  cancelling: 'Cancelling the run…',
  expired: 'That press got to the host too late (a slow link), so it was dropped. Try again.',
  'needs-confirm': "The host wants this press confirmed, and it wasn't: nothing ran.",
};

function Run({ r, skew, open, onToggle }: { r: RunRecord; skew: number; open: boolean; onToggle(): void }) {
  const o = outcome(r);
  const start = r.startedAt + skew;
  const dur = r.endedAt !== undefined ? fmtElapsed(r.endedAt - r.startedAt) : null;
  const text = resultText(r, o.tone === 'bad');
  return (
    <li class={`ed-run is-${o.tone}${open ? ' is-open' : ''}`} data-testid="run-item">
      <button type="button" class="ed-run-head" aria-expanded={open} onClick={onToggle}>
        <span class="ed-run-icon">{o.tone === 'ok' ? <Check /> : o.tone === 'bad' ? <Cross /> : <i class="ed-run-spin" />}</span>
        <span class="ed-run-main">
          <span class="ed-run-title">{o.title}</span>
          {text && <span class="ed-run-text">{text}</span>}
        </span>
        <span class="ed-run-meta">
          {dur && <span>{dur}</span>}
          <span title={new Date(start).toLocaleString()}>{ago(wall() - start)}</span>
        </span>
        <ChevronDown class="ed-run-chev" />
      </button>
      {open && (
        <div class="ed-run-body">
          <div class="ed-run-when">
            Run #{r.runId} · started {clock(start)}
            {r.endedAt !== undefined && ` · ended ${clock(r.endedAt + skew)}`}
          </div>
          {r.error && (
            <div class="ed-out">
              <div class="ed-out-name">{r.reason === 'spawn' ? "Why it couldn't start" : 'Why it stopped'}</div>
              <pre class="ed-pre is-err" data-testid="run-error" data-selectable>
                {r.error}
              </pre>
            </div>
          )}
          {r.command !== undefined && (
            <div class="ed-out">
              <div class="ed-out-name">Ran</div>
              <pre class="ed-pre" data-testid="run-command" data-selectable>
                {r.command}
              </pre>
            </div>
          )}
          {r.cwd !== undefined && (
            <div class="ed-out">
              <div class="ed-out-name">In folder</div>
              <pre class="ed-pre" data-testid="run-cwd" data-selectable>
                {r.cwd}
              </pre>
            </div>
          )}
          <Out name="stdout" text={r.stdout} />
          <Out name="stderr" text={r.stderr} bad />
        </div>
      )}
    </li>
  );
}

function Out({ name, text, bad }: { name: string; text: string; bad?: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  // Tails: the interesting part is the end.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);
  return (
    <div class="ed-out">
      <div class="ed-out-name">{name}</div>
      {text.trim() ? (
        <pre ref={pre} class={`ed-pre${bad ? ' is-err' : ''}`} data-testid={`run-${name}`} data-selectable data-scroll>
          {text.replace(/\n$/, '')}
        </pre>
      ) : (
        <div class="ed-out-none">(nothing)</div>
      )}
    </div>
  );
}

/** "Run it for real?" for a `confirm` button: the editor shows it (a dialog over everything). */
export interface RunAsk {
  title: string;
  body: string;
  yes: string;
  go(): void;
}

/**
 * `button`: the draft's version. `hostButton`: the host's (same pad/button id), if it has one.
 * `changed`: the draft's differs from it (or it's new): then "Run now" would run something else
 * than what's on screen (the host's version, maybe a deleted button whose id this one reuses), so
 * it's "Save & run" instead.
 */
export function RunLog(p: {
  backend: Backend;
  padId: string;
  button: Button;
  hostButton: Button | undefined;
  changed: boolean;
  saving: boolean;
  onSaveAndRun(run: () => void): void;
  onAsk(q: RunAsk): void;
}) {
  const buttonId = p.button.id;
  const key = buttonKey(p.padId, buttonId);
  const onHost = !!p.hostButton;
  const st = useStore(p.backend.snapshot, (s) => s.states[key]);
  const skew = useStore(p.backend.snapshot, (s) => s.clockSkew);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const seq = useRef(0);

  const load = async () => {
    const n = ++seq.current;
    try {
      const list = await p.backend.runs({ pad: p.padId, button: buttonId });
      if (n !== seq.current) return;
      setRuns(list);
      setErr(null);
    } catch (e) {
      if (n === seq.current) setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    setRuns(null);
    setOpen(null);
    setNote(null);
  }, [key]);
  const running = st?.phase === 'running';
  // Refetch whenever this button starts or finishes a run (from any device), and while it runs.
  useEffect(() => {
    if (onHost) void load();
  }, [key, onHost, st?.phase, st?.runId]);
  useEffect(() => {
    if (!onHost || !running) return;
    const t = setInterval(() => void load(), LIVE_MS);
    return () => clearInterval(t);
  }, [key, onHost, running]);

  /** Press it on the host. `confirm`: the user said yes to a `confirm` button (here, in the editor). */
  const press = async (confirm: boolean) => {
    setPressing(true);
    setNote(null);
    try {
      const r = await p.backend.press(p.padId, buttonId, { confirm });
      setNote(PRESS_NOTE[r] ?? null);
      if (r === 'started') setOpen(null);
    } catch (e) {
      setNote(`Couldn't reach the host: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPressing(false);
    }
  };

  const shown = open ?? runs?.[0]?.runId ?? null;
  const saved = onHost && !p.changed;
  const host = p.hostButton;
  /** What a press does now, by the host's version: while it runs, only a `cancel` button does something deliberate. */
  const canCancel = running && host?.whileRunning === 'cancel';
  const cancelling = running && !!st.cancelling;
  const stops = !!p.button.stops?.length;
  /** A `confirm` button: Run now / Save & run ask first, then the press says it was confirmed. */
  const ask = (what: 'run' | 'save') =>
    p.onAsk({
      title: what === 'run' ? `Run ${nameOf(p.button)} now?` : `Save, then run ${nameOf(p.button)}?`,
      body: `This button asks for a second press before it runs: it's for something that's hard to take back. ${what === 'run' ? 'Run now' : 'Save & run'} runs it on the host for real${stops ? ', and stops what it is set to stop' : ''}.`,
      yes: what === 'run' ? 'Run it' : 'Save & run it',
      go: () => (what === 'run' ? void press(true) : p.onSaveAndRun(() => void press(true))),
    });

  let primary;
  if (running)
    primary = canCancel ? (
      <button type="button" class="ed-btn is-danger" data-testid="run-cancel" disabled={pressing || cancelling} onClick={() => void press(false)}>
        <Close /> {cancelling ? 'Cancelling…' : 'Cancel run'}
      </button>
    ) : (
      <button type="button" class="ed-btn is-primary" data-testid={saved ? 'run-test' : 'run-save'} disabled>
        <Play /> Running…
      </button>
    );
  else if (saved)
    primary = (
      <button type="button" class="ed-btn is-primary" data-testid="run-test" disabled={pressing} onClick={() => (host?.confirm ? ask('run') : void press(false))}>
        <Play /> Run now
      </button>
    );
  else
    primary = (
      <button
        type="button"
        class="ed-btn is-primary"
        data-testid="run-save"
        disabled={pressing || p.saving}
        onClick={() => (p.button.confirm ? ask('save') : p.onSaveAndRun(() => void press(false)))}
      >
        <Play /> {p.saving ? 'Saving…' : 'Save & run'}
      </button>
    );

  return (
    <div class="ed-runs" data-testid="run-log" data-running={running ? '' : undefined}>
      <div class="ed-runs-bar">
        {primary}
        <button type="button" class="ed-btn" data-testid="run-refresh" disabled={!onHost} onClick={() => void load()}>
          <Refresh /> Refresh
        </button>
      </div>
      <p class="ed-hint" data-testid="run-hint">
        {running
          ? canCancel
            ? 'Running now. Cancel run stops it (a press of this button does the same).'
            : `Running now: ${host?.whileRunning === 'queue' ? 'a press would queue another run' : 'a press would be ignored'}. Runs again once it's done.`
          : !onHost
            ? `The host has no button “${p.padId}/${buttonId}” yet: save first. Save & run does both: it saves your draft, then runs this button (a new or renamed button starts a fresh history).`
            : p.changed
              ? 'Unsaved changes: save first, or Run now would run the old version on the host. Save & run saves your draft (all of it), then runs the saved version.'
              : `Run now runs it on the host right away (no hold)${host?.confirm ? ', after you confirm' : ''}${stops ? ', and stops what it is set to stop' : ''}.`}
      </p>
      {note && (
        <div class="ed-callout" data-testid="run-note">
          {note}
        </div>
      )}
      {err && (
        <div class="ed-callout is-bad" role="alert">
          Couldn't load runs: {err}
        </div>
      )}
      {onHost && runs && runs.length === 0 && <div class="ed-runs-empty">No runs yet. Press the button (or {saved ? 'Run now' : 'Save & run'}) and its output shows up here.</div>}
      {onHost && runs && runs.length > 0 && (
        <ol class="ed-run-list">
          {runs.map((r) => (
            <Run key={r.runId} r={r} skew={skew} open={shown === r.runId} onToggle={() => setOpen(shown === r.runId ? -1 : r.runId)} />
          ))}
        </ol>
      )}
      {onHost && runs && runs.length > 0 && <p class="ed-hint">The host keeps the last 20 runs per button, with the last 16 KB of each output.</p>}
    </div>
  );
}
