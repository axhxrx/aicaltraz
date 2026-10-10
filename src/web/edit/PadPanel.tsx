/** Pad settings: name, grid size (refuses to clip buttons), id, order, delete. */
import { useEffect, useId, useState } from 'preact/hooks';
import type { Button, Pad } from '../../core/config.ts';
import { Close } from '../ui/icons.tsx';
import type { Editor } from './editor.ts';
import { Field, Section, Stepper, TextInput } from './fields.tsx';
import { ChevronLeft, ChevronRight, Plus, Trash } from './icons.tsx';
import { SheetGrab, type PanelChrome } from './ButtonPanel.tsx';
import { names } from './ops.ts';

export function shrinkRefusal(cols: number, rows: number, blockers: Button[]): string {
  const one = blockers.length === 1;
  return `Can't shrink to ${cols} × ${rows}: ${names(blockers)} ${one ? 'is' : 'are'} in the way. Move or resize ${one ? 'it' : 'them'} first.`;
}

/** What the pad id is for, and what changing it breaks (the host knows the pad by its saved id). */
function PadIdHint({ ed, pad }: { ed: Editor; pad: Pad }) {
  if (ed.isFresh(pad)) return <>Follows the name until you type one.</>;
  const was = ed.baseOf(pad)?.id;
  if (was !== undefined && was !== pad.id)
    return (
      <span class="ed-warn-note" data-testid="pad-id-warning">
        Saved as <code>{was}</code>: changing it breaks <code>?pad={was}</code> links and <code>/api/press/{was}/…</code> URLs, starts its buttons' run histories over, and
        stops their runs in progress when you save.
      </span>
    );
  return (
    <>
      Open this pad directly with <code>?pad={pad.id}</code>. Also in <code>/api/press/{pad.id}/…</code> URLs and run histories: changing it breaks those.
    </>
  );
}

export function PadPanel(
  p: PanelChrome & {
    ed: Editor;
    pad: Pad;
    index: number;
    count: number;
    errors: Map<string, string>;
    wide: boolean;
    onClose(): void;
    onDelete(): void;
    /** Add a 1×1 button in the first free cell. */
    onAddButton(): void;
    /** Shrink refused: point at the buttons in the way. */
    onBlocked(ixs: number[]): void;
  },
) {
  const { ed, pad } = p;
  const uid = useId();
  const full = pad.buttons.reduce((n, b) => n + b.w * b.h, 0) >= pad.cols * pad.rows;
  const [sizeErr, setSizeErr] = useState<string | null>(null);
  useEffect(() => setSizeErr(null), [p.index, pad.cols, pad.rows]);
  const resize = (cols: number, rows: number) => {
    const r = ed.resizePad(cols, rows);
    if (r.ok) return setSizeErr(null);
    setSizeErr(shrinkRefusal(cols, rows, r.blockers));
    p.onBlocked(r.blockers.map((b) => pad.buttons.indexOf(b)));
  };
  return (
    <>
      <div class="ed-panel-head">
        <SheetGrab sheet={p.sheet} />
        <div class="ed-panel-title">
          <div class="ed-panel-names">
            <div class="ed-panel-name">{pad.name.trim() || pad.id}</div>
            <div class="ed-panel-sub">
              Pad {p.index + 1} of {p.count} · {pad.buttons.length} button{pad.buttons.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        {!p.wide && (
          <button type="button" class="ed-icon" aria-label="Close pad settings" data-testid="pad-close" onClick={p.onClose}>
            <Close />
          </button>
        )}
      </div>
      <div class="ed-panel-body" data-scroll data-testid="pad-editor-body">
        <Section title="Pad">
          <Field label="Name" for={`${uid}-name`} error={p.errors.get('name')} testid="pad-name">
            <TextInput id={`${uid}-name`} value={pad.name} placeholder="Lights" onValue={(v) => ed.patchPad({ name: v }, 'name')} testid="pad-name" invalid={!!p.errors.get('name')} />
          </Field>
          <div class="ed-field">
            <span class="ed-label">Grid</span>
            <div class="ed-grid-size">
              <div class="ed-grid-dim">
                <span>Columns</span>
                <Stepper label="Columns" value={pad.cols} min={1} max={12} onChange={(c) => resize(c, pad.rows)} testid="pad-cols" />
              </div>
              <div class="ed-grid-dim">
                <span>Rows</span>
                <Stepper label="Rows" value={pad.rows} min={1} max={12} onChange={(r) => resize(pad.cols, r)} testid="pad-rows" />
              </div>
            </div>
            {sizeErr ? (
              <span class="ed-err" role="alert" data-testid="pad-size-error">
                {sizeErr}
              </span>
            ) : (
              <span class="ed-hint">Up to 12 × 12. Fewer, bigger buttons are easier to hit.</span>
            )}
          </div>
          <Field
            label="Pad id"
            for={`${uid}-id`}
            error={p.errors.get('id')}
            testid="pad-id"
            hint={<PadIdHint ed={ed} pad={pad} />}
          >
            <TextInput id={`${uid}-id`} value={pad.id} mono onValue={(v) => ed.patchPad({ id: v }, 'id')} testid="pad-id" invalid={!!p.errors.get('id')} />
          </Field>
        </Section>
        <Section title="Buttons">
          <button type="button" class="ed-btn" data-testid="pad-add-button" disabled={full} onClick={p.onAddButton}>
            <Plus /> Add a button
          </button>
          <p class="ed-hint">{full ? 'No empty squares left: add a row or a column first.' : `Or ${p.wide ? 'click' : 'tap'} any empty square to put one exactly there.`}</p>
        </Section>
        <Section title="Order">
          <div class="ed-btn-row">
            <button type="button" class="ed-btn" data-testid="pad-move-left" disabled={p.index === 0} onClick={() => ed.movePad(-1)}>
              <ChevronLeft /> Earlier
            </button>
            <button type="button" class="ed-btn" data-testid="pad-move-right" disabled={p.index === p.count - 1} onClick={() => ed.movePad(1)}>
              Later <ChevronRight />
            </button>
          </div>
          <p class="ed-hint">The order of the tabs in run mode.</p>
        </Section>
        <Section title="Remove">
          <button type="button" class="ed-btn is-danger" data-testid="pad-delete" disabled={p.count <= 1} onClick={p.onDelete}>
            <Trash /> Delete this pad
          </button>
          {p.count <= 1 && <p class="ed-hint">The only pad can't go: add another first.</p>}
        </Section>
        {p.wide && (
          <aside class="ed-tip">
            <h4>Editing the pad</h4>
            <ul>
              <li>Click an empty square to add a button there.</li>
              <li>Drag a button to move it; drag its corner to resize.</li>
              <li>
                <kbd>←↑↓→</kbd> move, <kbd>Shift</kbd>+arrows resize, <kbd>Delete</kbd> removes, <kbd>Esc</kbd> deselects.
              </li>
              <li>
                <kbd>⌘Z</kbd>/<kbd>Ctrl+Z</kbd> undo, <kbd>⇧⌘Z</kbd> redo, <kbd>⌘S</kbd> saves.
              </li>
            </ul>
          </aside>
        )}
      </div>
    </>
  );
}
