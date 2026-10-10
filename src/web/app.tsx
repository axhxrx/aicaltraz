/** App shell: picks the backend, then routes between pairing / rejected / connecting / pad. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DemoBackend } from './backend/demo.ts';
import type { Backend } from './backend/types.ts';
import { WsBackend } from './backend/ws.ts';
import { Gallery } from './dev/Gallery.tsx';
import { when } from './edit/dialogs.tsx';
import { draftScope, loadDraft, unsavedEdits } from './edit/draft-store.ts';
import { EditMode } from './edit/EditMode.tsx';
import { Dialog } from './edit/fields.tsx';
import { stable } from './edit/ops.ts';
import { loadToken, readHashToken, saveToken, type AppOptions } from './lib/env.ts';
import { startKeepAwake } from './lib/keepawake.ts';
import { KEYS, lsGet, lsSet } from './lib/settings.ts';
import { useStore } from './lib/store.ts';
import { RunPad } from './run/RunPad.tsx';
import { MenuSheet } from './ui/Menu.tsx';
import { Close } from './ui/icons.tsx';
import { ConnectingScreen, PairingScreen, RejectedScreen } from './ui/Screens.tsx';
import { TopBar } from './ui/TopBar.tsx';

declare global {
  interface Window {
    /** Debug/test handle. */
    __buttpad?: { backend: Backend };
  }
}

export function App({ opts }: { opts: AppOptions }) {
  const [token, setToken] = useState(() => (opts.demo ? null : loadToken()));
  // Bumped to rebuild the backend (retry with the same token, or a new pairing).
  const [gen, setGen] = useState(0);
  const backend = useMemo<Backend | null>(() => {
    if (opts.gallery) return null;
    if (opts.demo) return new DemoBackend({ exact: opts.exact });
    return token ? new WsBackend(token) : null;
  }, [token, gen]);

  useEffect(() => {
    if (backend) window.__buttpad = { backend };
    return () => backend?.dispose();
  }, [backend]);

  /** A pairing link opened while the editor has unsaved changes: asked first. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  // The cached layout belongs to the old pairing (it may be another host).
  const pairWith = (t: string) => {
    lsSet(KEYS.configCache, null);
    saveToken(t);
    setToken(t);
    setGen((g) => g + 1);
  };

  // Opening another pairing link in this tab only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const t = readHashToken();
      if (opts.demo || !t || t === token) return;
      // The draft is kept on the device either way, but leaving it deserves a question.
      if (unsavedEdits.get()) setSwitchTo(t);
      else pairWith(t);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [token]);

  if (opts.gallery) return <Gallery />;
  // The cached layout belongs to the old pairing (it may be another host).
  const pair = (t: string) => {
    if (t !== token) lsSet(KEYS.configCache, null);
    saveToken(t);
    setToken(t);
    setGen((g) => g + 1);
  };
  const forget = () => {
    lsSet(KEYS.configCache, null);
    saveToken(null);
    setToken(null);
  };
  if (!backend) return <PairingScreen onToken={pair} />;
  return (
    <>
      <Connected key={gen} backend={backend} opts={opts} onPair={pair} onForget={forget} onRetry={() => setGen((g) => g + 1)} />
      {switchTo && (
        <Dialog
          title="Open the new pairing link?"
          testid="dialog-switch"
          tone="warn"
          onClose={() => setSwitchTo(null)}
          actions={
            <>
              <button type="button" class="ed-btn is-danger" data-testid="switch-yes" onClick={() => (setSwitchTo(null), pairWith(switchTo))}>
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

function Connected(p: { backend: Backend; opts: AppOptions; onPair(t: string): void; onForget(): void; onRetry(): void }) {
  const { backend, opts } = p;
  const status = useStore(backend.snapshot, (s) => s.status);
  const config = useStore(backend.snapshot, (s) => s.config);
  const role = useStore(backend.snapshot, (s) => s.role);
  const configErrors = useStore(backend.snapshot, (s) => s.configErrors);
  const [padId, setPadId] = useState(() => opts.pad ?? lsGet(KEYS.pad) ?? '');
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<'run' | 'edit'>('run');
  const [hideKept, setHideKept] = useState(false);
  useEffect(() => startKeepAwake(), []);
  // Unsaved edits kept on this device from an earlier editor (a reload, a new token…): offered back.
  const kept = useMemo(() => {
    if (role !== 'admin' || opts.lock || mode !== 'run') return null;
    const d = loadDraft(draftScope(backend.kind));
    return d && stable(d.draft) !== stable(d.base) ? d : null;
  }, [role, mode]);

  if (status === 'unauthorized') return <RejectedScreen onToken={p.onPair} onRetry={p.onRetry} />;
  if (!config) return <ConnectingScreen status={status} onRepair={p.onForget} />;
  const pad = config.pads.find((x) => x.id === padId) ?? config.pads[0]!;
  const choose = (id: string) => {
    setPadId(id);
    lsSet(KEYS.pad, id);
  };
  // Admin only: a press-role client never renders edit mode, whatever `mode` says.
  const editing = mode === 'edit' && role === 'admin';
  const exitEdit = (id?: string) => {
    if (id && config.pads.some((x) => x.id === id)) choose(id);
    setMode('run');
  };
  return (
    <div class="app" data-mode={mode} data-lock={opts.lock ? '' : undefined}>
      {!editing && (
        <TopBar
          pads={config.pads}
          padId={pad.id}
          showTabs={config.pads.length > 1 && !opts.lock}
          status={status}
          demo={backend.kind === 'demo'}
          onPad={choose}
          onMenu={() => setMenu(true)}
        />
      )}
      {editing ? <EditMode backend={backend} padId={pad.id} onExit={exitEdit} /> : <RunPad backend={backend} pad={pad} keys={!menu} />}
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
      {menu && (
        <MenuSheet
          backend={backend}
          lock={opts.lock}
          onClose={() => setMenu(false)}
          onEdit={() => (setMenu(false), setMode('edit'))}
          onRepair={() => (setMenu(false), p.onForget())}
        />
      )}
    </div>
  );
}
