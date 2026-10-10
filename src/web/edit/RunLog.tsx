/** Recent runs of one button (GET /api/runs): outcome, duration, when, stdout/stderr tails. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { buttonKey } from '../../core/config.ts';
import type { PressResult, RunRecord } from '../../core/protocol.ts';
import type { Backend } from '../backend/types.ts';
import { fmtElapsed } from '../lib/env.ts';
import { useStore } from '../lib/store.ts';
import { Check, Cross } from '../ui/icons.tsx';
import { ChevronDown, Play, Refresh } from './icons.tsx';

function outcome(r: RunRecord): { tone: 'ok' | 'bad' | 'run'; title: string } {
  if (r.endedAt === undefined) return { tone: 'run', title: 'Running…' };
  if (r.reason === 'timeout') return { tone: 'bad', title: 'Timed out' };
  if (r.reason === 'cancelled') return { tone: 'bad', title: 'Cancelled' };
  if (r.reason === 'spawn') return { tone: 'bad', title: "Couldn't start" };
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

/** What the button would have shown: @result, else the last plain stdout line, else stderr on failure. */
function resultText(r: RunRecord, failed: boolean): string | undefined {
  const out = r.stdout.split('\n');
  const res = out.findLast((l) => l.startsWith('@result'))?.replace(/^@result\s*/, '');
  if (res !== undefined) return res;
  const last = out.findLast((l) => l.trim() && !l.startsWith('@'));
  if (last !== undefined) return last;
  return failed ? r.stderr.split('\n').findLast((l) => l.trim()) : undefined;
}

const PRESS_NOTE: Partial<Record<PressResult, string>> = {
  ignored: 'Already running: that press was ignored.',
  'unknown-button': "The host doesn't know this button yet. Save first.",
  queued: 'Queued: it runs again when the current run ends.',
  cancelling: 'That press cancelled the current run.',
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
          <span title={new Date(start).toLocaleString()}>{ago(Date.now() - start)}</span>
        </span>
        <ChevronDown class="ed-run-chev" />
      </button>
      {open && (
        <div class="ed-run-body">
          <div class="ed-run-when">
            Run #{r.runId} · started {clock(start)}
            {r.endedAt !== undefined && ` · ended ${clock(r.endedAt + skew)}`}
          </div>
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

export function RunLog(p: { backend: Backend; padId: string; buttonId: string; onHost: boolean; changed: boolean }) {
  const key = buttonKey(p.padId, p.buttonId);
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
      const list = await p.backend.runs({ pad: p.padId, button: p.buttonId });
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
  // Refetch whenever this button starts or finishes a run (from any device).
  useEffect(() => {
    if (p.onHost) void load();
  }, [key, p.onHost, st?.phase, st?.runId]);

  const run = async () => {
    setPressing(true);
    setNote(null);
    try {
      const r = await p.backend.press(p.padId, p.buttonId);
      setNote(PRESS_NOTE[r] ?? null);
      setOpen(null);
    } catch (e) {
      setNote(`Couldn't reach the host: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPressing(false);
    }
  };

  const shown = open ?? runs?.[0]?.runId ?? null;
  const running = st?.phase === 'running';
  return (
    <div class="ed-runs" data-testid="run-log">
      <div class="ed-runs-bar">
        <button type="button" class="ed-btn is-primary" data-testid="run-test" disabled={!p.onHost || pressing} onClick={run}>
          <Play /> {running ? 'Press now' : 'Run now'}
        </button>
        <button type="button" class="ed-btn" data-testid="run-refresh" disabled={!p.onHost} onClick={() => void load()}>
          <Refresh /> Refresh
        </button>
      </div>
      <p class="ed-hint">
        {!p.onHost
          ? `The host has no button “${p.padId}/${p.buttonId}” yet: save first (a new or renamed button starts a fresh history).`
          : p.changed
            ? 'Run now uses the saved version on the host, not your unsaved changes.'
            : 'Run now runs the action on the host right away (no hold or confirm).'}
      </p>
      {note && <div class="ed-callout">{note}</div>}
      {err && (
        <div class="ed-callout is-bad" role="alert">
          Couldn't load runs: {err}
        </div>
      )}
      {p.onHost && runs && runs.length === 0 && <div class="ed-runs-empty">No runs yet. Press the button (or Run now) and its output shows up here.</div>}
      {p.onHost && runs && runs.length > 0 && (
        <ol class="ed-run-list">
          {runs.map((r) => (
            <Run key={r.runId} r={r} skew={skew} open={shown === r.runId} onToggle={() => setOpen(shown === r.runId ? -1 : r.runId)} />
          ))}
        </ol>
      )}
      {p.onHost && runs && runs.length > 0 && <p class="ed-hint">The host keeps the last 20 runs per button, with the last 16 KB of each output.</p>}
    </div>
  );
}
