/** The button editor: look, press behavior, action, and its recent runs. */
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { Action, Button, Pad } from '../../core/config.ts';
import type { Backend } from '../backend/types.ts';
import { matchKey } from '../run/RunPad.tsx';
import { Close, DoubleTap, Hold, Tap } from '../ui/icons.tsx';
import type { Editor } from './editor.ts';
import { ColorPicker, EnvEditor, Field, KeyCapture, ListEditor, NumberInput, Section, Segmented, SwitchRow, TextArea, TextInput } from './fields.tsx';
import { Copy, Trash } from './icons.tsx';
import { nameOf } from './ops.ts';
import { RunLog } from './RunLog.tsx';

export type Tab = 'button' | 'action' | 'runs';

const secs = (ms: number) => (ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${+(ms / 1000).toFixed(1)} s`);

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

export function ButtonPanel(
  p: PanelChrome & {
    ed: Editor;
    backend: Backend;
    pad: Pad;
    ix: number;
    b: Button;
    errors: Map<string, string>;
    tab: Tab;
    onTab(t: Tab): void;
    /** The same pad/button as currently on the host. */
    hostButton: Button | undefined;
    changed: boolean;
    onClose(): void;
    onDuplicate(): void;
    onDelete(): void;
  },
) {
  const { b, ed, errors } = p;
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const err = (k: string) => errors.get(k);
  const actionBad = [...errors.keys()].some((k) => k.startsWith('action'));
  const buttonBad = [...errors.keys()].some((k) => k && !k.startsWith('action'));
  const conflict = b.key !== undefined ? matchKey(p.pad.buttons.filter((_, i) => i !== p.ix), b.key) : undefined;

  const tabBtn = (t: Tab, label: string, bad: boolean) => (
    <button type="button" role="tab" class="ed-tab" aria-selected={p.tab === t} data-testid={`editor-tab-${t}`} onClick={() => p.onTab(t)}>
      {label}
      {bad && <i class="ed-tab-bad" aria-label="has problems" />}
    </button>
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
        {err('') && (
          <div class="ed-callout is-bad" role="alert" data-testid="error-button">
            {err('')}
          </div>
        )}
        {p.tab === 'button' && (
          <>
            <Section title="Look">
              <Field label="Label" for={id('label')} error={err('label')} testid="label">
                <TextInput id={id('label')} value={b.label} placeholder="What it does, in a word or two" onValue={(v) => ed.patchButton({ label: v }, 'label')} testid="field-label" />
              </Field>
              <Field label="Color" error={err('color')} hint="Skip pure green and red: they mean success and failure.">
                <ColorPicker value={b.color} onChange={(c) => ed.patchButton({ color: c }, 'color')} testid="field-color" />
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
                {b.trigger === 'hold' && (
                  <Field label="Hold for" for={id('hold')} error={err('holdMs')} hint="100–5000 ms" testid="holdMs">
                    <NumberInput id={id('hold')} value={b.holdMs} unit="ms" step={50} onValue={(n) => ed.patchButton({ holdMs: n }, 'holdMs')} testid="field-holdMs" invalid={!!err('holdMs')} />
                  </Field>
                )}
                <Field label="Finger may slide" for={id('drift')} error={err('driftPx')} hint="before the press cancels" testid="driftPx">
                  <NumberInput id={id('drift')} value={b.driftPx} unit="px" step={5} onValue={(n) => ed.patchButton({ driftPx: n }, 'driftPx')} testid="field-driftPx" invalid={!!err('driftPx')} />
                </Field>
              </div>
              <SwitchRow title="Ask to confirm" note="Needs a second press: for things you can't take back." on={b.confirm} onChange={(v) => ed.patchButton({ confirm: v })} testid="field-confirm" />
              {b.confirm && (
                <Field label="Second press within" for={id('cw')} error={err('confirmWindowMs')} hint={`${secs(b.confirmWindowMs)} (at least 500 ms)`} testid="confirmWindowMs">
                  <NumberInput id={id('cw')} value={b.confirmWindowMs} unit="ms" step={100} onValue={(n) => ed.patchButton({ confirmWindowMs: n }, 'confirmWindowMs')} testid="field-confirmWindowMs" invalid={!!err('confirmWindowMs')} />
                </Field>
              )}
              <Field label="Keyboard key" error={err('key')} hint="Bluetooth clickers and remotes pair as keyboards: press theirs here.">
                <KeyCapture value={b.key} onChange={(k) => ed.patchButton({ key: k })} conflict={conflict && nameOf(conflict)} testid="field-key" />
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
                <Field label="Time limit" for={id('to')} error={err('timeoutMs')} hint={`${secs(b.timeoutMs)}, then it's killed`} testid="timeoutMs">
                  <NumberInput id={id('to')} value={b.timeoutMs} unit="ms" step={1000} onValue={(n) => ed.patchButton({ timeoutMs: n }, 'timeoutMs')} testid="field-timeoutMs" invalid={!!err('timeoutMs')} />
                </Field>
                <Field label="Show result for" for={id('rh')} error={err('resultHoldMs')} hint={`${secs(b.resultHoldMs)} of ✓ / ✗`} testid="resultHoldMs">
                  <NumberInput id={id('rh')} value={b.resultHoldMs} unit="ms" step={500} onValue={(n) => ed.patchButton({ resultHoldMs: n }, 'resultHoldMs')} testid="field-resultHoldMs" invalid={!!err('resultHoldMs')} />
                </Field>
              </div>
            </Section>
            <Section title="Id">
              <Field
                label="Button id"
                for={id('id')}
                error={err('id')}
                testid="id"
                hint={ed.isFresh(b) ? 'Follows the label until you type one.' : <>Used by the HTTP API: <code>POST /api/press/{p.pad.id}/{b.id}</code></>}
              >
                <TextInput id={id('id')} value={b.id} mono onValue={(v) => ed.patchButton({ id: v }, 'id')} testid="field-id" invalid={!!err('id')} />
              </Field>
            </Section>
          </>
        )}
        {p.tab === 'action' && <ActionFields ed={ed} a={b.action} errors={errors} id={id} />}
        {p.tab === 'runs' && <RunLog backend={p.backend} padId={p.pad.id} buttonId={b.id} onHost={!!p.hostButton} changed={p.changed} />}
      </div>
    </>
  );
}


function ActionFields({ ed, a, errors, id }: { ed: Editor; a: Action; errors: Map<string, string>; id(k: string): string }) {
  const err = (k: string) => errors.get(k);
  const patch = (x: Partial<Action>, field?: string) => ed.patchButton({ action: { ...a, ...x } as Action }, field && `action.${field}`);
  const argErr = [...errors].find(([k]) => k.startsWith('action.args'))?.[1];
  const envErr = [...errors].find(([k]) => k.startsWith('action.env'))?.[1];
  return (
    <>
      <Section title="Action">
        <Segmented
          label="Action type"
          value={a.type}
          testid="field-action-type"
          onChange={(t) => ed.setActionType(t)}
          options={[
            { value: 'shell', label: 'Shell script' },
            { value: 'exec', label: 'Program' },
          ]}
        />
        <p class="ed-hint">
          {a.type === 'shell'
            ? 'Run by a shell ($SHELL, else /bin/sh; cmd.exe on Windows): pipes, && and variables work.'
            : 'Started directly with these arguments: no shell, so no quoting surprises.'}
        </p>
        {a.type === 'shell' ? (
          <>
            <Field label="Script" for={id('script')} error={err('action.script')} testid="script">
              <TextArea id={id('script')} value={a.script} rows={6} placeholder="echo 'hello'" onValue={(v) => patch({ script: v }, 'script')} invalid={!!err('action.script')} testid="field-script" />
            </Field>
            <Field label="Shell" for={id('shell')} error={err('action.shell')} hint="Leave empty for the host's default shell.">
              <TextInput id={id('shell')} value={a.shell ?? ''} mono placeholder="/bin/sh" onValue={(v) => patch({ shell: v || undefined }, 'shell')} testid="field-shell" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Program" for={id('cmd')} error={err('action.command')} hint="A path, or a name on the host's PATH." testid="command">
              <TextInput id={id('cmd')} value={a.command} mono placeholder="/usr/bin/say" onValue={(v) => patch({ command: v }, 'command')} invalid={!!err('action.command')} testid="field-command" />
            </Field>
            <Field label="Arguments" error={argErr} hint="One per line, passed as-is: no quotes needed.">
              <ListEditor items={a.args} onChange={(args, f) => patch({ args }, f)} errors={errors} testid="field-arg" addLabel="Add argument" placeholder="argument" />
            </Field>
          </>
        )}
        <Field label="Working folder" for={id('cwd')} error={err('action.cwd')} hint="Default: the config file's folder. Relative paths start there too.">
          <TextInput id={id('cwd')} value={a.cwd ?? ''} mono placeholder="(config folder)" onValue={(v) => patch({ cwd: v || undefined }, 'cwd')} testid="field-cwd" />
        </Field>
        <Field label="Environment" error={envErr} hint="Added to the host's environment.">
          <EnvEditor env={a.env} onChange={(env, f) => patch({ env }, f)} />
        </Field>
      </Section>
      <OutputTips shell={a.type === 'shell'} />
    </>
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
