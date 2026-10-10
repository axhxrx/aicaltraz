/**
 * Edit mode (admin only): a local draft of the whole config with undo/redo, edited on a WYSIWYG
 * canvas plus an editor panel (side panel when wide, bottom sheet on phones). Save = PUT with
 * baseRev; host validation errors, 409 conflicts and network errors keep the draft.
 */
import './edit.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { findButton, parseConfig, type Config } from '../../core/config.ts';
import type { WireConfig } from '../../core/protocol.ts';
import type { Backend, Snapshot } from '../backend/types.ts';
import { useStore, type Store } from '../lib/store.ts';
import { Close, Warn } from '../ui/icons.tsx';
import { ButtonPanel, type Tab } from './ButtonPanel.tsx';
import { Canvas } from './Canvas.tsx';
import { Editor, stable } from './editor.ts';
import { Dialog, typingIn } from './fields.tsx';
import { Plus, Redo, Sliders, Undo } from './icons.tsx';
import { PadPanel } from './PadPanel.tsx';
import { nameOf, rectOf, refusal } from './ops.ts';
import { buttonFieldErrors, describe, padFieldErrors, toProblems, type Problem } from './problems.ts';

export interface EditModeProps {
  backend: Backend;
  /** Pad shown when edit mode was entered. */
  padId: string;
  /** Back to run mode, on the pad that was being edited. */
  onExit(padId?: string): void;
}

const WIDE = '(min-width: 900px), (min-width: 600px) and (orientation: landscape)';

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    f();
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

/** Admins get the full config; a redacted one (cached layout) has no actions to edit. */
const hasActions = (c: WireConfig): c is Config => c.pads.every((p) => p.buttons.every((b) => b.action !== undefined));

function waitFor<T>(store: Store<T>, ok: (v: T) => boolean, ms: number): Promise<T | null> {
  if (ok(store.get())) return Promise.resolve(store.get());
  return new Promise((resolve) => {
    const t = setTimeout(() => (off(), resolve(null)), ms);
    const off = store.subscribe((v) => ok(v) && (clearTimeout(t), off(), resolve(v)));
  });
}

export function EditMode(p: EditModeProps) {
  const role = useStore(p.backend.snapshot, (s) => s.role);
  const config = useStore(p.backend.snapshot, (s) => s.config);
  // Press-role clients never get any edit UI (the menu doesn't offer it either).
  if (role !== 'admin') return null;
  if (!config || !hasActions(config))
    return (
      <div class="ed-wait" data-testid="edit-wait">
        <p>Waiting for the host's full config…</p>
        <button type="button" class="bp-ghost" onClick={() => p.onExit()}>
          Back to the pad
        </button>
      </div>
    );
  return <Session {...p} />;
}

type Toast = { msg: string; tone?: 'bad'; action?: { label: string; run(): void }; at: number };
type Modal = 'leave' | 'discard' | 'delete-pad' | null;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function Session({ backend, padId, onExit }: EditModeProps) {
  const ed = useMemo(() => {
    const s = backend.snapshot.get();
    const cfg = s.config as Config;
    return new Editor(cfg, s.rev ?? '', Math.max(0, cfg.pads.findIndex((x) => x.id === padId)));
  }, []);
  const st = useStore(ed.store);
  const status = useStore(backend.snapshot, (s) => s.status);
  const hostRev = useStore(backend.snapshot, (s) => s.rev);
  const hostConfig = useStore(backend.snapshot, (s) => s.config) as Config;
  const fileErrors = useStore(backend.snapshot, (s) => s.configErrors);
  const wide = useMedia(WIDE);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('button');
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<{ ixs: number[]; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [hostErrors, setHostErrors] = useState<{ list: Problem[]; draft: Config } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ rev: string } | null>(null);
  const [hostChanged, setHostChanged] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const inFlight = useRef(false);
  /** Last host rev accounted for: only *changes* of the host config matter. */
  const seen = useRef(backend.snapshot.get().rev);

  const draft = st.draft;
  const pi = st.view.pad;
  const pad = draft.pads[pi]!;
  const sel = st.view.sel !== null && pad.buttons[st.view.sel] ? st.view.sel : null;
  const button = sel === null ? null : pad.buttons[sel]!;
  const dirty = useMemo(() => draft !== st.base && stable(draft) !== stable(st.base), [draft, st.base]);
  const clientProblems = useMemo(() => {
    const r = parseConfig(draft);
    return r.ok ? [] : toProblems(r.errors);
  }, [draft]);
  const problems = hostErrors?.draft === draft ? [...clientProblems, ...hostErrors.list] : clientProblems;
  const bad = useMemo(() => new Set(problems.filter((x) => x.pad === pi && x.button !== null).map((x) => x.button!)), [problems, pi]);
  const padsBad = new Set(problems.map((x) => x.pad));
  const full = pad.buttons.reduce((n, b) => n + b.w * b.h, 0) >= pad.cols * pad.rows;

  // ---- feedback ---------------------------------------------------------------------------

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (msg: string, extra: Partial<Toast> = {}) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, at: Date.now(), ...extra });
    toastTimer.current = setTimeout(() => setToast(null), extra.action ? 5000 : 3200);
  };
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blink = (ixs: number[]) => {
    clearTimeout(flashTimer.current);
    setFlash({ ixs, at: Date.now() });
    flashTimer.current = setTimeout(() => setFlash(null), 900);
  };
  useEffect(() => () => (clearTimeout(toastTimer.current), clearTimeout(flashTimer.current)), []);

  // ---- host config changes ----------------------------------------------------------------

  const adopt = (s: Snapshot) => {
    ed.reset(s.config as Config, s.rev!);
    seen.current = s.rev;
    setHostChanged(false);
    setHostErrors(null);
    setConflict(null);
  };
  const syncHost = () => {
    if (inFlight.current) return;
    const s = backend.snapshot.get();
    if (!s.rev || !s.config || s.rev === seen.current) return;
    seen.current = s.rev;
    // Our own save coming back.
    if (s.rev === ed.state.baseRev) return;
    if (!ed.dirty) adopt(s);
    else setHostChanged(true);
  };
  useEffect(syncHost, [hostRev]);

  // ---- save -------------------------------------------------------------------------------

  /** Steps through the problems, one per press (compact notice, status chip). */
  const nextProblem = useRef(0);
  const showNext = () => {
    if (!problems.length) return;
    goTo(problems[nextProblem.current++ % problems.length]);
    setShowProblems(true);
  };
  const goTo = (pr: Problem | undefined) => {
    if (!pr || pr.pad === null) return;
    if (pr.pad !== ed.state.view.pad) ed.showPad(pr.pad);
    if (pr.button !== null) {
      ed.select(pr.button);
      setTab(pr.field?.startsWith('action') ? 'action' : 'button');
      setSheetOpen(true);
    } else {
      ed.select(null);
      setPadOpen(true);
      setSheetOpen(true);
    }
  };

  const save = async (baseRev = ed.state.baseRev): Promise<boolean> => {
    if (inFlight.current) return false;
    const sent = ed.state.draft;
    const r = parseConfig(sent);
    if (!r.ok) {
      setShowProblems(true);
      goTo(toProblems(r.errors)[0]);
      return false;
    }
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    setHostErrors(null);
    const res = await backend.saveConfig(r.config, baseRev);
    inFlight.current = false;
    setSaving(false);
    if (res.ok) {
      ed.saved(sent, res.rev);
      setHostChanged(false);
      setConflict(null);
      setShowProblems(false);
      say('Saved: live on every device now');
    } else if (res.kind === 'conflict') setConflict({ rev: res.rev });
    else if (res.kind === 'invalid') {
      const list = toProblems(res.errors);
      setHostErrors({ list, draft: sent });
      setShowProblems(true);
      goTo(list[0]);
    } else setSaveError(res.message);
    syncHost();
    return res.ok;
  };

  const loadTheirs = async (rev?: string) => {
    const s = (rev ? await waitFor(backend.snapshot, (x) => x.rev === rev, 3000) : null) ?? backend.snapshot.get();
    adopt(s);
    setModal(null);
    say("Loaded the host's config");
  };

  // ---- view helpers -----------------------------------------------------------------------

  const open = (ix: number, added = false) => {
    ed.select(ix);
    // A new button wants its label first; otherwise stay on the tab in use (e.g. comparing runs).
    if (added) setTab('button');
    setPadOpen(false);
    setSheetOpen(true);
  };
  const deselect = () => {
    ed.select(null);
    setPadOpen(false);
    setSheetOpen(false);
    setSheetFull(false);
  };
  const showPadSettings = () => {
    ed.select(null);
    setPadOpen(true);
    setSheetOpen(true);
  };
  const exit = () => (dirty ? setModal('leave') : onExit(pad.id));

  const del = () => {
    const b = ed.removeButton();
    if (!b) return;
    const depth = ed.state.past.length;
    setSheetOpen(false);
    say(`Deleted ${nameOf(b)}`, { action: { label: 'Undo', run: () => ed.state.past.length === depth && ed.undo() } });
  };
  const dup = () => {
    const ni = ed.duplicate();
    if (ni === null) say('No room for a copy: make the grid bigger first', { tone: 'bad' });
    else blink([ni]);
  };
  const nudge = ([dx, dy]: [number, number], grow: boolean) => {
    if (sel === null || !button) return;
    const r = rectOf(button);
    const next = grow ? { ...r, w: r.w + dx, h: r.h + dy } : { ...r, x: r.x + dx, y: r.y + dy };
    if (next.w < 1 || next.h < 1) return blink([sel]);
    const f = ed.place(sel, next);
    if (!f.ok) {
      blink([sel]);
      say(`Can't ${grow ? 'resize' : 'move'} it: ${refusal(f, pad)}`, { tone: 'bad' });
    }
  };

  // ---- keyboard ---------------------------------------------------------------------------

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && k === 's') {
      e.preventDefault();
      if ((dirty || fileErrors) && !modal && !conflict) void save();
      return;
    }
    if (modal || conflict) return;
    if (typingIn(e.target)) {
      if (k === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (mod && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) ed.redo();
      else ed.undo();
      return;
    }
    if (mod || e.altKey) return;
    if (k === 'Escape') {
      if (sel !== null || padOpen || sheetOpen) (e.preventDefault(), deselect());
      return;
    }
    // Canvas keys: not while working a control in the panel.
    if (sel === null || (e.target instanceof Element && e.target.closest('.ed-panel, .ed-head'))) return;
    const d = ARROWS[k];
    if (d) {
      e.preventDefault();
      nudge(d, e.shiftKey);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      del();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Closing the tab with unsaved changes: the browser asks.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // A deleted/undone selection closes the button sheet.
  useEffect(() => {
    if (sel === null && !padOpen) setSheetOpen(false);
  }, [sel, padOpen]);

  // ---- render -----------------------------------------------------------------------------

  const panel: 'button' | 'pad' | null = button ? 'button' : padOpen || wide ? 'pad' : null;
  const showPanel = panel !== null && (wide || sheetOpen);
  const sheet = wide ? null : { full: sheetFull, onToggle: () => setSheetFull((f) => !f) };
  const hostButton = button ? findButton(hostConfig, pad.id, button.id) : undefined;
  const changed = !!button && (!hostButton || stable(hostButton) !== stable(button));
  const state = saving ? 'saving' : problems.length ? 'problems' : dirty ? 'dirty' : 'clean';
  const statusText = {
    saving: 'Saving…',
    problems: `${problems.length} problem${problems.length === 1 ? '' : 's'}`,
    dirty: wide ? 'Unsaved changes' : 'Unsaved',
    clean: 'All saved',
  }[state];

  const notices = (
    <>
      {status !== 'online' && (
        <div class="ed-notice is-warn" role="status" data-testid="notice-offline">
          <Warn />
          <span>
            <b>Not connected to the host.</b> Keep editing; save once it's back.
          </span>
        </div>
      )}
      {fileErrors && (
        <div class="ed-notice is-warn" role="status" data-testid="notice-file-errors">
          <Warn />
          <span>
            <b>The config file on the host has errors</b> (it still runs the previous config): {fileErrors[0]}
            {fileErrors.length > 1 ? ` (+${fileErrors.length - 1} more)` : ''}. Saving writes this config over the broken file.
          </span>
        </div>
      )}
      {hostChanged && !conflict && (
        <div class="ed-notice is-warn" role="status" data-testid="notice-host-changed">
          <Warn />
          <span>
            <b>The config changed on the host</b> (a hand edit of the file, or another admin). Your draft is based on the old one.
          </span>
          <div class="ed-notice-actions">
            <button type="button" class="ed-btn" data-testid="host-changed-load" onClick={() => void loadTheirs()}>
              Load theirs
            </button>
            <button type="button" class="ed-btn is-quiet" data-testid="host-changed-dismiss" onClick={() => setHostChanged(false)}>
              Keep mine
            </button>
          </div>
        </div>
      )}
      {saveError && (
        <div class="ed-notice is-bad" role="alert" data-testid="notice-save-error">
          <Warn />
          <span>
            <b>Couldn't save:</b> {saveError}. Your changes are still here.
          </span>
          <div class="ed-notice-actions">
            <button type="button" class="ed-btn" data-testid="save-retry" onClick={() => void save()}>
              Try again
            </button>
            <button type="button" class="ed-icon" aria-label="Dismiss" onClick={() => setSaveError(null)}>
              <Close />
            </button>
          </div>
        </div>
      )}
      {showProblems && problems.length > 0 && (
        <div class="ed-notice is-bad" role="alert" data-testid="notice-problems">
          <Warn />
          <div class="ed-problems">
            <b>
              {hostErrors?.draft === draft ? 'The host refused to save' : "Can't save yet"}: {problems.length} problem{problems.length === 1 ? '' : 's'}
            </b>
            {!wide && (
              <button type="button" class="ed-btn ed-problems-next" data-testid="problem-next" onClick={showNext}>
                Show{problems.length > 1 ? ' next' : ''}
              </button>
            )}
            <ul>
              {problems.slice(0, 4).map((x, i) => (
                <li key={i}>
                  <button type="button" class="ed-link" data-testid="problem-item" onClick={() => goTo(x)}>
                    {describe(x, draft)}
                  </button>
                </li>
              ))}
              {problems.length > 4 && <li class="ed-more">and {problems.length - 4} more</li>}
            </ul>
          </div>
          <button type="button" class="ed-icon" aria-label="Dismiss" onClick={() => setShowProblems(false)}>
            <Close />
          </button>
        </div>
      )}
    </>
  );

  return (
    <div class="bp-edit" data-testid="edit-mode" data-layout={wide ? 'wide' : 'narrow'} data-dirty={dirty ? '' : undefined} data-sheet={!wide && showPanel ? (sheetFull ? 'full' : 'half') : undefined}>
      <header class="ed-head">
        <button type="button" class="ed-icon ed-exit" aria-label="Close the editor" title="Back to the pad" data-testid="edit-close" onClick={exit}>
          <Close />
        </button>
        <div class="ed-title">
          <span class="ed-title-main">Edit</span>
          {dirty && !saving ? (
            <button
              type="button"
              class="ed-status"
              data-state={state}
              data-testid="edit-status"
              title={state === 'problems' ? 'Show the problem' : 'Discard changes…'}
              onClick={() => (state === 'problems' ? showNext() : setModal('discard'))}
            >
              <i />
              {statusText}
            </button>
          ) : (
            <span class="ed-status" data-state={state} data-testid="edit-status">
              <i />
              {statusText}
            </span>
          )}
        </div>
        <nav class="ed-pads" aria-label="Pads">
          <div class="ed-pads-scroll" role="tablist" data-scroll-x>
            {draft.pads.map((x, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                class="bp-tab ed-padtab"
                aria-selected={i === pi}
                data-testid={`edit-tab-${x.id}`}
                onClick={() => (i === pi ? showPadSettings() : (ed.showPad(i), setPadOpen(false), setSheetOpen(false)))}
              >
                {x.name.trim() || x.id}
                {padsBad.has(i) && <i class="ed-tab-bad" aria-label="has problems" />}
              </button>
            ))}
          </div>
          <button type="button" class="ed-icon ed-padbtn" aria-label="Add a pad" title="Add a pad" data-testid="edit-add-pad" onClick={() => (ed.addPad(), showPadSettings())}>
            <Plus />
          </button>
          <button type="button" class="ed-icon ed-padbtn" aria-label="Pad settings" title="Pad settings" data-testid="edit-pad-settings" aria-pressed={panel === 'pad' && showPanel} onClick={showPadSettings}>
            <Sliders />
          </button>
        </nav>
        <div class="ed-actions">
          {wide && dirty && (
            <button type="button" class="ed-btn is-quiet" data-testid="edit-discard" onClick={() => setModal('discard')}>
              Discard
            </button>
          )}
          <button type="button" class="ed-icon" aria-label="Undo" title="Undo (⌘Z)" data-testid="edit-undo" disabled={!st.past.length} onClick={() => ed.undo()}>
            <Undo />
          </button>
          <button type="button" class="ed-icon" aria-label="Redo" title="Redo (⇧⌘Z)" data-testid="edit-redo" disabled={!st.future.length} onClick={() => ed.redo()}>
            <Redo />
          </button>
          <button type="button" class="ed-save" data-testid="edit-save" disabled={!(dirty || fileErrors) || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <div class="ed-body">
        <div class="ed-stage">
          {notices}
          <Canvas
            ed={ed}
            pad={pad}
            sel={sel}
            bad={bad}
            flash={flash}
            emptyHint={`${wide ? 'Click' : 'Tap'} a square to add a button`}
            onOpen={open}
            onDeselect={deselect}
            onRefuse={(m) => say(m, { tone: 'bad' })}
          />
          {!wide && !showPanel && (
            <div class="ed-hintbar" data-testid="edit-hintbar">
              {button ? (
                <>
                  <span class="ed-dot" style={{ '--c': button.color }} />
                  <span class="ed-hintbar-name">{button.label.trim() || button.id}</span>
                  <button type="button" class="ed-btn is-primary" data-testid="hintbar-edit" onClick={() => open(sel!)}>
                    Edit
                  </button>
                </>
              ) : full ? (
                <>
                  <span class="ed-hintbar-text">No empty squares left for new buttons.</span>
                  <button type="button" class="ed-btn" data-testid="hintbar-add-row" disabled={pad.rows >= 12} onClick={() => ed.resizePad(pad.cols, pad.rows + 1)}>
                    <Plus /> Add a row
                  </button>
                </>
              ) : (
                <span class="ed-hintbar-text">
                  Tap <b>+</b> to add · drag to move · drag a corner to resize
                </span>
              )}
            </div>
          )}
        </div>
        {toast && (
          <div class={`ed-toast${toast.tone ? ` is-${toast.tone}` : ''}`} role="status" data-testid="toast" key={toast.at}>
            <span>{toast.msg}</span>
            {toast.action && (
              <button type="button" class="ed-toast-action" data-testid="toast-action" onClick={() => (toast.action!.run(), setToast(null))}>
                {toast.action.label}
              </button>
            )}
          </div>
        )}
        {showPanel && (
          <aside class={`ed-panel${wide ? '' : ' is-sheet'}`} data-testid={panel === 'button' ? 'button-editor' : 'pad-editor'} aria-label={panel === 'button' ? 'Button editor' : 'Pad settings'}>
            {panel === 'button' && button && sel !== null ? (
              <ButtonPanel
                key={`${pi}:${sel}`}
                ed={ed}
                backend={backend}
                pad={pad}
                ix={sel}
                b={button}
                errors={buttonFieldErrors(problems, pi, sel)}
                tab={tab}
                onTab={setTab}
                hostButton={hostButton}
                changed={changed}
                sheet={sheet}
                onClose={deselect}
                onDuplicate={dup}
                onDelete={del}
              />
            ) : (
              <PadPanel
                key={pi}
                ed={ed}
                pad={pad}
                index={pi}
                count={draft.pads.length}
                errors={padFieldErrors(problems, pi)}
                wide={wide}
                sheet={sheet}
                onClose={deselect}
                onDelete={() => setModal('delete-pad')}
                onAddButton={() => {
                  const ix = ed.addAnywhere();
                  if (ix !== null) open(ix, true);
                }}
                onBlocked={blink}
              />
            )}
          </aside>
        )}
      </div>

      {modal === 'leave' && (
        <Dialog
          title="Unsaved changes"
          testid="dialog-leave"
          onClose={() => setModal(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-primary" data-testid="leave-save" onClick={() => (setModal(null), void save().then((ok) => ok && onExit(pad.id)))}>
                Save and close
              </button>
              <button type="button" class="ed-btn is-danger" data-testid="leave-discard" onClick={() => onExit(pad.id)}>
                Discard changes
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="leave-cancel" onClick={() => setModal(null)}>
                Keep editing
              </button>
            </>
          }
        >
          Your edits aren't on the host yet. Save them, or throw them away?
        </Dialog>
      )}
      {modal === 'discard' && (
        <Dialog
          title="Discard all changes?"
          testid="dialog-discard"
          tone="danger"
          onClose={() => setModal(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-danger" data-testid="discard-confirm" onClick={() => (adopt(backend.snapshot.get()), setModal(null), deselect(), say('Changes discarded'))}>
                Discard changes
              </button>
              <button type="button" class="ed-btn is-quiet" onClick={() => setModal(null)}>
                Keep editing
              </button>
            </>
          }
        >
          Everything goes back to the config on the host. This can't be undone.
        </Dialog>
      )}
      {modal === 'delete-pad' && (
        <Dialog
          title={`Delete “${pad.name.trim() || pad.id}”?`}
          testid="dialog-delete-pad"
          tone="danger"
          onClose={() => setModal(null)}
          actions={
            <>
              <button
                type="button"
                class="ed-btn is-danger"
                data-testid="delete-pad-confirm"
                onClick={() => {
                  const name = pad.name.trim() || pad.id;
                  ed.removePad();
                  const depth = ed.state.past.length;
                  setModal(null);
                  say(`Deleted pad “${name}”`, { action: { label: 'Undo', run: () => ed.state.past.length === depth && ed.undo() } });
                }}
              >
                Delete pad
              </button>
              <button type="button" class="ed-btn is-quiet" onClick={() => setModal(null)}>
                Cancel
              </button>
            </>
          }
        >
          {pad.buttons.length ? `Its ${pad.buttons.length} button${pad.buttons.length === 1 ? '' : 's'} go with it. ` : ''}You can undo this until you save.
        </Dialog>
      )}
      {conflict && (
        <Dialog
          title="The config changed on the host"
          testid="dialog-conflict"
          tone="warn"
          onClose={() => setConflict(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-primary" data-testid="conflict-theirs" onClick={() => void loadTheirs(conflict.rev)}>
                Load theirs
              </button>
              <button type="button" class="ed-btn is-danger" data-testid="conflict-mine" onClick={() => void save(conflict.rev)}>
                Overwrite with mine
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="conflict-cancel" onClick={() => setConflict(null)}>
                Cancel
              </button>
            </>
          }
        >
          <p>
            Since you started editing, the config on the host was changed: someone edited the file by hand, or another admin saved. Saving now would replace their version.
          </p>
          <p>
            <b>Load theirs</b> throws away your draft and loads the host's config. <b>Overwrite with mine</b> saves your draft over theirs.
          </p>
        </Dialog>
      )}
    </div>
  );
}
