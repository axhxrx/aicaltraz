/** The button editor: look, press behavior, action (and what it stops), and its recent runs. */
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { Action, Button, Pad } from '../../core/config.ts';
import type { Backend } from '../backend/types.ts';
import { toRGB } from '../lib/color.ts';
import { matchKey } from '../run/RunPad.tsx';
import { Close, DoubleTap, Hold, Tap } from '../ui/icons.tsx';
import type { Editor } from './editor.ts';
import { ColorPicker, EnvEditor, Field, KeyCapture, ListEditor, NumberInput, Section, Segmented, SwitchRow, TextArea, TextInput } from './fields.tsx';
import { Copy, Trash } from './icons.tsx';
import { isPlaceholder, nameOf, stateLookalike } from './ops.ts';
import { fieldName } from './problems.ts';
import { RunLog, type RunAsk } from './RunLog.tsx';
import { StopsEditor } from './StopsEditor.tsx';

export type Tab = 'button' | 'action' | 'runs';

/** "400 ms", "2.5 s", "1.5 min", "2 h". */
export const secs = (ms: number) =>
  ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : ms >= 1000 || ms === 0 ? `${+(ms / 1000).toFixed(1)} s` : `${ms} ms`;

/** The schema's bounds (core/config.ts), for hints and arrow keys. */
const RANGE = {
  holdMs: [100, 5000],
  confirmWindowMs: [500, 60_000],
  cooldownMs: [0, 10_000],
  timeoutMs: [100, 86_400_000],
  resultHoldMs: [0, 60_000],
} as const;

const TRIGGER_NOTE: Record<Button['trigger'], string> = {
  hold: 'Fires after holding for the hold time. Safest against bumps and pockets.',
  tap: 'Fires on release, unless the finger slid away.',
  double: 'Two taps within 0.4 s.',
};

const WHILE_NOTE: Record<Button['whileRunning'], string> = {
  ignore: 'Presses do nothing until it finishes (the button flashes BUSY).',
  cancel: 'A press stops it (the whole process tree is killed).',
  queue: 'A press runs it once more after the current run.',
};

const LOOKALIKE: Record<'success' | 'failure', string> = {
  failure: 'Reads like the red of ✗ FAILURE: on this button a failure is easy to miss, and READY looks like something failed. Another color is safer.',
  success: 'Reads like the green of ✓ SUCCESS: on this button a success is easy to miss, and READY looks like something just worked. Another color is safer.',
};

export interface PanelChrome {
  /** Phone bottom sheet: grab handle toggles half/full height. */
  sheet: { full: boolean; onToggle(): void } | null;
}

export function SheetGrab({ sheet }: PanelChrome) {
  if (!sheet) return null;
  return (
    <button type="button" class="ed-grab" aria-label={sheet.full ? 'Shrink the editor' : 'Expand the editor'} data-testid="sheet-toggle" onClick={sheet.onToggle}>
      <i />
    </button>
  );
}

const padName = (p: Pad) => p.name.trim() || p.id;

/** Who else answers this key, and what a press of it does then (keys are global: the visible pad's button first, else the one unique match). */
function keyNote(pads: Pad[], pi: number, b: Button): ComponentChildren {
  if (b.key === undefined) return null;
  const pad = pads[pi]!;
  const here = matchKey(
    pad.buttons.filter((x) => x !== b),
    b.key,
  );
  const elsewhere = pads.flatMap((x, i) => {
    const m = i === pi ? undefined : matchKey(x.buttons, b.key!);
    return m ? [{ pad: x, button: m }] : [];
  });
  const notes: string[] = [];
  if (here) notes.push(`Also bound to ${nameOf(here)} on this pad: the first one wins.`);
  if (elsewhere.length) {
    const list = elsewhere.map((e) => `${nameOf(e.button)} on ${padName(e.pad)}`).join(', ');
    const rest = pads.length > elsewhere.length + 1;
    notes.push(
      `Also bound to ${list}. Keys work from every pad: on each of these pads its own button wins${rest ? '; from any other pad the key does nothing, since it isn’t unique' : ''}.`,
    );
  }
  return notes.length ? notes.join(' ') : null;
}

export function ButtonPanel(
  p: PanelChrome & {
    ed: Editor;
    backend: Backend;
    /** All pads of the draft, and the index of this button's. */
    pads: Pad[];
    pi: number;
    pad: Pad;
    ix: number;
    b: Button;
    errors: Map<string, string>;
    /** The host's warnings from the last save, by field ('' = the button), while still relevant. */
    warnings: Map<string, string>;
    tab: Tab;
    onTab(t: Tab): void;
    /** The same pad/button as currently on the host. */
    hostButton: Button | undefined;
    changed: boolean;
    /** Running on the host now. */
    running: boolean;
    saving: boolean;
    /** Save the draft, then `run` (Recent runs: "Save & run"). */
    onSaveAndRun(run: () => void): void;
    /** Recent runs wants a yes first (a `confirm` button): the editor asks. */
    onAsk(q: RunAsk): void;
    onClose(): void;
    onDuplicate(): void;
    onDelete(): void;
  },
) {
  const { b, ed, errors } = p;
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const err = (k: string) => errors.get(k);
  /** Range errors in words with the unit ("Must be at most 60000 ms (1 min)"). */
  const msErr = (k: string) => {
    const e = err(k);
    const m = e && /^Must be at (most|least) (\d+)$/.exec(e);
    return m ? `Must be at ${m[1]} ${m[2]} ms${+m[2]! >= 1000 ? ` (${secs(+m[2]!)})` : ''}` : e;
  };
  const onActionTab = (k: string) => k.startsWith('action') || k.startsWith('stops');
  const actionBad = [...errors.keys()].some(onActionTab);
  const buttonBad = [...errors.keys()].some((k) => k && !onActionTab(k));
  const look = stateLookalike(toRGB(b.color));

  const tabBtn = (t: Tab, label: string, bad: boolean) => (
    <button type="button" role="tab" class="ed-tab" aria-selected={p.tab === t} data-testid={`editor-tab-${t}`} onClick={() => p.onTab(t)}>
      {label}
      {bad && <i class="ed-tab-bad" aria-label="has problems" />}
    </button>
  );

  const num = (k: keyof typeof RANGE, label: string, hint: ComponentChildren, step: number) => (
    <Field label={label} for={id(k)} error={msErr(k)} hint={hint} testid={k}>
      <NumberInput id={id(k)} value={b[k]} unit="ms" step={step} min={RANGE[k][0]} max={RANGE[k][1]} onValue={(n) => ed.patchButton({ [k]: n }, k)} testid={`field-${k}`} invalid={!!err(k)} />
    </Field>
  );

  return (
    <>
      <div class="ed-panel-head">
        <SheetGrab sheet={p.sheet} />
        <div class="ed-panel-title">
          <span class="ed-dot" style={{ '--c': b.color }} />
          <div class="ed-panel-names">
            <div class="ed-panel-name">{b.label.trim() || 'No label'}</div>
            <div class="ed-panel-sub">
              {b.id} · {b.w}×{b.h}
            </div>
          </div>
        </div>
        <button type="button" class="ed-icon" aria-label="Duplicate button" title="Duplicate" data-testid="editor-duplicate" onClick={p.onDuplicate}>
          <Copy />
        </button>
        <button type="button" class="ed-icon is-danger" aria-label="Delete button" title="Delete" data-testid="editor-delete" onClick={p.onDelete}>
          <Trash />
        </button>
        <button type="button" class="ed-icon" aria-label="Close the editor" title="Close (Esc)" data-testid="editor-close" onClick={p.onClose}>
          <Close />
        </button>
      </div>
      <div class="ed-tabs" role="tablist">
        {tabBtn('button', 'Button', buttonBad)}
        {tabBtn('action', 'Action', actionBad)}
        {tabBtn('runs', 'Recent runs', false)}
      </div>
      <div class="ed-panel-body" data-scroll key={p.tab}>
        {p.running && p.tab !== 'runs' && (
          <div class="ed-callout is-running" data-testid="running-note">
            Running on the host now. Changing it doesn't touch this run; deleting it or changing its id (or the pad's) and saving stops it.
          </div>
        )}
        {err('') && (
          <div class="ed-callout is-bad" role="alert" data-testid="error-button">
            {err('')}
          </div>
        )}
        {[...p.warnings].map(([k, w]) => (
          <div key={k} class="ed-callout is-warn" data-testid="warning-button">
            <b>The host warns:</b> {k ? `${fieldName(k)}: ` : ''}
            {w}
          </div>
        ))}
        {p.tab === 'button' && (
          <>
            <Section title="Look">
              <Field label="Label" for={id('label')} error={err('label')} testid="label">
                <TextInput id={id('label')} value={b.label} maxLength={200} placeholder="What it does, in a word or two" onValue={(v) => ed.patchButton({ label: v }, 'label')} testid="field-label" />
              </Field>
              <Field label="Color" error={err('color')} hint={look ? undefined : 'Skip green and red: they mean success and failure.'}>
                <ColorPicker
                  value={b.color}
                  onChange={(c) => ed.patchButton({ color: c }, 'color')}
                  testid="field-color"
                  warning={
                    look && (
                      <span class="ed-warn-note" data-testid="color-warning" data-look={look}>
                        {LOOKALIKE[look]}
                      </span>
                    )
                  }
                />
              </Field>
            </Section>
            <Section title="Press">
              <Segmented
                label="Trigger"
                value={b.trigger}
                testid="field-trigger"
                onChange={(t) => ed.patchButton({ trigger: t })}
                options={[
                  { value: 'hold', label: 'Hold', icon: <Hold /> },
                  { value: 'tap', label: 'Tap', icon: <Tap /> },
                  { value: 'double', label: '2× tap', icon: <DoubleTap /> },
                ]}
              />
              <p class="ed-hint">{TRIGGER_NOTE[b.trigger]}</p>
              <div class="ed-pair">
                {b.trigger === 'hold' && num('holdMs', 'Hold for', '100–5000 ms', 50)}
                <Field label="Finger may slide" for={id('drift')} error={err('driftPx')} hint="before the press cancels" testid="driftPx">
                  <NumberInput id={id('drift')} value={b.driftPx} unit="px" step={5} min={0} onValue={(n) => ed.patchButton({ driftPx: n }, 'driftPx')} testid="field-driftPx" invalid={!!err('driftPx')} />
                </Field>
              </div>
              <SwitchRow title="Ask to confirm" note="Needs a second press: for things you can't take back." on={b.confirm} onChange={(v) => ed.patchButton({ confirm: v })} testid="field-confirm" />
              {b.confirm && num('confirmWindowMs', 'Second press within', `${secs(b.confirmWindowMs)} (0.5–60 s)`, 100)}
              {num('cooldownMs', 'Then ignore presses for', `${secs(b.cooldownMs)} after it fires (0–10 s; 0 = off): stops key chatter and bounces from firing it twice.`, 100)}
              <Field label="Keyboard key" error={err('key')} hint="Bluetooth clickers and remotes pair as keyboards: press theirs here.">
                <KeyCapture value={b.key} onChange={(k) => ed.patchButton({ key: k })} conflict={keyNote(p.pads, p.pi, b)} testid="field-key" />
              </Field>
            </Section>
            <Section title="While it runs">
              <Segmented
                label="A press while running"
                value={b.whileRunning}
                testid="field-while"
                onChange={(w) => ed.patchButton({ whileRunning: w })}
                options={[
                  { value: 'ignore', label: 'Ignore' },
                  { value: 'cancel', label: 'Cancel it' },
                  { value: 'queue', label: 'Queue' },
                ]}
              />
              <p class="ed-hint">{WHILE_NOTE[b.whileRunning]}</p>
              <div class="ed-pair">
                {num('timeoutMs', 'Time limit', `${secs(b.timeoutMs)}, then it's killed (up to 24 h)`, 1000)}
                {num('resultHoldMs', 'Show result for', `${secs(b.resultHoldMs)} of ✓ / ✗ (up to 60 s)`, 500)}
              </div>
            </Section>
            <Section title="Id">
              <Field label="Button id" for={id('id')} error={err('id')} testid="id" hint={<IdHint ed={ed} pad={p.pad} b={b} running={p.running} />}>
                <TextInput id={id('id')} value={b.id} mono onValue={(v) => ed.patchButton({ id: v }, 'id')} testid="field-id" invalid={!!err('id')} />
              </Field>
            </Section>
          </>
        )}
        {p.tab === 'action' && (
          <>
            <ActionFields ed={ed} a={b.action} stops={!!b.stops?.length} errors={errors} id={id} />
            <StopsEditor pads={p.pads} pi={p.pi} b={b} error={[...errors].find(([k]) => k.startsWith('stops'))?.[1]} onChange={(stops) => ed.patchButton({ stops })} />
            {b.action.type !== 'none' && <OutputTips shell={b.action.type === 'shell'} />}
          </>
        )}
        {p.tab === 'runs' && (
          <RunLog backend={p.backend} padId={p.pad.id} button={b} hostButton={p.hostButton} changed={p.changed} saving={p.saving} onSaveAndRun={p.onSaveAndRun} onAsk={p.onAsk} />
        )}
      </div>
    </>
  );
}

/** What the id is for, and what changing it breaks (the host still knows the button by its saved id). */
function IdHint({ ed, pad, b, running }: { ed: Editor; pad: Pad; b: Button; running: boolean }) {
  if (ed.isFresh(b)) return <>Follows the label until you type one.</>;
  const bp = ed.baseOf(pad);
  const bb = bp && ed.baseOf(b, pad);
  if (bp && bb && (bb.id !== b.id || bp.id !== pad.id))
    return (
      <span class="ed-warn-note" data-testid="id-warning">
        Saved as <code>{bp.id}/{bb.id}</code>: changing it breaks <code>POST /api/press/{bp.id}/{bb.id}</code> links, starts its run history over
        {running ? ', and stops its current run' : ''}. Buttons that stop it follow the new id.
      </span>
    );
  return (
    <>
      Used by the HTTP API (<code>POST /api/press/{pad.id}/{b.id}</code>), its run history and other buttons' Stops: changing it breaks links to it.
    </>
  );
}

const ACTION_NOTE: Record<Action['type'], string> = {
  shell: 'Run by /bin/sh (or the shell set below; cmd.exe on Windows): pipes, && and variables work.',
  exec: 'Started directly with these arguments: no shell, so no quoting surprises.',
  none: "Runs nothing, and shows ✓ at once: for a button that only stops others (pick them under Stops).",
};

function ActionFields({ ed, a, stops, errors, id }: { ed: Editor; a: Action; stops: boolean; errors: Map<string, string>; id(k: string): string }) {
  const err = (k: string) => errors.get(k);
  const patch = (x: Partial<Extract<Action, { type: 'exec' | 'shell' }>>, field?: string) => ed.patchButton({ action: { ...a, ...x } as Action }, field && `action.${field}`);
  const argErr = [...errors].find(([k]) => k.startsWith('action.args'))?.[1];
  // Errors of one variable show on its row.
  const envErr = errors.get('action.env');
  return (
    <Section title="Action">
      <Segmented
        label="Action type"
        value={a.type}
        testid="field-action-type"
        wrap
        onChange={(t) => ed.setActionType(t)}
        options={[
          { value: 'shell', label: 'Shell script' },
          { value: 'exec', label: 'Program' },
          { value: 'none', label: 'Nothing (stop others)' },
        ]}
      />
      <p class="ed-hint">{ACTION_NOTE[a.type]}</p>
      {a.type === 'none' && !stops && (
        <p class="ed-warn-note" data-testid="none-stops-nothing">
          It stops nothing yet either: a press would just show ✓. Pick what it stops below.
        </p>
      )}
      {a.type === 'shell' && (
        <>
          {isPlaceholder(a) && (
            <p class="ed-warn-note" data-testid="placeholder-note">
              Not set up yet: a press fails with “No action set”. Replace the script with what it should do.
            </p>
          )}
          <Field label="Script" for={id('script')} error={err('action.script')} testid="script">
            <TextArea id={id('script')} value={a.script} rows={6} placeholder="echo 'hello'" onValue={(v) => patch({ script: v }, 'script')} invalid={!!err('action.script')} testid="field-script" />
          </Field>
          <Field label="Shell" for={id('shell')} error={err('action.shell')} hint="Leave empty for /bin/sh (cmd.exe on Windows). Set it for bash, zsh… features.">
            <TextInput id={id('shell')} value={a.shell ?? ''} mono placeholder="/bin/sh" onValue={(v) => patch({ shell: v || undefined }, 'shell')} testid="field-shell" />
          </Field>
        </>
      )}
      {a.type === 'exec' && (
        <>
          <Field label="Program" for={id('cmd')} error={err('action.command')} hint="A path, or a name on the host's PATH. A relative path (./x.sh) starts in the working folder below." testid="command">
            <TextInput id={id('cmd')} value={a.command} mono placeholder="/usr/bin/say" onValue={(v) => patch({ command: v }, 'command')} invalid={!!err('action.command')} testid="field-command" />
          </Field>
          <Field label="Arguments" error={argErr} hint="One per line, passed as-is: no quotes needed.">
            <ListEditor items={a.args} onChange={(args, f) => patch({ args }, f)} errors={errors} testid="field-arg" addLabel="Add argument" placeholder="argument" />
          </Field>
        </>
      )}
      {a.type !== 'none' && (
        <>
          <Field
            label="Working folder"
            for={id('cwd')}
            error={err('action.cwd')}
            hint={`Where it runs. Default: the config file's folder; a relative folder starts there.${a.type === 'exec' ? ' A relative program path starts here.' : ''}`}
          >
            <TextInput id={id('cwd')} value={a.cwd ?? ''} mono placeholder="(config folder)" onValue={(v) => patch({ cwd: v || undefined }, 'cwd')} testid="field-cwd" />
          </Field>
          <Field label="Environment" error={envErr} hint="Added to the host's environment. Names: letters, digits and _.">
            <EnvEditor env={a.env} errors={errors} onChange={(env, f) => patch({ env }, f)} />
          </Field>
        </>
      )}
    </Section>
  );
}

const Code = ({ children }: { children: ComponentChildren }) => <code class="ed-code">{children}</code>;

function OutputTips({ shell }: { shell: boolean }) {
  return (
    <aside class="ed-tip" data-testid="output-tips">
      <h4>What the button shows</h4>
      <dl>
        <dt>
          <Code>@status copying</Code>
        </dt>
        <dd>a status line while it runs</dd>
        <dt>
          <Code>@progress 40</Code>
        </dt>
        <dd>a progress fill, 0–100</dd>
        <dt>
          <Code>@result 12 files</Code>
        </dt>
        <dd>the result text</dd>
        <dt>
          <Code>@state REC ●</Code>
        </dt>
        <dd>a device state that stays on the button after the run (<Code>@state</Code> alone clears it)</dd>
      </dl>
      <p>
        Print these on their own line to stdout. Without <Code>@result</Code>, the last line printed is shown. Exit code 0 is a ✓; anything else is a ✗ with the last
        line of stderr.
      </p>
      {shell && (
        <pre class="ed-pre is-example" data-selectable>
          {"echo '@status copying'\nrsync -a ~/shoot/ /Volumes/card/ \\\n  && echo '@result copied'"}
        </pre>
      )}
      <p>
        Also set for every run: <Code>BUTTPAD_PAD</Code> <Code>BUTTPAD_BUTTON</Code> <Code>BUTTPAD_LABEL</Code> <Code>BUTTPAD_RUN_ID</Code>
      </p>
    </aside>
  );
}
