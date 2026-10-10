/**
 * Edit mode (admin only): a local draft of the whole config with undo/redo, edited on a WYSIWYG
 * canvas plus an editor panel (side panel when wide, bottom sheet on phones). Save = PUT with
 * baseRev; host validation errors, 409 conflicts and network errors keep the draft.
 *
 * Keeping in step with the host: a host config change under a draft with nothing unsaved is just
 * taken; under unsaved changes it is merged in (merge.ts: what changed on one side only merges by
 * itself, an undoable step; the rest the user resolves per item). This session's own saves coming
 * back over the socket (even late, even several) are not news. A save whose answer got lost is
 * recognized when the host's config turns out to be exactly what was sent. The draft is kept on the
 * device (draft-store.ts) until saved or discarded.
 */
import './edit.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buttonKey, findButton, parseConfig, type Button, type Config } from '../../core/config.ts';
import type { WireConfig } from '../../core/protocol.ts';
import type { Backend } from '../backend/types.ts';
import { wall } from '../lib/clock.ts';
import { useStore } from '../lib/store.ts';
import { Close, Warn } from '../ui/icons.tsx';
import { ButtonPanel, type Tab } from './ButtonPanel.tsx';
import { Canvas } from './Canvas.tsx';
import { BrokenFileDialog, ConflictDialog, MergeDialog, RestoreDialog, StopDialog } from './dialogs.tsx';
import { clearDraft, DraftKeeper, draftScope, loadDraft, unsavedEdits, type StoredDraft } from './draft-store.ts';
import { Editor, stable } from './editor.ts';
import { Dialog, typingIn } from './fields.tsx';
import { Plus, Redo, Sliders, Undo } from './icons.tsx';
import { merge3, type Conflict, type MergeResult, type Side } from './merge.ts';
import { PadPanel } from './PadPanel.tsx';
import type { RunAsk } from './RunLog.tsx';
import { nameOf, rectOf, refusal, same } from './ops.ts';
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

/** Compares configs as the host keeps them ($schema is the host's business). */
const keyOf = ({ $schema: _s, ...c }: WireConfig) => stable(c);
const problemCount = (c: Config) => {
  const r = parseConfig(c);
  return r.ok ? 0 : r.errors.length;
};

/** This session's own saves remembered (their echoes over the socket are not news). */
const OWN_MAX = 32;
/**
 * The host's state learned over HTTP (a save's answer, a fetch) the socket hasn't delivered yet:
 * what a lagging socket says until it gets there is older news. Waited for at most this long.
 */
const CATCH_UP_MS = 15_000;

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
export type Flash = { ixs: number[]; at: number; kind: 'refused' | 'added' };
type Modal = 'leave' | 'discard' | 'delete-pad' | null;
interface SaveOpts {
  /** Replace whatever is on the host (the user said so). */
  force?: boolean;
  /** The user agreed to stop the runs this save ends. */
  stopOk?: boolean;
  /** After it saved (save and close, save and run). */
  then?(): void;
  retried?: boolean;
}
type Ask = { kind: 'stop'; runs: { name: string; ms: number }[]; go(): void } | { kind: 'broken'; errors: string[]; go(): void };
interface Merging {
  theirs: Config;
  rev: string;
  conflicts: Conflict[];
  taken: number;
  choices: Record<string, Side>;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Canvas keys (arrows, Delete) act only with the focus on the canvas or nowhere: not on a notice's link, a toast's Undo… */
const onCanvas = (t: EventTarget | null) => t === document.body || t === document.documentElement || (t instanceof Element && !!t.closest('.ed-canvas'));

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
  const states = useStore(backend.snapshot, (s) => s.states);
  const wide = useMedia(WIDE);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('button');
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [saving, setSaving] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [hostErrors, setHostErrors] = useState<{ list: Problem[]; draft: Config } | null>(null);
  /** The host's warnings about the last save (`sent`: what was saved; problems index into it). */
  const [warnings, setWarnings] = useState<{ list: Problem[]; sent: Config; shown: boolean } | null>(null);
  /** "+N more" opened up: the file's errors, the problems list. */
  const [moreFile, setMoreFile] = useState(false);
  const [moreProblems, setMoreProblems] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ rev: string; again?: boolean; opts: SaveOpts } | null>(null);
  const [merging, setMerging] = useState<Merging | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  /** Run now / Save & run of a `confirm` button: asked here, over everything. */
  const [runAsk, setRunAsk] = useState<RunAsk | null>(null);
  /** The host's config as last known (socket or HTTP, own saves included). */
  const [hostNow, setHostNowState] = useState(() => ({ rev: backend.snapshot.get().rev ?? '', config: backend.snapshot.get().config as Config }));
  const hostNowRef = useRef(hostNow);
  const setHostNow = (v: { rev: string; config: Config }) => ((hostNowRef.current = v), setHostNowState(v));
  /** "Keep mine" for this host rev: no notice about it. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const inFlight = useRef(false);
  /** Last snapshot rev looked at: only *changes* of the host config matter. */
  const seen = useRef(backend.snapshot.get().rev);
  /** Revs of this session's saves, oldest first: their echoes over the socket (late, or several) are not news. */
  const own = useRef(new Set<string>());
  const addOwn = (rev: string) => {
    const o = own.current;
    o.delete(rev);
    o.add(rev);
    while (o.size > OWN_MAX) o.delete(o.values().next().value!);
  };
  /** Saves with no answer (timeout, dropped link): they may still turn up on the host. */
  const unsure = useRef<{ config: Config; key: string }[]>([]);
  /** Revs the socket delivered lately, newest last (seen as they come: renders may skip some). */
  const recent = useRef<string[]>(backend.snapshot.get().rev ? [backend.snapshot.get().rev!] : []);
  /** A rev learned over HTTP the socket hasn't delivered yet (see CATCH_UP_MS). */
  const catchUp = useRef<{ rev: string; reached: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () =>
      backend.snapshot.subscribe((s) => {
        const r = recent.current;
        if (!s.rev || r.at(-1) === s.rev) return;
        r.push(s.rev);
        if (r.length > 32) r.shift();
        if (catchUp.current?.rev === s.rev) catchUp.current.reached = true;
      }),
    [],
  );
  /** The host is at `rev` (we know it over HTTP): until the socket gets there, what it says is older. */
  const awaitSocket = (rev: string) => {
    clearTimeout(catchUp.current?.timer);
    catchUp.current = null;
    if (backend.snapshot.get().rev === rev || recent.current.includes(rev)) return;
    catchUp.current = {
      rev,
      reached: false,
      timer: setTimeout(() => {
        catchUp.current = null;
        syncHost();
      }, CATCH_UP_MS),
    };
  };

  // ---- the draft kept on this device ------------------------------------------------------

  const scope = draftScope(backend.kind);
  const [stored, setStored] = useState<StoredDraft | null>(() => {
    const d = loadDraft(scope);
    return d && stable(d.draft) !== stable(d.base) ? d : null;
  });
  const keeper = useMemo(() => new DraftKeeper(scope), []);
  /** Until the restore question is answered, the stored draft is left alone. */
  const keeping = useRef(!stored);
  useEffect(() => {
    const off = ed.store.subscribe(() => keeping.current && keeper.update(ed));
    return () => (off(), keeper.dispose(), clearTimeout(catchUp.current?.timer));
  }, []);

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
  /** The host's warnings from the last save about this draft button, by field, while what they're about is as saved. */
  const warningsFor = (b: Button): Map<string, string> => {
    const out = new Map<string, string>();
    for (const w of warnings?.list ?? []) {
      const sb = w.pad !== null && w.button !== null ? warnings!.sent.pads[w.pad]?.buttons[w.button] : undefined;
      if (!sb || !ed.sameThing(b, sb)) continue;
      const k = w.field ?? '';
      if ((k.startsWith('action') ? same(b.action, sb.action) : same(b, sb)) && !out.has(k)) out.set(k, w.message);
    }
    return out;
  };
  const warned = useMemo(() => new Set(pad.buttons.flatMap((b, i) => (warningsFor(b).size ? [i] : []))), [pad, warnings]);
  const full = pad.buttons.reduce((n, b) => n + b.w * b.h, 0) >= pad.cols * pad.rows;

  useEffect(() => unsavedEdits.set(dirty), [dirty]);
  useEffect(() => () => unsavedEdits.set(false), []);

  // ---- feedback ---------------------------------------------------------------------------

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (msg: string, extra: Partial<Toast> = {}) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, at: Date.now(), ...extra });
    toastTimer.current = setTimeout(() => setToast(null), extra.action ? 6000 : 3200);
  };
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Point at buttons: `refused` (red ring, a shake: that didn't work) or `added` (a calm glow: here it is). */
  const blink = (ixs: number[], kind: Flash['kind'] = 'refused') => {
    clearTimeout(flashTimer.current);
    setFlash({ ixs, at: Date.now(), kind });
    flashTimer.current = setTimeout(() => setFlash(null), 900);
  };
  useEffect(() => () => (clearTimeout(toastTimer.current), clearTimeout(flashTimer.current)), []);
  /** Toast with an Undo for the step just made. */
  const undoable = (msg: string) => {
    const depth = ed.state.past.length;
    say(msg, { action: { label: 'Undo', run: () => ed.state.past.length === depth && ed.undo() } });
  };

  // ---- the host's config ------------------------------------------------------------------

  /** Our save is on the host as `rev` (its answer, or found there). */
  const landed = (sent: Config, rev: string) => {
    addOwn(rev);
    awaitSocket(rev);
    unsure.current = [];
    setHostNow({ rev, config: sent });
    ed.saved(sent, rev);
    setSaveError(null);
    setConflict(null);
    setShowProblems(false);
  };

  /** Fresh news over HTTP (the socket may be behind it). */
  const learn = (config: Config, rev: string) => {
    awaitSocket(rev);
    setHostNow({ rev, config });
  };

  /** The host's config now, over HTTP. If the socket brought news meanwhile, ask once more: which is newer can't be told. */
  const fetchHost = async () => {
    for (let i = 0; ; i++) {
      const before = backend.snapshot.get().rev;
      const got = await backend.getConfig();
      const after = backend.snapshot.get().rev;
      if (i > 0 || after === before || after === got.rev) return got;
    }
  };

  const applyMerge = (res: MergeResult, theirs: Config, rev: string) => {
    const before = problemCount(ed.state.draft);
    ed.applyMerge(res, theirs, rev);
    setMerging(null);
    setDismissed(null);
    const n = res.taken;
    // Both sides fine on their own can still clash (two new buttons on one square): say so.
    const added = problemCount(res.config) - before;
    undoable(
      (n ? `Merged ${n} change${n === 1 ? '' : 's'} from the host` : "Your draft is now based on the host's latest config") +
        (added > 0 ? `: ${added} problem${added === 1 ? '' : 's'} to fix` : ''),
    );
  };

  /** The host's config is `theirs` now, and it's news: follow it, or merge it into unsaved changes. */
  const hostChanged = (theirs: Config, rev: string) => {
    setHostErrors(null);
    // The host's warnings were about what we saved: someone else's config now.
    setWarnings(null);
    if (!ed.dirty) {
      ed.reset(theirs, rev);
      return;
    }
    const res = merge3(ed.state.base, ed.state.draft, theirs, { origins: ed.origins() });
    // Conflicts wait for the user (the notice); the rest merges by itself.
    if (!res.conflicts.length) applyMerge(res, theirs, rev);
  };

  /** A config we sent (its answer lost) that turned up on the host. */
  const ours = (cfg: WireConfig) => {
    const k = keyOf(cfg);
    return unsure.current.find((u) => u.key === k);
  };

  /** A dialog is up: host changes wait until it's closed. A ref: timers and async steps call syncHost too. */
  const dialogUp = useRef(false);
  dialogUp.current = !!(merging || conflict || ask || stored);
  const busy = () => inFlight.current || dialogUp.current;
  const syncHost = () => {
    if (busy()) return; // decided once that is over
    const s = backend.snapshot.get();
    if (!s.rev || !s.config || !hasActions(s.config) || s.rev === seen.current) return;
    const c = catchUp.current;
    if (c) {
      if (!c.reached) return; // the socket hasn't got to what we know over HTTP yet: what it says is older
      clearTimeout(c.timer);
      catchUp.current = null;
    }
    seen.current = s.rev;
    // In step, or our own save coming back (late, or one of several).
    if (s.rev === ed.state.baseRev || own.current.has(s.rev)) return;
    const mine = ours(s.config);
    if (mine) {
      landed(mine.config, s.rev);
      say('Saved: live on every device now');
      return;
    }
    setHostNow({ rev: s.rev, config: s.config });
    hostChanged(s.config, s.rev);
  };
  useEffect(syncHost, [hostRev, !!merging, !!conflict, !!ask, !!stored, saving]);

  /** Merge the host's config, fetched fresh (the last broadcast may lag): at once if nothing conflicts. */
  const startMerge = async () => {
    let got: { config: WireConfig; rev: string };
    try {
      got = await fetchHost();
    } catch (e) {
      say(`Couldn't get the host's config: ${e instanceof Error ? e.message : String(e)}`, { tone: 'bad' });
      return;
    }
    if (!hasActions(got.config)) return;
    learn(got.config, got.rev);
    const mine = ours(got.config);
    if (mine) return void (landed(mine.config, got.rev), say('Saved: live on every device now'));
    if (got.rev === ed.state.baseRev) return say("Nothing to merge: your draft is based on the host's config");
    const res = merge3(ed.state.base, ed.state.draft, got.config, { origins: ed.origins() });
    if (!res.conflicts.length) return applyMerge(res, got.config, got.rev);
    setMerging({ theirs: got.config, rev: got.rev, conflicts: res.conflicts, taken: res.taken, choices: {} });
  };

  /** While behind the host: what a merge would do (for the notice). */
  const behind = hostNow.rev !== '' && hostNow.rev !== st.baseRev && hostNow.rev !== dismissed && !!hostNow.config && hasActions(hostNow.config);
  const preview = useMemo(() => (behind ? merge3(st.base, draft, hostNow.config, { origins: ed.origins() }) : null), [behind, st.base, draft, hostNow]);

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
      setTab(pr.field?.startsWith('action') || pr.field?.startsWith('stops') ? 'action' : 'button');
      setSheetOpen(true);
    } else {
      ed.select(null);
      setPadOpen(true);
      setSheetOpen(true);
    }
  };

  /** A problem about `warnings.sent` (the config as saved): to that pad and button in the draft, wherever they are now. */
  const goToSent = (w: Problem) => {
    const sp = w.pad === null ? undefined : warnings?.sent.pads[w.pad];
    const sb = sp && w.button !== null ? sp.buttons[w.button] : undefined;
    const d = ed.state.draft;
    const at = sp ? d.pads.findIndex((x) => ed.sameThing(x, sp)) : -1;
    const bi = at >= 0 && sb ? d.pads[at]!.buttons.findIndex((x) => ed.sameThing(x, sb)) : -1;
    if (at >= 0) goTo({ ...w, pad: at, button: bi >= 0 ? bi : null });
  };

  /** Running buttons this config would end: deleted, or their pad's or their own id changed. */
  const wouldStop = (next: Config) => {
    const s = backend.snapshot.get();
    const out: { name: string; ms: number }[] = [];
    for (const [key, rs] of Object.entries(s.states)) {
      if (rs.phase !== 'running') continue;
      const [p, b] = key.split('/') as [string, string];
      if (findButton(next, p, b)) continue;
      const hb = s.config && findButton(s.config as Config, p, b);
      out.push({ name: hb ? nameOf(hb) : b, ms: wall() - (rs.startedAt + s.clockSkew) });
    }
    return out;
  };

  /** Did a save of ours land after all? Asks the host. 'sent': this one; 'older': an earlier one whose answer was lost. */
  const check = async (sent: Config): Promise<'sent' | 'older' | null> => {
    let got: { config: WireConfig; rev: string };
    try {
      got = await fetchHost();
    } catch {
      return null;
    }
    if (!hasActions(got.config)) return null;
    if (keyOf(got.config) === keyOf(sent)) return landed(sent, got.rev), 'sent';
    const older = ours(got.config);
    if (older) return landed(older.config, got.rev), 'older';
    learn(got.config, got.rev);
    return null;
  };

  const save = async (o: SaveOpts = {}): Promise<boolean> => {
    if (inFlight.current) return false;
    // Exactly what the host will keep (trimmed labels and names): or the host's copy would differ from ours.
    ed.tidy();
    const sent = ed.state.draft;
    const r = parseConfig(sent);
    if (!r.ok) {
      setShowProblems(true);
      goTo(toProblems(r.errors)[0]);
      return false;
    }
    // Deleting or renaming a running button ends its run: say so first.
    const runs = o.stopOk ? [] : wouldStop(r.config);
    if (runs.length) return setAsk({ kind: 'stop', runs, go: () => void save({ ...o, stopOk: true }) }), false;
    // A broken file on the host may be someone's edit in progress: replace it only when told to.
    const broken = backend.snapshot.get().configErrors;
    if (broken && !o.force) return setAsk({ kind: 'broken', errors: broken, go: () => void save({ ...o, force: true }) }), false;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    setHostErrors(null);
    let ok = false;
    let again = false;
    let warned = 0;
    try {
      const res = await backend.saveConfig(r.config, ed.state.baseRev, { force: o.force });
      if (res.ok) {
        landed(sent, res.rev);
        ok = true;
        warned = res.warnings?.length ?? 0;
        setWarnings(warned ? { list: toProblems(res.warnings!, sent), sent, shown: true } : null);
      } else if (res.kind === 'invalid') {
        const list = toProblems(res.errors, sent);
        setHostErrors({ list, draft: sent });
        setShowProblems(true);
        goTo(list[0]);
      } else if (res.kind === 'conflict') {
        if (res.invalid) setAsk({ kind: 'broken', errors: res.errors ?? [], go: () => void save({ ...o, force: true }) });
        else {
          // It may be our own earlier save, its answer lost on the way.
          const c = await check(sent);
          if (c === 'sent') ok = true;
          else if (c === 'older' && !o.retried) again = true;
          else setConflict({ rev: res.rev, opts: o });
        }
      } else {
        if (res.unsure) unsure.current = [...unsure.current.slice(-4), { config: sent, key: keyOf(sent) }];
        if (res.unsure && (await check(sent)) === 'sent') ok = true;
        else setSaveError(res.message);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
    if (again) return save({ ...o, retried: true });
    if (ok) {
      say(warned ? `Saved, with ${warned} warning${warned === 1 ? '' : 's'} from the host` : 'Saved: live on every device now');
      o.then?.();
    }
    return ok;
  };

  /** "Overwrite with mine": unless it changed yet again meanwhile (then say so). */
  const overwrite = async (c: { rev: string; opts: SaveOpts }) => {
    setConflict(null);
    try {
      const now = await fetchHost();
      if (now.rev !== c.rev && !own.current.has(now.rev)) return setConflict({ rev: now.rev, again: true, opts: c.opts });
    } catch {
      /* can't tell: the save says */
    }
    void save({ ...c.opts, force: true });
  };

  const discardDraft = async () => {
    setModal(null);
    let to = { config: hostNowRef.current.config, rev: hostNowRef.current.rev };
    try {
      const got = await fetchHost();
      if (hasActions(got.config)) (learn(got.config, got.rev), (to = { config: got.config, rev: got.rev }));
    } catch {
      /* offline: back to the last known host config */
    }
    ed.discard(to.config, to.rev);
    // A save of the thrown-away draft turning up later is news then, not "saved".
    unsure.current = [];
    setHostErrors(null);
    setSaveError(null);
    setWarnings(null);
    deselect();
    undoable('Changes discarded');
  };

  const restoreDraft = () => {
    const d = stored;
    if (!d) return;
    ed.restore(d);
    keeping.current = true;
    setStored(null);
    say('Restored your unsaved changes');
    const s = backend.snapshot.get();
    // Merged with the host's config as it is now, like any change on the host.
    if (s.rev && s.config && hasActions(s.config) && s.rev !== d.baseRev) hostChanged(s.config, s.rev);
    keeper.update(ed);
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
  const saveAndClose = async () => {
    setModal(null);
    // A save still on its way first.
    while (inFlight.current) await new Promise((r) => setTimeout(r, 100));
    if (!ed.dirty) return onExit(ed.pad.id);
    void save({ then: () => onExit(ed.pad.id) });
  };

  const del = () => {
    const b = ed.removeButton();
    if (!b) return;
    setSheetOpen(false);
    undoable(`Deleted ${nameOf(b)}`);
  };
  const dup = () => {
    const ni = ed.duplicate();
    if (ni === null) say('No room for a copy: make the grid bigger first', { tone: 'bad' });
    else blink([ni], 'added');
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

  const dialogOpen = !!(modal || conflict || merging || ask || stored || runAsk);

  // ---- keyboard ---------------------------------------------------------------------------

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && k === 's') {
      e.preventDefault();
      if ((dirty || fileErrors) && !dialogOpen) void save();
      return;
    }
    if (dialogOpen) return;
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
    // Canvas keys: only with the focus on the canvas (or nowhere), not on a control elsewhere.
    if (sel === null || !onCanvas(e.target)) return;
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

  // Closing the tab with unsaved changes: the browser asks (the draft is kept on the device anyway).
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

  /** Buttons of this pad running on the host (by the host's ids: the draft may have changed them). */
  const running = useMemo(() => {
    const out = new Set<number>();
    const bp = ed.baseOf(pad);
    pad.buttons.forEach((b, i) => {
      const bb = bp && ed.baseOf(b, pad);
      if (states[buttonKey(bb ? bp.id : pad.id, bb ? bb.id : b.id)]?.phase === 'running') out.add(i);
    });
    return out;
  }, [pad, states, st.base]);

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
  const overlap = preview?.conflicts.length ?? 0;

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
            {fileErrors.length > 1 && !moreFile && (
              <>
                {' '}
                <button type="button" class="ed-link is-inline" data-testid="file-errors-more" onClick={() => setMoreFile(true)}>
                  +{fileErrors.length - 1} more
                </button>
              </>
            )}
            . Someone may be editing it right now: saving asks before it replaces the file.
            {moreFile && fileErrors.length > 1 && (
              <ul class="ed-errlist" data-testid="file-errors-list">
                {fileErrors.slice(1).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </span>
        </div>
      )}
      {behind && !conflict && !merging && (
        <div class="ed-notice is-warn" role="status" data-testid="notice-host-changed">
          <Warn />
          <span>
            <b>The config changed on the host</b> (a hand edit of the file, or another admin).{' '}
            {overlap ? `${overlap} of its changes ${overlap === 1 ? 'is' : 'are'} also changed in your draft.` : 'Your draft is based on the old one.'}
          </span>
          <div class="ed-notice-actions">
            <button type="button" class="ed-btn" data-testid="host-changed-merge" onClick={() => void startMerge()}>
              {overlap ? 'Review and merge…' : 'Merge their changes'}
            </button>
            <button type="button" class="ed-btn is-quiet" data-testid="host-changed-dismiss" onClick={() => setDismissed(hostNow.rev)}>
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
              {(moreProblems ? problems : problems.slice(0, 4)).map((x, i) => (
                <li key={i}>
                  <button type="button" class="ed-link" data-testid="problem-item" onClick={() => goTo(x)}>
                    {describe(x, draft)}
                  </button>
                </li>
              ))}
            </ul>
            {wide && problems.length > 4 && (
              <button type="button" class="ed-link ed-more" data-testid="problems-more" aria-expanded={moreProblems} onClick={() => setMoreProblems((m) => !m)}>
                {moreProblems ? 'Show fewer' : `and ${problems.length - 4} more: show all`}
              </button>
            )}
          </div>
          <button type="button" class="ed-icon" aria-label="Dismiss" onClick={() => setShowProblems(false)}>
            <Close />
          </button>
        </div>
      )}
      {warnings?.shown && (
        <div class="ed-notice is-warn" role="status" data-testid="notice-warnings">
          <Warn />
          <div class="ed-problems is-all">
            <b>
              Saved, but the host warns about {warnings.list.length === 1 ? 'this' : `${warnings.list.length} things`}:
            </b>
            <ul>
              {warnings.list.map((w, i) => (
                <li key={i}>
                  {w.button !== null ? (
                    <button type="button" class="ed-link" data-testid="warning-item" onClick={() => goToSent(w)}>
                      {describe(w, warnings.sent)}
                    </button>
                  ) : (
                    <span data-testid="warning-item">{describe(w, warnings.sent)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <button type="button" class="ed-icon" aria-label="Dismiss" data-testid="warnings-dismiss" onClick={() => setWarnings({ ...warnings, shown: false })}>
            <Close />
          </button>
        </div>
      )}
    </>
  );

  const discardBtn = dirty && (
    <button type="button" class="ed-btn is-quiet ed-discard" data-testid="edit-discard" onClick={() => setModal('discard')}>
      Discard
    </button>
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
          {/* Phones: right here, not tucked away in the status chip. */}
          {!wide && discardBtn}
        </nav>
        <div class="ed-actions">
          {wide && discardBtn}
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
            warned={warned}
            running={running}
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
                  Tap <b>+</b> to add · drag to move · corner resizes
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
                pads={draft.pads}
                pi={pi}
                pad={pad}
                ix={sel}
                b={button}
                errors={buttonFieldErrors(problems, pi, sel)}
                warnings={warningsFor(button)}
                tab={tab}
                onTab={setTab}
                hostButton={hostButton}
                changed={changed}
                running={running.has(sel)}
                saving={saving}
                onSaveAndRun={(run) => void save({ then: run })}
                onAsk={setRunAsk}
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
              <button type="button" class="ed-btn is-primary" data-testid="leave-save" onClick={() => void saveAndClose()}>
                Save and close
              </button>
              <button type="button" class="ed-btn is-danger" data-testid="leave-discard" onClick={() => (keeper.forget(), onExit(pad.id))}>
                Discard changes
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="leave-cancel" data-autofocus onClick={() => setModal(null)}>
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
              <button type="button" class="ed-btn is-danger" data-testid="discard-confirm" onClick={() => void discardDraft()}>
                Discard changes
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="discard-cancel" data-autofocus onClick={() => setModal(null)}>
                Keep editing
              </button>
            </>
          }
        >
          Everything goes back to the config on the host. Undo brings your changes back, until you leave the editor.
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
                  setModal(null);
                  undoable(`Deleted pad “${name}”`);
                }}
              >
                Delete pad
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="delete-pad-cancel" data-autofocus onClick={() => setModal(null)}>
                Cancel
              </button>
            </>
          }
        >
          {pad.buttons.length ? `Its ${pad.buttons.length} button${pad.buttons.length === 1 ? '' : 's'} go with it. ` : ''}You can undo this until you save.
        </Dialog>
      )}
      {runAsk && (
        <Dialog
          title={runAsk.title}
          testid="dialog-run-confirm"
          tone="danger"
          onClose={() => setRunAsk(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-danger" data-testid="run-confirm-yes" onClick={() => (setRunAsk(null), runAsk.go())}>
                {runAsk.yes}
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="run-confirm-no" data-autofocus onClick={() => setRunAsk(null)}>
                Cancel
              </button>
            </>
          }
        >
          <p>{runAsk.body}</p>
        </Dialog>
      )}
      {conflict && <ConflictDialog again={!!conflict.again} onMerge={() => (setConflict(null), void startMerge())} onOverwrite={() => void overwrite(conflict)} onCancel={() => setConflict(null)} />}
      {merging && (
        <MergeDialog
          conflicts={merging.conflicts}
          taken={merging.taken}
          choices={merging.choices}
          onChoose={(key, side) => setMerging({ ...merging, choices: { ...merging.choices, [key]: side } })}
          onApply={() => applyMerge(merge3(ed.state.base, ed.state.draft, merging.theirs, { origins: ed.origins(), choices: merging.choices }), merging.theirs, merging.rev)}
          onCancel={() => setMerging(null)}
        />
      )}
      {ask?.kind === 'stop' && <StopDialog runs={ask.runs} onSave={() => (setAsk(null), ask.go())} onCancel={() => setAsk(null)} />}
      {ask?.kind === 'broken' && <BrokenFileDialog errors={ask.errors} onSave={() => (setAsk(null), ask.go())} onCancel={() => setAsk(null)} />}
      {stored && (
        <RestoreDialog
          savedAt={stored.savedAt}
          onRestore={restoreDraft}
          onDiscard={() => {
            clearDraft(scope);
            keeping.current = true;
            setStored(null);
          }}
        />
      )}
    </div>
  );
}
