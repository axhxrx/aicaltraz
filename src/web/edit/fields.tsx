/** Form controls for the editor panels: dark, 16px text (no iOS zoom), 44px+ touch targets. */
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { inkFor, isValidColor, toRGB } from '../lib/color.ts';
import { keyName } from '../run/view.ts';
import { Close } from '../ui/icons.tsx';
import { ChevronDown, ChevronUp, Plus } from './icons.tsx';
import { PALETTE } from './ops.ts';

export const typingIn = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('input:not([type=checkbox]):not([type=radio]):not([type=color]), textarea, select, [contenteditable]');

export function Section(p: { title: string; children: ComponentChildren; aside?: ComponentChildren }) {
  return (
    <section class="ed-section">
      <div class="ed-section-head">
        <h3>{p.title}</h3>
        {p.aside}
      </div>
      {p.children}
    </section>
  );
}

/** Label + control + hint/error. `for` links the label to a single input. */
export function Field(p: { label: string; for?: string; hint?: ComponentChildren; error?: string; testid?: string; children: ComponentChildren; class?: string }) {
  return (
    <div class={`ed-field${p.error ? ' is-bad' : ''}${p.class ? ` ${p.class}` : ''}`}>
      {p.for ? (
        <label class="ed-label" for={p.for}>
          {p.label}
        </label>
      ) : (
        <span class="ed-label">{p.label}</span>
      )}
      {p.children}
      {p.error ? (
        <span class="ed-err" role="alert" data-testid={p.testid && `error-${p.testid}`}>
          {p.error}
        </span>
      ) : (
        p.hint && <span class="ed-hint">{p.hint}</span>
      )}
    </div>
  );
}

interface InputProps {
  value: string;
  onValue(v: string): void;
  id?: string;
  placeholder?: string;
  'aria-label'?: string;
  onFocus?(): void;
  onBlur?(): void;
  mono?: boolean;
  invalid?: boolean;
  testid?: string;
}

export function TextInput({ value, onValue, mono, invalid, testid, ...rest }: InputProps) {
  return (
    <input
      class={`ed-input${mono ? ' is-mono' : ''}`}
      value={value}
      onInput={(e) => onValue(e.currentTarget.value)}
      aria-invalid={invalid || undefined}
      data-testid={testid}
      autocomplete="off"
      autocapitalize={mono ? 'off' : undefined}
      autocorrect={mono ? 'off' : undefined}
      spellcheck={mono ? false : undefined}
      enterKeyHint="done"
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      {...rest}
    />
  );
}

export function TextArea(p: { id?: string; value: string; onValue(v: string): void; rows?: number; placeholder?: string; invalid?: boolean; testid?: string }) {
  return (
    <textarea
      id={p.id}
      class="ed-input ed-textarea is-mono"
      value={p.value}
      rows={p.rows ?? 5}
      placeholder={p.placeholder}
      onInput={(e) => p.onValue(e.currentTarget.value)}
      aria-invalid={p.invalid || undefined}
      data-testid={p.testid}
      autocapitalize="off"
      autocorrect="off"
      spellcheck={false}
      data-selectable
    />
  );
}

/**
 * Number field: what's typed stays as typed; every parseable value goes to the draft (range
 * errors come from validation), junk reverts on blur.
 */
export function NumberInput(p: { id?: string; value: number; onValue(n: number): void; unit?: string; invalid?: boolean; testid?: string; step?: number }) {
  const [text, setText] = useState(String(p.value));
  useEffect(() => {
    if (Number(text) !== p.value || text.trim() === '') setText(String(p.value));
  }, [p.value]);
  return (
    <div class="ed-num">
      <input
        id={p.id}
        class="ed-input is-num"
        inputMode="decimal"
        value={text}
        aria-invalid={p.invalid || undefined}
        data-testid={p.testid}
        autocomplete="off"
        enterKeyHint="done"
        onInput={(e) => {
          const t = e.currentTarget.value;
          setText(t);
          const n = Number(t);
          if (t.trim() !== '' && Number.isFinite(n)) p.onValue(n);
        }}
        onBlur={() => setText(String(p.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            p.onValue(p.value + (e.key === 'ArrowUp' ? 1 : -1) * (p.step ?? 1) * (e.shiftKey ? 10 : 1));
          }
        }}
      />
      {p.unit && <span class="ed-unit">{p.unit}</span>}
    </div>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  icon?: ComponentChildren;
}

export function Segmented<T extends string>(p: { value: T; options: Option<T>[]; onChange(v: T): void; testid: string; label: string }) {
  return (
    <div class="ed-seg" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          class="ed-seg-opt"
          data-testid={`${p.testid}-${o.value}`}
          onClick={() => p.onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle(p: { on: boolean; onChange(v: boolean): void; label: string; testid?: string }) {
  return (
    <button type="button" role="switch" class="bp-switch" aria-checked={p.on} aria-label={p.label} data-testid={p.testid} onClick={() => p.onChange(!p.on)}>
      <i />
    </button>
  );
}

/** A labeled row with a switch on the right. */
export function SwitchRow(p: { title: string; note?: string; on: boolean; onChange(v: boolean): void; testid?: string }) {
  return (
    <div class="ed-switch-row">
      <div class="ed-switch-text">
        <span class="ed-switch-title">{p.title}</span>
        {p.note && <span class="ed-hint">{p.note}</span>}
      </div>
      <Toggle label={p.title} on={p.on} onChange={p.onChange} testid={p.testid} />
    </div>
  );
}

export function Stepper(p: { value: number; min: number; max: number; onChange(v: number): void; label: string; testid: string }) {
  return (
    <div class="ed-stepper" role="group" aria-label={p.label}>
      <button type="button" class="ed-step" aria-label={`Fewer ${p.label.toLowerCase()}`} data-testid={`${p.testid}-dec`} disabled={p.value <= p.min} onClick={() => p.onChange(p.value - 1)}>
        −
      </button>
      <output class="ed-step-value" data-testid={`${p.testid}-value`} aria-live="polite">
        {p.value}
      </output>
      <button type="button" class="ed-step" aria-label={`More ${p.label.toLowerCase()}`} data-testid={`${p.testid}-inc`} disabled={p.value >= p.max} onClick={() => p.onChange(p.value + 1)}>
        +
      </button>
    </div>
  );
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'Tab', 'Unidentified', 'Dead', 'Process']);
const KEY_WORDS: Record<string, string> = { ' ': 'Space', Enter: 'Enter', ArrowUp: 'Arrow up', ArrowDown: 'Arrow down', ArrowLeft: 'Arrow left', ArrowRight: 'Arrow right' };

/** "Press a key to bind": captures the next keydown (Esc cancels), before any other handler sees it. */
export function KeyCapture(p: { value: string | undefined; onChange(k: string | undefined): void; conflict?: string; testid: string }) {
  const [listening, setListening] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!listening) return;
    const fn = (e: KeyboardEvent) => {
      if (MODIFIERS.has(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key !== 'Escape') p.onChange(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      setListening(false);
    };
    // Safari doesn't focus buttons on click, so blur alone can't end listening.
    const away = (e: PointerEvent) => !btn.current?.contains(e.target as Node) && setListening(false);
    window.addEventListener('keydown', fn, true);
    window.addEventListener('pointerdown', away, true);
    return () => (window.removeEventListener('keydown', fn, true), window.removeEventListener('pointerdown', away, true));
  }, [listening]);
  const v = p.value;
  return (
    <div class="ed-keycap-row">
      <button
        ref={btn}
        type="button"
        class={`ed-keycap${listening ? ' is-listening' : ''}`}
        data-testid={p.testid}
        aria-pressed={listening}
        onClick={() => setListening((l) => !l)}
        onBlur={() => setListening(false)}
      >
        {listening ? (
          <span class="ed-keycap-wait">Press a key… (Esc cancels)</span>
        ) : v !== undefined ? (
          <>
            <kbd>{keyName(v)}</kbd>
            <span>{KEY_WORDS[v] ?? (v.length === 1 ? `Key “${v}”` : v)}</span>
            <span class="ed-keycap-change">Change</span>
          </>
        ) : (
          <span class="ed-keycap-wait">Press to bind a key</span>
        )}
      </button>
      {v !== undefined && !listening && (
        <button type="button" class="ed-icon" aria-label="Remove key" data-testid={`${p.testid}-clear`} onClick={() => p.onChange(undefined)}>
          <Close />
        </button>
      )}
      {p.conflict && <span class="ed-warn-note">Also bound to {p.conflict}: the first one wins.</span>}
    </div>
  );
}

const hex = (c: string) => `#${toRGB(c).map((n) => n.toString(16).padStart(2, '0')).join('')}`;

export function ColorPicker(p: { value: string; onChange(c: string): void; testid: string }) {
  const [text, setText] = useState(p.value);
  useEffect(() => setText(p.value), [p.value]);
  const current = p.value.toLowerCase();
  const custom = !PALETTE.includes(current);
  return (
    <div class="ed-colors">
      <div class="ed-swatches" role="radiogroup" aria-label="Button color">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            class="ed-swatch"
            aria-checked={c === current}
            aria-label={c}
            data-testid={`${p.testid}-swatch-${c.slice(1)}`}
            style={{ '--c': c, '--ink': inkFor(c) }}
            onClick={() => p.onChange(c)}
          />
        ))}
      </div>
      <div class="ed-color-custom">
        <label class={`ed-swatch is-picker${custom ? ' is-on' : ''}`} style={{ '--c': p.value, '--ink': inkFor(p.value) }} title="Pick any color">
          <input type="color" value={hex(p.value)} aria-label="Custom color" onInput={(e) => p.onChange(e.currentTarget.value)} data-testid={`${p.testid}-picker`} />
          <Plus />
        </label>
        <TextInput
          value={text}
          mono
          aria-label="Color (any CSS color)"
          placeholder="#2f6fde"
          testid={`${p.testid}-text`}
          invalid={!isValidColor(text)}
          onValue={(t) => {
            setText(t);
            if (t.trim() && isValidColor(t.trim())) p.onChange(t.trim());
          }}
          onBlur={() => setText(p.value)}
        />
      </div>
    </div>
  );
}

/** Ordered string list (exec args): edit, add, remove, move up/down. */
export function ListEditor(p: { items: string[]; onChange(items: string[], field?: string): void; errors: Map<string, string>; testid: string; addLabel: string; placeholder?: string }) {
  const [focus, setFocus] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === null) return;
    root.current?.querySelectorAll<HTMLInputElement>('input')[focus]?.focus();
    setFocus(null);
  }, [focus]);
  const set = (i: number, v: string) => p.onChange(p.items.map((x, j) => (j === i ? v : x)), `arg${i}`);
  const swap = (i: number, j: number) => {
    const next = [...p.items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    p.onChange(next);
  };
  return (
    <div class="ed-list" ref={root}>
      {p.items.map((v, i) => (
        <div class="ed-list-row" key={i}>
          <span class="ed-list-n">{i + 1}</span>
          <TextInput value={v} mono placeholder={p.placeholder} onValue={(t) => set(i, t)} testid={`${p.testid}-${i}`} aria-label={`Argument ${i + 1}`} invalid={p.errors.has(`action.args.${i}`)} />
          <button type="button" class="ed-icon" aria-label="Move up" disabled={i === 0} onClick={() => swap(i, i - 1)} data-testid={`${p.testid}-${i}-up`}>
            <ChevronUp />
          </button>
          <button type="button" class="ed-icon" aria-label="Move down" disabled={i === p.items.length - 1} onClick={() => swap(i, i + 1)} data-testid={`${p.testid}-${i}-down`}>
            <ChevronDown />
          </button>
          <button type="button" class="ed-icon" aria-label="Remove" onClick={() => p.onChange(p.items.filter((_, j) => j !== i))} data-testid={`${p.testid}-${i}-remove`}>
            <Close />
          </button>
        </div>
      ))}
      <button type="button" class="ed-add" data-testid={`${p.testid}-add`} onClick={() => (p.onChange([...p.items, '']), setFocus(p.items.length))}>
        <Plus /> {p.addLabel}
      </button>
    </div>
  );
}

function EnvRow(p: { name: string; value: string; taken: (k: string) => boolean; onRename(k: string): void; onValue(v: string): void; onRemove(): void; i: number }) {
  const [name, setName] = useState(p.name);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setName(p.name);
  }, [p.name]);
  const err = name.trim() === '' ? "Can't be empty" : name !== p.name && p.taken(name) ? 'Already set above' : '';
  return (
    <div class="ed-env-row">
      <div class="ed-env-cells">
        <TextInput
          value={name}
          mono
          aria-label="Variable name"
          placeholder="NAME"
          testid={`env-key-${p.i}`}
          invalid={!!err}
          onFocus={() => (editing.current = true)}
          onBlur={() => ((editing.current = false), setName(p.name))}
          onValue={(t) => {
            setName(t);
            if (t.trim() !== '' && (t === p.name || !p.taken(t))) p.onRename(t);
          }}
        />
        <span class="ed-env-eq">=</span>
        <TextInput value={p.value} mono aria-label={`Value of ${p.name}`} placeholder="value" testid={`env-value-${p.i}`} onValue={p.onValue} />
        <button type="button" class="ed-icon" aria-label={`Remove ${p.name}`} onClick={p.onRemove} data-testid={`env-remove-${p.i}`}>
          <Close />
        </button>
      </div>
      {err && <span class="ed-err">{err}</span>}
    </div>
  );
}

/** Environment variables: an ordered record; empty → undefined (keeps the file compact). */
export function EnvEditor(p: { env: Record<string, string> | undefined; onChange(env: Record<string, string> | undefined, field?: string): void }) {
  const entries = Object.entries(p.env ?? {});
  const [focus, setFocus] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === null) return;
    root.current?.querySelectorAll<HTMLInputElement>('.ed-env-row')[focus]?.querySelector('input')?.select();
    setFocus(null);
  }, [focus]);
  const out = (list: [string, string][], field?: string) => p.onChange(list.length ? Object.fromEntries(list) : undefined, field);
  const add = () => {
    const keys = new Set(entries.map(([k]) => k));
    let k = 'NAME';
    for (let n = 2; keys.has(k); n++) k = `NAME_${n}`;
    out([...entries, [k, '']]);
    setFocus(entries.length);
  };
  return (
    <div class="ed-list" ref={root}>
      {entries.map(([k, v], i) => (
        <EnvRow
          key={i}
          i={i}
          name={k}
          value={v}
          taken={(n) => entries.some(([o], j) => j !== i && o === n)}
          onRename={(n) => out(entries.map((e, j) => (j === i ? [n, e[1]] : e)), `envk${i}`)}
          onValue={(nv) => out(entries.map((e, j) => (j === i ? [e[0], nv] : e)), `envv${i}`)}
          onRemove={() => out(entries.filter((_, j) => j !== i))}
        />
      ))}
      <button type="button" class="ed-add" data-testid="env-add" onClick={add}>
        <Plus /> Add variable
      </button>
    </div>
  );
}

/** Modal: Esc / backdrop closes; focuses its first action. */
export function Dialog(p: { title: string; children: ComponentChildren; actions: ComponentChildren; onClose(): void; testid: string; tone?: 'danger' | 'warn' }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>('.ed-dialog-actions button')?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', k, true);
    return () => (window.removeEventListener('keydown', k, true), prev?.focus?.());
  }, []);
  return (
    <div class="ed-dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={box} class={`ed-dialog${p.tone ? ` is-${p.tone}` : ''}`} role="dialog" aria-modal="true" aria-label={p.title} data-testid={p.testid}>
        <h2>{p.title}</h2>
        <div class="ed-dialog-body">{p.children}</div>
        <div class="ed-dialog-actions">{p.actions}</div>
      </div>
    </div>
  );
}
