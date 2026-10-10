/** Full-screen states outside the pad: pairing, token rejected, first connection. */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { parseToken } from '../lib/env.ts';
import { Link, Warn } from './icons.tsx';

function Screen(p: { children: ComponentChildren; testid: string; tone?: 'warn' }) {
  return (
    <main class={`bp-screen${p.tone ? ` is-${p.tone}` : ''}`} data-testid={p.testid} data-scroll>
      <div class="bp-screen-card">{p.children}</div>
    </main>
  );
}

function PasteToken(p: { onToken(t: string): void; cta: string }) {
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  const submit = (e: Event) => {
    e.preventDefault();
    const t = parseToken(value);
    if (t) p.onToken(t);
    else setBad(true);
  };
  return (
    <form class="bp-paste" onSubmit={submit}>
      <label class="bp-paste-label" for="bp-token">
        Pairing link or token
      </label>
      <div class="bp-paste-row">
        <input
          id="bp-token"
          data-testid="token-input"
          value={value}
          onInput={(e) => (setValue(e.currentTarget.value), setBad(false))}
          placeholder="http://192.168.1.20:8787/#token=…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          inputMode="url"
        />
        <button type="submit" class="bp-cta" data-testid="token-submit">
          {p.cta}
        </button>
      </div>
      {bad && <div class="bp-paste-err">That doesn't look like a pairing link or token.</div>}
    </form>
  );
}

const demoHref = () => `${location.pathname}?demo`;

export function PairingScreen(p: { onToken(t: string): void }) {
  return (
    <Screen testid="pairing">
      <div class="bp-screen-icon">
        <Link />
      </div>
      <h1>Pair this device</h1>
      <p>This screen becomes a remote for a ButtPad host. It needs the host's pairing token once.</p>
      <ol class="bp-steps">
        <li>
          Start ButtPad on the host. It prints a <b>QR code</b> and a <b>pairing link</b>.
        </li>
        <li>Scan the QR with this device's camera, or open the link here.</li>
        <li>Or paste the link below.</li>
      </ol>
      <PasteToken onToken={p.onToken} cta="Pair" />
      <a class="bp-demo-link" href={demoHref()} data-testid="try-demo">
        No host handy? Try the demo →
      </a>
    </Screen>
  );
}

export function RejectedScreen(p: { onToken(t: string): void; onRetry(): void }) {
  return (
    <Screen testid="rejected" tone="warn">
      <div class="bp-screen-icon">
        <Warn />
      </div>
      <h1>Token rejected</h1>
      <p>
        The host didn't accept this device's pairing token. Tokens change when the host runs with <code>--rotate-tokens</code>, or the
        link may be for another host.
      </p>
      <p>Pair again: scan the host's QR code, open its pairing link, or paste it here.</p>
      <PasteToken onToken={p.onToken} cta="Pair" />
      <button type="button" class="bp-ghost" data-testid="retry" onClick={p.onRetry}>
        Try the old token again
      </button>
    </Screen>
  );
}

export function ConnectingScreen(p: { status: string; onRepair(): void }) {
  const failing = p.status === 'offline';
  return (
    <Screen testid="connecting">
      <div class={`bp-spinner${failing ? ' is-failing' : ''}`} />
      <h1>{failing ? "Can't reach the host" : 'Connecting…'}</h1>
      <p>
        {failing
          ? `Retrying ${location.host} automatically. Check that ButtPad is running there and that this device is on the same network.`
          : `Talking to ${location.host}`}
      </p>
      {failing && (
        <button type="button" class="bp-ghost" onClick={p.onRepair}>
          Pair with a different host
        </button>
      )}
    </Screen>
  );
}
