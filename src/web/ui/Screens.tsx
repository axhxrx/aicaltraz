/** Full-screen states outside the pad: pairing, token rejected, first connection, a pad that isn't there. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Role } from '../../core/protocol.ts';
import { copyText, parseToken } from '../lib/env.ts';
import { asCode, CODE_LEN, codeDigits, editCode, formatCode, pairWithCode } from '../lib/pairing.ts';
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
 * host rejected it): the field says so, and nothing else changes. A pairing code typed here ("123
 * 456": the one box on the screen, QA) goes to the code entry, which tries it at once.
 */
function PasteToken(p: { onToken(t: string): void | Promise<string | null>; onCode(code: string): void; cta: string }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const code = asCode(value);
    if (code !== null) return code.length === CODE_LEN ? p.onCode(code) : setErr(`That looks like a pairing code, but a code has ${CODE_LEN} digits.`);
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
export function PairingScreen(p: { onToken(t: string): void | Promise<string | null>; onCode(code?: string): void }) {
  return (
    <Screen testid="pairing">
      <div class="bp-screen-icon">
        <Link />
      </div>
      <h1>Pair this device</h1>
      <p>This screen becomes a remote for a ButtPad host. It pairs once: with a code, or with the host's pairing link.</p>
      <button type="button" class="bp-cta bp-code-cta" data-testid="pair-with-code" onClick={() => p.onCode()}>
        <Key />
        Pair with a code
      </button>
      <p class="bp-screen-note">The host prints a one-time code when it starts (an admin device can show one too: Menu → Pair another device).</p>
      <p>
        Or use the host's <b>pairing link</b>: scan the <b>QR code</b> it prints with this device's camera, open the link here, or paste it below.
      </p>
      <PasteToken onToken={p.onToken} onCode={p.onCode} cta="Pair" />
      <a class="bp-demo-link" href={demoHref()} data-testid="try-demo">
        No host handy? Try the demo →
      </a>
    </Screen>
  );
}

export function RejectedScreen(p: { onToken(t: string): void | Promise<string | null>; onRetry(): void; onCode(code?: string): void }) {
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
      <PasteToken onToken={p.onToken} onCode={p.onCode} cta="Pair" />
      <div class="bp-screen-actions">
        <button type="button" class="bp-ghost" data-testid="pair-with-code" onClick={() => p.onCode()}>
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
} as const;

const COPIED_MS = 2500;

/**
 * "Copy for the operator": `text`, exactly, on the clipboard. Where the browser won't, the text is
 * selected (`select`, its element) so it can be copied by hand, and the button says so.
 */
function CopyButton(p: { text: string; label: string; testid: string; select(): void }) {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      class={`bp-ghost bp-copy${done ? ` is-${done}` : ''}`}
      data-testid={p.testid}
      onClick={() =>
        void copyText(p.text).then((ok) => {
          if (!ok) p.select();
          setDone(ok ? 'copied' : 'failed');
        })
      }
    >
      {done === 'copied' ? 'Copied ✓' : done === 'failed' ? 'Couldn’t copy: it’s selected, copy it by hand' : p.label}
    </button>
  );
}

/**
 * The host turns pages from this address away (403): this page comes through a reverse proxy,
 * tunnel or preview pane the host wasn't told about. Says exactly what to start it with — the
 * `--allow-origin` value the host's answer names, else this page's origin — kept whole on its line
 * (QA: "https://mason-" / "preview.test" split at the hyphen), ready to copy for whoever runs it.
 * `pairing`: a code was being traded, and the restart makes a new one.
 */
export function OriginAdvice(p: { allowOrigin?: string | null; pairing?: boolean }) {
  const cmd = useRef<HTMLElement>(null);
  const origin = p.allowOrigin || (location.origin !== 'null' ? location.origin : null);
  if (!origin)
    return (
      <div class="bp-origin" data-testid="origin-advice">
        The host refuses requests from this page, and its address is none the host could allow (a sandboxed frame): open ButtPad in a browser tab of its own.
      </div>
    );
  const select = () => {
    const el = cmd.current;
    const sel = getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  return (
    <div class="bp-origin" data-testid="origin-advice">
      <p>
        The host refuses requests from this page’s address, <span class="bp-unit">{origin}</span>: a proxy, tunnel or preview is in front of it. Whoever runs ButtPad
        restarts it with:
      </p>
      <code class="bp-cmd" ref={cmd} data-selectable data-testid="origin-cmd">
        <span class="bp-unit">--allow-origin</span> <span class="bp-unit">{origin}</span>
      </code>
      <CopyButton text={`--allow-origin ${origin}`} label="Copy for the operator" testid="copy-origin" select={select} />
      {p.pairing && (
        <p class="bp-origin-new" data-testid="origin-new-code">
          Restarting ButtPad prints a NEW pairing code — ask for it.
        </p>
      )}
    </div>
  );
}

/** A code-entry message: in words, or (403) what to tell the host's operator. */
type CodeError = { text: string } | { origin: true; allowOrigin?: string };

/**
 * Pairing by code: the digits the host printed at startup (next to its `…/#pair` link), or that an
 * admin device shows (Menu → Pair another device). Big digits, the number pad, one tap to pair. A
 * code is exactly 6 digits ("123 456"; spaces and dashes don't count), never more, and Pair waits
 * for all 6. A code that came with the link (`#pair=123456`, or typed into the pairing-link box)
 * is tried at once. After a code fails, it is selected, and what is typed next replaces it.
 */
export function PairCodeScreen(p: { initial?: string; paired: boolean; onPaired(token: string, role: Role): void; onCancel(): void }) {
  const first = codeDigits(p.initial ?? '');
  const [code, setCode] = useState(() => (first.length <= CODE_LEN ? formatCode(first) : ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<CodeError | null>(null);
  /** "A code has 6 digits": a 7th was refused, or Pair was asked for with fewer. */
  const [short, setShort] = useState(first.length > CODE_LEN);
  /** The code shown just failed: the next edit starts a new one (a tap on the field doesn't put the caret into the old digits). */
  const fresh = useRef(false);
  /** What the field shows (set with each edit: two edits can come before a render), and what the edit on its way replaces. */
  const shown = useRef(code);
  const replacing = useRef<{ start: number; end: number } | null>(null);
  /** Select the code once the field can take focus again (it is read-only while the host answers). */
  const reselect = useRef(false);
  /** Too many tries: Date.now() when the host takes one again (its Retry-After), counted down on screen. */
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [, tick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const left = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
  const digits = codeDigits(code);
  const complete = digits.length === CODE_LEN;
  useEffect(() => {
    if (waitUntil === null) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= waitUntil) (setWaitUntil(null), setErr(null), input.current?.focus());
    }, 250);
    return () => clearInterval(t);
  }, [waitUntil]);
  useEffect(() => {
    if (busy || !reselect.current) return;
    reselect.current = false;
    input.current?.focus();
    input.current?.select();
  });
  const submit = async (d = digits) => {
    if (left > 0 || busy) return;
    if (d.length !== CODE_LEN) return setShort(true);
    setBusy(true);
    setErr(null);
    setShort(false);
    const r = await pairWithCode(d);
    setBusy(false);
    if (r.ok) return p.onPaired(r.token, r.role);
    fresh.current = true;
    reselect.current = true;
    if (r.why === 'limited') {
      setWaitUntil(Date.now() + (r.retryAfter ?? 60) * 1000);
      return setErr({ text: PAIR_ERRORS.limited });
    }
    setErr(r.why === 'origin' ? { origin: true, allowOrigin: r.allowOrigin } : { text: PAIR_ERRORS[r.why] });
  };
  useEffect(() => {
    if (first.length === CODE_LEN) void submit(first);
    else input.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onCancel();
    window.addEventListener('keydown', k);
    // The selection an edit replaces, read before the browser changes the field.
    const el = input.current;
    const b = () => void (replacing.current = el ? { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 } : null);
    el?.addEventListener('beforeinput', b);
    return () => {
      window.removeEventListener('keydown', k);
      el?.removeEventListener('beforeinput', b);
    };
  }, []);
  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const kind = (e as InputEvent).inputType ?? '';
    const r = editCode(shown.current, el.value, el.selectionStart ?? el.value.length, kind.startsWith('delete'), fresh.current, replacing.current ?? undefined);
    replacing.current = null;
    // Set here, not only through state: a refused edit leaves the state as it was, and the field must show that too.
    el.value = r.value;
    try {
      el.setSelectionRange(r.caret, r.caret);
    } catch {
      /* not focused */
    }
    shown.current = r.value;
    fresh.current = r.fresh;
    setCode(r.value);
    setShort(r.over);
    if (!r.fresh) setErr(null);
  };
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
          Pairing code · {CODE_LEN} digits
        </label>
        <input
          ref={input}
          id="bp-code"
          class="bp-code-input"
          data-testid="code-input"
          value={code}
          onInput={onInput}
          // A failed code is selected, but a tap on the field puts the caret into it (after the click
          // event, in Chromium): select it again once that is done. The next edit replaces it all the
          // same, wherever the caret ends up.
          onClick={(e) => {
            const el = e.currentTarget;
            if (fresh.current) setTimeout(() => fresh.current && document.activeElement === el && el.select(), 0);
          }}
          // Enter with fewer digits: Pair can't be pressed yet, so say why here.
          onKeyDown={(e) => e.key === 'Enter' && !complete && setShort(true)}
          inputMode="numeric"
          autocomplete="one-time-code"
          maxLength={40}
          placeholder="••• •••"
          spellcheck={false}
          readOnly={busy}
          aria-describedby="bp-code-hint"
        />
        {short && (
          <div class="bp-paste-err" role="alert" id="bp-code-hint" data-testid="code-hint">
            A code has {CODE_LEN} digits{digits.length && digits.length < CODE_LEN ? ` (${digits.length} so far)` : ''}.
          </div>
        )}
        {err && (
          <div class="bp-paste-err" role="alert" data-testid="code-error">
            {'origin' in err ? <OriginAdvice allowOrigin={err.allowOrigin} pairing /> : err.text}
            {left > 0 && ` Wait ${left} s, then try again.`}
          </div>
        )}
        <div class="bp-code-actions">
          <button type="submit" class="bp-cta" data-testid="code-submit" disabled={busy || left > 0 || !complete}>
            {busy ? 'Pairing…' : left > 0 ? `Wait ${left} s` : 'Pair'}
          </button>
          <button type="button" class="bp-ghost" data-testid="code-cancel" onClick={p.onCancel}>
            {p.paired ? 'Cancel' : 'Back'}
          </button>
        </div>
      </form>
    </Screen>
  );
}

export function ConnectingScreen(p: { status: string; hostFull?: boolean; originRefused?: boolean; allowOrigin?: string | null; onRepair(): void }) {
  const failing = p.status === 'offline';
  if (p.originRefused)
    return (
      <Screen testid="connecting" tone="warn">
        <div class="bp-spinner is-failing" />
        <h1 data-testid="origin-refused">The host turns this address away</h1>
        <OriginAdvice allowOrigin={p.allowOrigin} />
        <p>This device stays paired: it keeps trying, and connects once the host lets it.</p>
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
