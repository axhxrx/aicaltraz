/** App shell: picks the backend, then routes between pairing / rejected / connecting / pad. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Role, WirePad } from '../core/protocol.ts';
import { DemoBackend } from './backend/demo.ts';
import type { Backend } from './backend/types.ts';
import { WsBackend } from './backend/ws.ts';
import { Gallery } from './dev/Gallery.tsx';
import { when } from './edit/dialogs.tsx';
import { draftScope, loadDraft, unsavedEdits } from './edit/draft-store.ts';
import { EditMode } from './edit/EditMode.tsx';
import { Dialog } from './edit/fields.tsx';
import { stable } from './edit/ops.ts';
import { loadFallbackToken, loadToken, mono, readHashToken, saveFallbackToken, saveToken, takeIncomingToken, type AppOptions } from './lib/env.ts';
import { startKeepAwake } from './lib/keepawake.ts';
import { clearPairHash, probeToken, readPairHash } from './lib/pairing.ts';
import { KEYS, lsGet, lsSet, settings, storageBlocked } from './lib/settings.ts';
import { useStore } from './lib/store.ts';
import { RunPad } from './run/RunPad.tsx';
import { RunSession } from './run/session.ts';
import { MenuSheet } from './ui/Menu.tsx';
import { Close } from './ui/icons.tsx';
import { CheckingScreen, ConnectingScreen, MissingPadScreen, OriginAdvice, PairCodeScreen, PairingScreen, RejectedScreen } from './ui/Screens.tsx';
import { TopBar } from './ui/TopBar.tsx';

declare global {
  interface Window {
    /** Debug/test handle. */
    __buttpad?: { backend: Backend };
  }
}

/** What a pasted token (or link) did: null when it is in use now, else why not, in words. */
export type PasteResult = Promise<string | null>;

const REJECTED_PASTE = 'The host rejected that token: check the link for a typo, or get a new one from the host.';

/** Leaving the editor on a pad the host has yet to send: how long to wait for it to come. */
const LANDING_MS = 10_000;

/**
 * The token to start with. A `#token=` link (stripped from the address bar already) that would
 * replace a token this device has is tried on the host first (`check`); with none stored, it is
 * simply taken.
 */
function bootToken(): { token: string | null; check: string | null } {
  const incoming = takeIncomingToken();
  const stored = loadToken();
  if (!incoming || incoming === stored) return { token: stored, check: null };
  if (stored) return { token: stored, check: incoming };
  saveToken(incoming);
  return { token: incoming, check: null };
}

export function App({ opts }: { opts: AppOptions }) {
  const off = opts.demo || opts.gallery;
  const [boot] = useState(() => (off ? { token: null, check: null } : bootToken()));
  const [token, setToken] = useState<string | null>(boot.token);
  // Bumped to rebuild the backend (retry with the same token, or a new pairing).
  const [gen, setGen] = useState(0);
  /** A new token from a link, tried on the host before it replaces the one in use. */
  const [checking, setChecking] = useState<string | null>(boot.check);
  /** A link's token was rejected (or a new token turned out rejected): this device stayed paired as before. */
  const [kept, setKept] = useState(false);
  /** The pairing-code entry: a `#pair` link, "Pair with a code…", "Unlock editing…". */
  const [codeEntry, setCodeEntry] = useState<{ code: string } | null>(() => {
    const p = off ? null : readPairHash();
    if (p) clearPairHash();
    return p;
  });
  /** Just paired by code (as this role): a note says what the device can do now. */
  const [paired, setPaired] = useState<Role | null>(null);
  /** Trying the token this device had before, after the new one was rejected. */
  const [recovering, setRecovering] = useState(false);
  const backend = useMemo<Backend | null>(() => {
    if (opts.gallery) return null;
    if (opts.demo) return new DemoBackend({ exact: opts.exact });
    return token ? new WsBackend(token) : null;
  }, [token, gen]);

  useEffect(() => {
    if (backend) window.__buttpad = { backend };
    return () => backend?.dispose();
  }, [backend]);
  // The notes about pairing go by themselves (they sit over the bottom row of buttons).
  useEffect(() => {
    if (!kept) return;
    const t = setTimeout(() => setKept(false), 12_000);
    return () => clearTimeout(t);
  }, [kept]);
  useEffect(() => {
    if (!paired) return;
    const t = setTimeout(() => setPaired(null), 8000);
    return () => clearTimeout(t);
  }, [paired]);

  /** A pairing link opened while the editor has unsaved changes: asked first. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  /**
   * Use token `t` from now on. `fallback`: the token in use until now, kept until the host has
   * taken `t` (it couldn't be asked first): if it turns `t` down, this device goes back to it.
   */
  const adopt = (t: string, fallback: string | null = null) => {
    // The cached layout belongs to the old pairing (it may be another host).
    if (t !== token) lsSet(KEYS.configCache, null);
    saveToken(t);
    saveFallbackToken(fallback && fallback !== t ? fallback : null);
    setKept(false);
    setToken(t);
    setGen((g) => g + 1);
  };
  const tokenWorks = () => !!backend && backend.snapshot.get().status !== 'unauthorized';

  // A link's token, tried first: rejected, this device stays paired as it was (and says so).
  useEffect(() => {
    const t = checking;
    if (!t) return;
    let live = true;
    void probeToken(t).then((r) => {
      if (!live) return;
      setChecking(null);
      if (r === 'rejected') return setKept(true);
      // No answer either way (a flaky link): take it, but keep the old one to go back to.
      adopt(t, r === 'unreachable' && tokenWorks() ? token : null);
    });
    return () => void (live = false);
  }, [checking]);

  // A token taken without asking the host first: once it says hello, the old one is history; if it
  // is turned down, the old one is tried (and used, if the host still takes it).
  useEffect(() => {
    if (!backend || backend.kind !== 'ws') return;
    const check = (status: string) => {
      const fb = loadFallbackToken();
      if (!fb) return;
      if (status === 'online') return saveFallbackToken(null);
      if (status !== 'unauthorized') return;
      saveFallbackToken(null);
      setRecovering(true);
      void probeToken(fb).then((r) => {
        setRecovering(false);
        if (r !== 'ok') return;
        adopt(fb);
        setKept(true);
      });
    };
    check(backend.snapshot.get().status);
    return backend.snapshot.subscribe((s) => check(s.status));
  }, [backend]);

  // Opening another pairing link in this tab only changes the hash.
  useEffect(() => {
    const onHash = () => {
      if (off) return;
      const code = readPairHash();
      if (code) {
        clearPairHash();
        return setCodeEntry(code);
      }
      const t = readHashToken();
      if (!t || t === token) return;
      setCodeEntry(null);
      // The draft is kept on the device either way, but leaving it deserves a question.
      if (unsavedEdits.get()) setSwitchTo(t);
      else if (token) setChecking(t);
      else adopt(t);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [token, backend]);

  if (opts.gallery) return <Gallery />;
  /** A token pasted on the pairing (or rejected) screen: used if the host takes it, else the field says why. */
  const paste = async (t: string): PasteResult => {
    if (t === token) {
      setGen((g) => g + 1);
      return null;
    }
    const r = await probeToken(t);
    if (r === 'rejected') return REJECTED_PASTE;
    adopt(t, r === 'unreachable' && tokenWorks() ? token : null);
    return null;
  };
  const forget = () => {
    lsSet(KEYS.configCache, null);
    saveToken(null);
    saveFallbackToken(null);
    setToken(null);
  };
  const code = codeEntry && (
    <PairCodeScreen
      initial={codeEntry.code}
      paired={!!backend}
      onCancel={() => setCodeEntry(null)}
      onPaired={(t, role) => {
        setCodeEntry(null);
        adopt(t);
        setPaired(role);
      }}
    />
  );
  /** The code entry; with a code (typed into the pairing-link box), tried at once. */
  const openCode = (c = '') => setCodeEntry({ code: c });
  if (checking) return <CheckingScreen />;
  if (!backend) return code || <PairingScreen onToken={paste} onCode={openCode} />;
  return (
    <>
      <Connected
        key={gen}
        backend={backend}
        opts={opts}
        onPair={paste}
        onCode={openCode}
        onForget={forget}
        onRetry={() => setGen((g) => g + 1)}
        recovering={recovering || !!loadFallbackToken()}
        kept={kept}
        onHideKept={() => setKept(false)}
        paired={paired}
        onHidePaired={() => setPaired(null)}
      />
      {code}
      {switchTo && (
        <Dialog
          title="Open the new pairing link?"
          testid="dialog-switch"
          tone="warn"
          onClose={() => setSwitchTo(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-danger" data-testid="switch-yes" onClick={() => (setSwitchTo(null), setChecking(switchTo))}>
                Open it
              </button>
              <button type="button" class="ed-btn is-quiet" data-testid="switch-no" data-autofocus onClick={() => setSwitchTo(null)}>
                Stay in the editor
              </button>
            </>
          }
        >
          You have unsaved changes in the editor. Opening the link leaves it; your changes stay on this device, and the editor offers them back the next time you open
          it for this host.
        </Dialog>
      )}
    </>
  );
}

/**
 * Which pad to show. `param`: the link's `?pad=` (an id or a name, any case). `id`: one picked from
 * the tabs, or remembered on this device. `first`: `?lock` without `?pad` (never the remembered one).
 */
type PadChoice = { kind: 'param'; q: string } | { kind: 'id'; id: string } | { kind: 'first' };

const byName = (pads: WirePad[], name: string) => pads.find((x) => x.name.toLowerCase() === name.toLowerCase());
function byParam(pads: WirePad[], q: string): WirePad | undefined {
  const lc = q.toLowerCase();
  return pads.find((x) => x.id === q) ?? pads.find((x) => x.id.toLowerCase() === lc) ?? byName(pads, q);
}

/**
 * The pad to show, or the name of the one that isn't there any more. A pad that was on screen and
 * went away (deleted, or renamed: id and name both changed) is never silently replaced by another:
 * a kiosk that became another pad's remote is worse than one that says so.
 */
function resolvePad(pads: WirePad[], choice: PadChoice, shown: { id: string; name: string } | null): WirePad | string {
  // The link names it; failing that, the pad it showed (same id: renamed, still the same pad).
  if (choice.kind === 'param') return byParam(pads, choice.q) ?? (shown && pads.find((x) => x.id === shown.id)) ?? choice.q;
  // Nothing shown yet: a remembered pad that's gone is just a stale preference.
  if (!shown) return (choice.kind === 'id' && pads.find((x) => x.id === choice.id)) || pads[0]!;
  // Its id changed but its name didn't: the same pad, renamed.
  return pads.find((x) => x.id === shown.id) ?? byName(pads, shown.name) ?? shown.name;
}

function Connected(p: {
  backend: Backend;
  opts: AppOptions;
  onPair(t: string): PasteResult;
  /** Open the pairing-code entry (with a code: tried at once). */
  onCode(code?: string): void;
  onForget(): void;
  onRetry(): void;
  /** The token in use was rejected and the one this device had before is being tried: not "rejected" yet. */
  recovering: boolean;
  /** A link's token was rejected; still paired as before. */
  kept: boolean;
  onHideKept(): void;
  /** Just paired by a code, as this role. */
  paired: Role | null;
  onHidePaired(): void;
}) {
  const { backend, opts } = p;
  const status = useStore(backend.snapshot, (s) => s.status);
  const config = useStore(backend.snapshot, (s) => s.config);
  const role = useStore(backend.snapshot, (s) => s.role);
  const configErrors = useStore(backend.snapshot, (s) => s.configErrors);
  const hostFull = useStore(backend.snapshot, (s) => s.hostFull);
  const originRefused = useStore(backend.snapshot, (s) => s.originRefused);
  const allowOrigin = useStore(backend.snapshot, (s) => s.allowOrigin);
  const syncing = useStore(backend.snapshot, (s) => s.syncing);
  const show = useStore(settings, (s) => s.show);
  const [choice, setChoice] = useState<PadChoice>(() =>
    opts.pad ? { kind: 'param', q: opts.pad } : opts.lock ? { kind: 'first' } : { kind: 'id', id: lsGet(KEYS.pad) ?? '' },
  );
  const shown = useRef<{ id: string; name: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<'run' | 'edit'>('run');
  const [hideKept, setHideKept] = useState(false);
  const [hideStorage, setHideStorage] = useState(false);
  // One per backend: every button's controller lives here, whichever pad is on screen.
  const session = useMemo(() => new RunSession(backend), [backend]);
  useEffect(() => () => session.dispose(), [session]);
  const marks = useStore(session.marks);
  const toast = useStore(session.toast);
  useEffect(() => startKeepAwake(), []);
  const editing = mode === 'edit' && role === 'admin';
  // A kiosk locked to a pad that's gone has no buttons, and its remote presses none elsewhere either.
  const keysOff = useRef(false);
  // Keys work for every pad (a kiosk's only for its own), and while the menu is open (a key that
  // presses a button closes it).
  useEffect(() => (editing ? undefined : session.listenKeys(() => setMenu(false), () => !keysOff.current, opts.lock)), [session, editing]);
  // Unsaved edits kept on this device from an earlier editor (a reload, a new token…): offered back.
  const kept = useMemo(() => {
    if (role !== 'admin' || opts.lock || mode !== 'run') return null;
    const d = loadDraft(draftScope(backend.kind));
    return d && stable(d.draft) !== stable(d.base) ? d : null;
  }, [role, mode]);
  /**
   * Leaving the editor on a pad the host's config doesn't have yet: one saved just now comes with
   * the socket's next `config` (it can be a moment behind the save's answer); one never saved
   * doesn't come, and the pad on screen before stays.
   */
  const landing = useRef<{ id: string; until: number } | null>(null);
  /** Show pad `id` from now on (a tab, the missing-pad list, leaving the editor). */
  const choose = (id: string) => {
    landing.current = null;
    shown.current = config?.pads.find((x) => x.id === id) ?? shown.current;
    setChoice({ kind: 'id', id });
    lsSet(KEYS.pad, id);
  };
  useEffect(() => {
    const l = landing.current;
    if (!l || !config) return;
    if (mono() > l.until) landing.current = null;
    else if (config.pads.some((x) => x.id === l.id)) choose(l.id);
  }, [config]);

  if (status === 'unauthorized') return p.recovering ? <ConnectingScreen status="connecting" onRepair={p.onForget} /> : <RejectedScreen onToken={p.onPair} onRetry={p.onRetry} onCode={p.onCode} />;
  if (!config) return <ConnectingScreen status={status} hostFull={hostFull} originRefused={originRefused} allowOrigin={allowOrigin} onRepair={p.onForget} />;
  const found = resolvePad(config.pads, choice, shown.current);
  const pad = typeof found === 'string' ? null : found;
  keysOff.current = !pad && opts.lock;
  if (pad) shown.current = { id: pad.id, name: pad.name };
  // Admin only: a press-role client never renders edit mode, whatever `mode` says. Leaving it lands
  // on the pad the editor had open (QA: the owner built "Stage", saved, closed the editor, and was
  // back on "Test"), a `?pad=` link's page too; on the one on screen before only when the editor's
  // pad isn't on the host (never saved).
  const exitEdit = (id?: string) => {
    setMode('run');
    if (!id) return;
    if (config.pads.some((x) => x.id === id)) choose(id);
    else landing.current = { id, until: mono() + LANDING_MS };
  };
  return (
    <div class="app" data-mode={mode} data-lock={opts.lock ? '' : undefined} data-show={show && !editing ? '' : undefined}>
      {!editing && (
        <TopBar
          pads={config.pads}
          padId={pad?.id ?? null}
          title={pad ? undefined : `“${found as string}”`}
          showTabs={config.pads.length > 1 && !opts.lock}
          status={status}
          syncing={syncing}
          demo={backend.kind === 'demo'}
          hostFull={hostFull}
          lock={opts.lock}
          marks={marks}
          onPad={choose}
          onMenu={() => setMenu(true)}
        />
      )}
      {editing ? (
        <EditMode backend={backend} padId={pad?.id ?? config.pads[0]!.id} onExit={exitEdit} />
      ) : pad ? (
        <RunPad session={session} pad={pad} />
      ) : (
        <MissingPadScreen name={found as string} lock={opts.lock} pads={config.pads} onPad={choose} />
      )}
      {toast && !editing && (
        <div key={toast.at} class={`bp-toast is-${toast.tone}`} role="status" data-testid="run-toast">
          {toast.text}
        </div>
      )}
      {storageBlocked && backend.kind === 'ws' && !hideStorage && !editing && (
        <div class="bp-banner is-kept" role="status" data-testid="storage-warning">
          <span>
            <b>This browser doesn't let ButtPad store anything</b> (private mode, or site data blocked): the pairing lasts until this tab closes. Open the
            pairing link again next time.
          </span>
          <button type="button" class="bp-banner-x" aria-label="Hide" onClick={() => setHideStorage(true)}>
            <Close />
          </button>
        </div>
      )}
      {originRefused && status !== 'online' && !editing && (
        <div class="bp-banner is-origin" role="alert" data-testid="origin-refused">
          <b>The host turns this address away.</b>
          <OriginAdvice allowOrigin={allowOrigin} />
        </div>
      )}
      {hostFull && status !== 'online' && !editing && (
        <div class="bp-banner" role="alert" data-testid="host-full">
          <b>Host is full (too many devices connected)</b> — it turns new devices away until one disconnects. This one keeps trying.
        </div>
      )}
      {configErrors && role === 'admin' && !editing && (
        <div class="bp-banner" role="alert" data-testid="config-errors">
          <b>Config file has errors</b> — still running the previous config. {configErrors[0]}
          {configErrors.length > 1 ? ` (+${configErrors.length - 1} more)` : ''}
        </div>
      )}
      {kept && !hideKept && !editing && !(configErrors && role === 'admin') && (
        <div class="bp-banner is-kept" role="status" data-testid="draft-banner">
          <span>
            <b>Unsaved edits</b> from {when(kept.savedAt)} are on this device.
          </span>
          <button type="button" class="bp-banner-btn" data-testid="draft-banner-open" onClick={() => setMode('edit')}>
            Review
          </button>
          <button type="button" class="bp-banner-x" aria-label="Hide" data-testid="draft-banner-hide" onClick={() => setHideKept(true)}>
            <Close />
          </button>
        </div>
      )}
      {p.kept && !editing && (
        <div class="bp-banner is-kept" role="status" data-testid="pair-kept">
          <span>
            <b>That link's token was rejected</b> — still paired as before.
          </span>
          <button type="button" class="bp-banner-x" aria-label="Hide" onClick={p.onHideKept}>
            <Close />
          </button>
        </div>
      )}
      {p.paired && !editing && status === 'online' && (
        <div class="bp-banner is-kept is-ok" role="status" data-testid="paired-note">
          <span>
            <b>Paired{role === 'admin' ? ' as admin' : ''}.</b> {role === 'admin' ? 'This device can edit pads now: Menu → Edit pads.' : 'This device can press buttons.'}
          </span>
          <button type="button" class="bp-banner-x" aria-label="Hide" onClick={p.onHidePaired}>
            <Close />
          </button>
        </div>
      )}
      {menu && (
        <MenuSheet
          backend={backend}
          lock={opts.lock}
          onClose={() => setMenu(false)}
          onEdit={() => (setMenu(false), setMode('edit'))}
          onRepair={() => (setMenu(false), p.onForget())}
          onCode={() => (setMenu(false), p.onCode())}
        />
      )}
    </div>
  );
}
