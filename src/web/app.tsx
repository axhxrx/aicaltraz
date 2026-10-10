/** App shell: picks the backend, then routes between pairing / rejected / connecting / pad. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DemoBackend } from './backend/demo.ts';
import type { Backend } from './backend/types.ts';
import { WsBackend } from './backend/ws.ts';
import { Gallery } from './dev/Gallery.tsx';
import { EditMode } from './edit/EditMode.tsx';
import { loadToken, saveToken, takeHashToken, type AppOptions } from './lib/env.ts';
import { startKeepAwake } from './lib/keepawake.ts';
import { KEYS, lsGet, lsSet } from './lib/settings.ts';
import { useStore } from './lib/store.ts';
import { RunPad } from './run/RunPad.tsx';
import { MenuSheet } from './ui/Menu.tsx';
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

  // Opening another pairing link in this tab only changes the hash.
  useEffect(() => {
    const onHash = () => {
      takeHashToken();
      const t = loadToken();
      if (!opts.demo && t && t !== token) (setToken(t), setGen((g) => g + 1));
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [token]);

  if (opts.gallery) return <Gallery />;
  const pair = (t: string) => {
    saveToken(t);
    setToken(t);
    setGen((g) => g + 1);
  };
  const forget = () => {
    saveToken(null);
    setToken(null);
  };
  if (!backend) return <PairingScreen onToken={pair} />;
  return <Connected key={gen} backend={backend} opts={opts} onPair={pair} onForget={forget} onRetry={() => setGen((g) => g + 1)} />;
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
  useEffect(() => startKeepAwake(), []);

  if (status === 'unauthorized') return <RejectedScreen onToken={p.onPair} onRetry={p.onRetry} />;
  if (!config) return <ConnectingScreen status={status} onRepair={p.onForget} />;
  const pad = config.pads.find((x) => x.id === padId) ?? config.pads[0]!;
  const choose = (id: string) => {
    setPadId(id);
    lsSet(KEYS.pad, id);
  };
  return (
    <div class="app" data-mode={mode} data-lock={opts.lock ? '' : undefined}>
      <TopBar
        pads={config.pads}
        padId={pad.id}
        showTabs={config.pads.length > 1 && !opts.lock}
        status={status}
        demo={backend.kind === 'demo'}
        onPad={choose}
        onMenu={() => setMenu(true)}
      />
      {mode === 'edit' && role === 'admin' ? (
        <EditMode backend={backend} padId={pad.id} onExit={() => setMode('run')} />
      ) : (
        <RunPad backend={backend} pad={pad} keys={!menu} />
      )}
      {configErrors && role === 'admin' && (
        <div class="bp-banner" role="alert" data-testid="config-errors">
          <b>Config file has errors</b> — still running the previous config. {configErrors[0]}
          {configErrors.length > 1 ? ` (+${configErrors.length - 1} more)` : ''}
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
