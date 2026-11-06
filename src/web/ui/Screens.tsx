/** Full-screen states outside the pad: pairing, token rejected, first connection, a pad that isn't there. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Role } from '../../core/protocol.ts';
import { parseToken } from '../lib/env.ts';
import { CODE_MAX, CODE_MIN, codeDigits, pairWithCode } from '../lib/pairing.ts';
import { Key, Link, Warn } from './icons.tsx';

function Screen(p: { children: ComponentChildren; testid: string; tone?: 'warn'; class?: string }) {
  return (
    <main class={`bp-screen${p.tone ? ` is-${p.tone}` : ''}${p.class ? ` ${p.class}` : ''}`} data-testid={p.testid} data-scroll>
      <div class="bp-screen-card">{p.children}</div>
    </main>
  );
}

/**
 * A pairing link (or token) pasted in. `onToken` may answer with why the token isn't in use (the
 * host rejected it): the field says so, and nothing else changes.
 */
function PasteToken(p: { onToken(t: string): void | Promise<string | null>; cta: string }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const t = parseToken(value);
    if (!t) return setErr("That doesn't look like a pairing link or token.");
    setBusy(true);
    try {
      setErr((await p.onToken(t)) ?? null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="bp-paste" onSubmit={(e) => void submit(e)}>
      <label class="bp-paste-label" for="bp-token">
        Pairing link or token
      </label>
      <div class="bp-paste-row">
        <input
          id="bp-token"
          data-testid="token-input"
          value={value}
          onInput={(e) => (setValue(e.currentTarget.value), setErr(null))}
          placeholder="…/#token=…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          inputMode="url"
        />
        <button type="submit" class="bp-cta" data-testid="token-submit" disabled={busy}>
          {p.cta}
        </button>
      </div>
      {err && (
        <div class="bp-paste-err" role="alert" data-testid="token-error">
          {err}
        </div>
      )}
    </form>
  );
}

const demoHref = () => `${location.pathname}?demo`;

/**
 * Not paired yet. The quickest way in (and the only practical one where this page isn't on the
 * host's LAN address, behind a proxy, say) is the pairing code the host prints when it starts:
 * that comes first, big. The QR / link / paste routes follow.
 */
export function PairingScreen(p: { onToken(t: string): void | Promise<string | null>; onCode(): void }) {
  return (
    <Screen testid="pairing">
      <div class="bp-screen-icon">
        <Link />
      </div>
      <h1>Pair this device</h1>
      <p>This screen becomes a remote for a ButtPad host. It pairs once: with a code, or with the host's pairing link.</p>
      <button type="button" class="bp-cta bp-code-cta" data-testid="pair-with-code" onClick={p.onCode}>
        <Key />
        Pair with a code
      </button>
      <p class="bp-screen-note">The host prints a one-time code when it starts (an admin device can show one too: Menu → Pair another device).</p>
      <p>
        Or use the host's <b>pairing link</b>: scan the <b>QR code</b> it prints with this device's camera, open the link here, or paste it below.
      </p>
      <PasteToken onToken={p.onToken} cta="Pair" />
      <a class="bp-demo-link" href={demoHref()} data-testid="try-demo">
        No host handy? Try the demo →
      </a>
    </Screen>
  );
}

export function RejectedScreen(p: { onToken(t: string): void | Promise<string | null>; onRetry(): void; onCode(): void }) {
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
      <p>Pair again: scan the host's QR code, open its pairing link, paste it here, or use a pairing code.</p>
      <PasteToken onToken={p.onToken} cta="Pair" />
      <div class="bp-screen-actions">
        <button type="button" class="bp-ghost" data-testid="pair-with-code" onClick={p.onCode}>
          Pair with a code…
        </button>
        <button type="button" class="bp-ghost" data-testid="retry" onClick={p.onRetry}>
          Try the old token again
        </button>
      </div>
    </Screen>
  );
}

/** A pairing link's token being tried on the host before it replaces the one in use. */
export function CheckingScreen() {
  return (
    <Screen testid="checking-link">
      <div class="bp-spinner" />
      <h1>Checking the pairing link…</h1>
      <p>Asking {location.host} whether it takes this link's token. This device stays paired as it is if it doesn't.</p>
    </Screen>
  );
}

const PAIR_ERRORS = {
  bad: 'That code didn’t work: it’s mistyped, used already, or expired (a code works once, for a few minutes). Get a new one from the host.',
  limited: 'Too many tries.',
  unreachable: 'Can’t reach the host. Check that this device is on the same network as the host.',
  old: 'This host doesn’t take pairing codes (it runs an older ButtPad): open its pairing link instead.',
  get origin() {
    return originAdvice();
  },
} as const;

/**
 * The host turns pages from this address away: this page comes through a reverse proxy, tunnel or
 * preview pane the host wasn't told about. Says exactly what to start it with.
 */
export const originAdvice = () =>
  `The host refuses requests from this page’s address (${location.origin}): a proxy, tunnel or preview is in front of it. Start ButtPad with --allow-origin ${location.origin} (or BUTTPAD_ALLOW_ORIGINS=${location.origin}).`;

/**
 * Pairing by code: the digits the host printed at startup (next to its `…/#pair` link), or that an
 * admin device shows (Menu → Pair another device). Big digits, the number pad, one tap to pair. A
 * code that came with the link (`#pair=123456`) is tried at once.
 */
export function PairCodeScreen(p: { initial?: string; paired: boolean; onPaired(token: string, role: Role): void; onCancel(): void }) {
  const [code, setCode] = useState(p.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const digits = codeDigits(code);
    if (digits.length < CODE_MIN) return setErr(`Type the whole code: ${CODE_MIN} or more digits.`);
    setBusy(true);
    setErr(null);
    const r = await pairWithCode(digits);
    setBusy(false);
    if (r.ok) return p.onPaired(r.token, r.role);
    setErr(r.why === 'limited' ? `${PAIR_ERRORS.limited} Wait ${r.retryAfter ? `${r.retryAfter} s` : 'a minute'}, then try again.` : PAIR_ERRORS[r.why]);
    input.current?.focus();
    input.current?.select();
  };
  useEffect(() => {
    if (codeDigits(p.initial ?? '').length >= CODE_MIN) void submit();
    else input.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onCancel();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <Screen testid="pair-code" class="bp-code-screen">
      <div class="bp-screen-icon">
        <Key />
      </div>
      <h1>{p.paired ? 'Unlock with a pairing code' : 'Pair with a code'}</h1>
      <p>
        Type the code the host printed when it started (next to its <code>…/#pair</code> link), or the one an admin device shows under{' '}
        <b>Menu → Pair another device</b>. A code works once, for a few minutes.
      </p>
      <form
        class="bp-code-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label class="bp-paste-label" for="bp-code">
          Pairing code
        </label>
        <input
          ref={input}
          id="bp-code"
          class="bp-code-input"
          data-testid="code-input"
          value={code}
          onInput={(e) => (setCode(e.currentTarget.value), setErr(null))}
          inputMode="numeric"
          pattern="[0-9 \-]*"
          autocomplete="one-time-code"
          maxLength={CODE_MAX + 4}
          placeholder="••••••"
          spellcheck={false}
          disabled={busy}
        />
        {err && (
          <div class="bp-paste-err" role="alert" data-testid="code-error">
            {err}
          </div>
        )}
        <div class="bp-code-actions">
          <button type="submit" class="bp-cta" data-testid="code-submit" disabled={busy}>
            {busy ? 'Pairing…' : 'Pair'}
          </button>
          <button type="button" class="bp-ghost" data-testid="code-cancel" onClick={p.onCancel}>
            {p.paired ? 'Cancel' : 'Back'}
          </button>
        </div>
      </form>
    </Screen>
  );
}

export function ConnectingScreen(p: { status: string; hostFull?: boolean; originRefused?: boolean; onRepair(): void }) {
  const failing = p.status === 'offline';
  if (p.originRefused)
    return (
      <Screen testid="connecting" tone="warn">
        <div class="bp-spinner is-failing" />
        <h1 data-testid="origin-refused">The host turns this address away</h1>
        <p>{originAdvice()}</p>
        <p>This one keeps trying, and connects once the host lets it.</p>
      </Screen>
    );
  if (p.hostFull)
    return (
      <Screen testid="connecting" tone="warn">
        <div class="bp-spinner is-failing" />
        <h1 data-testid="host-full">Host is full (too many devices connected)</h1>
        <p>
          ButtPad on {location.host} is running, but turns new devices away until one disconnects. Close ButtPad on a device you aren't using. This one keeps
          trying.
        </p>
      </Screen>
    );
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

/**
 * The pad this screen is for (`?pad=`, or the one on screen) isn't in the config (deleted, or
 * renamed: id and name both changed). Never silently another pad's buttons: a kiosk that became
 * another pad's remote is worse than one that says it has none.
 */
export function MissingPadScreen(p: { name: string; lock: boolean; pads: { id: string; name: string }[]; onPad(id: string): void }) {
  return (
    <main class="bp-screen bp-missing is-warn" data-testid="pad-missing" data-scroll>
      <div class="bp-screen-card">
        <div class="bp-screen-icon">
          <Warn />
        </div>
        <h1>Pad “{p.name}” no longer exists</h1>
        <p>
          {p.lock
            ? 'This screen is locked to that pad, so it shows no buttons. Whoever set it up can point it at another pad (the ?pad= part of its link), or bring the pad back.'
            : 'It was deleted or renamed on the host. Pick a pad:'}
        </p>
        {!p.lock && (
          <div class="bp-pad-list">
            {p.pads.map((x) => (
              <button key={x.id} type="button" class="bp-ghost" data-testid={`open-pad-${x.id}`} onClick={() => p.onPad(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
