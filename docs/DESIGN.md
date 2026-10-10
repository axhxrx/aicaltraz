# ButtPad — design spec

A host program serves a web app of a few huge buttons. Pressing a button runs a preconfigured
action (an executable or a shell command) on the host. Built for moments when you can't fiddle
with a screen: on a ladder setting lights, on a bike, mid-shoot. Any device with a browser on the
LAN is a remote; the host is any Linux/macOS/Windows box running Bun.

The contract between implementations (this Bun host, a future native app) is **data, not code**:

- `src/core/config.ts` — config schema (zod; `bun run schema` emits JSON Schema).
- `src/core/protocol.ts` — WebSocket messages + HTTP payload types.
- `src/core/machine.ts` — the per-button state machine. Pure; ported per implementation.

## Glossary

- **Host**: the Bun server process. Owns config, runs actions, owns button state.
- **Client**: a browser showing the web app. Renders state, collects presses. Holds no authority.
- **Pad**: a named grid (`cols`×`rows`) of buttons. A config has ≥1 pads.
- **Button**: placed at cell `x,y` spanning `w`×`h` cells. Has one **action**.
- **Action**: `exec` (argv, no shell) or `shell` (a command string run by a shell).

## Repo layout

```
src/core/      shared contract (config, protocol, machine) — imported by host and web
src/server/    host: CLI, HTTP+WS, runner, state store, config store, auth
src/web/       client: index.html + Preact app (bundled by Bun's HTML import)
examples/      example config + fake scripts (fake lights, progress, flaky, slow…)
test/          bun unit/integration tests  (bun test, root=test via bunfig.toml)
e2e/           Playwright browser tests    (run with node: npx playwright test)
docs/          this spec, QA reports
```

## Host

### CLI

```
bun src/server/main.ts [--config PATH] [--secrets PATH] [--host H] [--port N]
                       [--rotate-tokens] [--no-qr] [--ready-json] [--dev]
                       [--tls-cert PATH --tls-key PATH]
```

- `--config` default `./buttpad.config.json` (env `BUTTPAD_CONFIG`). Missing file → write the
  built-in starter config there and say so.
- `--secrets` default: `<config dir>/buttpad.secrets.json`. Created on first run, mode 0600.
- `--host/--port` override `config.server`. `--port 0` = pick a free port.
- On start, print for each non-internal IPv4 (plus localhost) the **pairing URLs**
  `http://IP:PORT/#token=PRESS_TOKEN` and the admin one, plus a terminal QR code of the press URL
  for the first LAN IP (unless `--no-qr`). Warn that it's plain HTTP.
- `--ready-json`: additionally print exactly one line to stdout once listening, for harnesses:
  `{"event":"ready","port":N,"pressToken":"…","adminToken":"…","configPath":"…"}`
- `--dev`: Bun dev mode, for working on the web app (`bun run dev` passes it): an unauthenticated
  HMR socket at `/_bun/hmr` and source maps that carry absolute paths (the OS user name). Off by
  default; never on a network you don't trust.
- SIGINT/SIGTERM/SIGHUP: kill all running actions (process groups), including killed ones still in
  their SIGKILL grace period, then exit. SIGHUP inherited as ignored (`nohup`) stays ignored; that is
  detected on Linux (`/proc/self/status`), elsewhere SIGHUP always shuts down.
- A log reader that goes away (EPIPE on stdout/stderr) doesn't take the host down.

### Auth

- Two random tokens (32 bytes, base64url) in the secrets file: `pressToken`, `adminToken`.
  `--rotate-tokens` regenerates both.
- HTTP: `Authorization: Bearer <token>`. WebSocket: `/ws?token=<token>` (browsers can't set
  WS headers). Constant-time compare. Role = whichever token matched. Anything else → 401
  (WS: reject the upgrade with 401).
- A WS upgrade whose `Origin` host differs from its `Host` header → 403 (cross-site WebSocket
  hijacking). No `Origin` (curl, scripts) is fine.
- The browser **never sends commands**: a press names `pad`+`button`; the host looks up the action.
- Press role never receives `action` fields (see `WireConfig`). Only admin can PUT config or read
  run logs. But every client sees each run's result text (≤200 chars, see Runner): a script must not
  print a secret as its last line.
- The admin token is a remote-shell credential. Treat it as such in docs and UI.

### HTTP API

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/` | none | the web app (Bun HTML import of `src/web/index.html`) |
| GET | `/api/health` | none | `{ok:true, version, protocol}`; no host name (anyone can ask, even a DNS-rebinding page; `hello` has it) |
| GET | `/api/config` | any | `{config: WireConfig, rev}` (redacted for press) |
| PUT | `/api/config` | admin | body `{config, baseRev}` → 200 `{rev}`; 400 `{errors:string[]}`; 409 `{rev}` if `baseRev` ≠ current |
| GET | `/api/state` | any | `{states: StateMap, serverNow}` |
| POST | `/api/press/:pad/:button` | any | → `{result: PressResult, state}`; 404 unknown button. For curl/Stream Deck/etc. |
| GET | `/api/runs?pad=&button=` | admin | `RunRecord[]`, newest first, last 20 per button (both params optional) |

JSON bodies capped at 1 MB. Unknown routes 404.

### WebSocket

See `ServerMsg`/`ClientMsg` in `src/core/protocol.ts`.

- On connect: `hello` (role, redacted-or-full config, rev, all states, serverNow, host info).
- Every state change → `state` to **all** clients. Config change (UI save or hand edit) → `config`
  to all (each redacted for its role).
- `press` → host replies `ack` to that client with the `PressResult`, then state broadcasts follow.
- Malformed message → `error`, keep the socket.
- At most 64 connections (all roles together); beyond that the upgrade is refused with 503.

### Config store

- Source of truth is the file. Hand edits are first-class: watch the file (debounce ~200 ms),
  re-parse, and on success swap + broadcast. On failure keep the old config, log the errors and
  send `configError` to admins.
- `rev` = sha256 (hex, first 16 chars) of the file's bytes.
- UI saves: validate with `parseConfig`, write atomically (temp file + rename), compact output
  (omit button fields equal to their schema defaults; 2-space JSON). A new file is created 0600 (it
  holds commands and their env); a rewrite keeps the file's mode.
- A symlinked config is read and watched through its path: saves replace the link's current
  target; edits of the target and replacing the link itself (`sed -i`) are both picked up. Relative
  paths (actions, secrets) resolve against the directory of the file it pointed to at startup.
- Removing a button that is running kills its action. Changing a running button's action does not
  affect the current run.

### Runner

- `exec`: `Bun.spawn([command, ...args])`. `shell`: POSIX `[shell ?? $SHELL ?? '/bin/sh', '-c', script]`;
  Windows `[shell ?? %ComSpec% ?? 'cmd.exe', '/d', '/s', '/c', script]`.
- `cwd` defaults to the config file's directory; relative `cwd` resolves against it too.
- env = host env + action `env` + `BUTTPAD_PAD`, `BUTTPAD_BUTTON`, `BUTTPAD_RUN_ID`, `BUTTPAD_LABEL`.
- stdin ignored. Spawn detached (POSIX: own process group) so kill hits the whole tree:
  SIGTERM to `-pid`, then SIGKILL after 2 s. Windows: `taskkill /T /F /PID`. A killed run is
  *dying* until its group is seen empty (on Linux, zombies awaiting their reaper don't count) or got
  the SIGKILL. A group seen empty is never signalled again: its id may be recycled.
- **Output protocol** (stdout, line-based, UTF-8):
  - `@progress N` (0–100) → `progress`; `@status text` → `status`; `@result text` → result text.
  - Without `@result`, result text = last non-empty, non-`@` stdout line; on failure with no
    stdout, last non-empty stderr line; spawn error → the error message. Truncate to 200 chars.
  - A last line without a newline counts, even while a background process holds the pipe open.
  - Output is read in turns with everything else: a flood (`yes`) can't stall timers or other presses.
- Timeout (`timeoutMs`) → kill → failure reason `timeout`. Spawn failure → `spawn`, with text like
  `command not found: X`, `permission denied (chmod +x?): P`, `is a directory: P`,
  `not executable as a program (missing #! line?): P`, `interpreter not found (check the #! line): P`.
- Durations and throttles use a monotonic clock; only `startedAt`/`endedAt` are wall-clock (epoch ms).
- Keep only tails in memory: 16 KB per stream per run; last 20 runs per button.

### State store

Holds `RunState` per button, runs `transition()` from `machine.ts`, performs the effects (start →
runner, kill → runner, scheduleReset → timer that feeds back `reset`), broadcasts every change.

A press gets `ignored` instead of its usual result when:

- (`whileRunning: cancel`) it comes within 700 ms of the run's start: a double press must not
  start and cancel at once. Also when the cancel no longer reaches a process (the action already
  exited, its output is still draining): the run ends as what it was. A cancel drops a queued re-run.
- it would start a run while an earlier run of that button is still alive or dying (e.g. the button
  was removed and re-added meanwhile): never two instances of one button.
- the limits over all buttons are hit: presses that start or queue a run draw from a token bucket
  (bursts of 20, then 10/s), and at most 32 runs at a time. Logged once per streak of refusals.

## Client

### Connection & pairing

- Token from `location.hash` `#token=…` → `localStorage` (`buttpad.token`), then strip the hash
  with `history.replaceState`. No token → pairing screen: explain how to pair (scan the QR the
  host prints / open the pairing URL), with a paste field.
- WS with auto-reconnect (backoff 250 ms → 5 s). Reconnect gets a fresh `hello`; state is
  authoritative from the host, so a reload or flaky Wi-Fi never loses track of a running action.
- 401 → "token rejected" screen with re-pair option.
- **Backend interface**: the UI talks to an abstract backend with two implementations:
  `ws` (the host) and `demo` (in-browser: runs `machine.ts` locally with simulated actions, config
  in localStorage). `?demo` selects demo. Demo exists so the UI can be tried on a phone with no
  host, and so the UI can be built/tested independently.

### Run mode (the default, locked-down)

- Full viewport (`100dvh`, safe-area insets), no scroll, no zoom, no text selection, no
  long-press callout/context menu, no pull-to-refresh (`touch-action: none`,
  `overscroll-behavior: none`, `-webkit-touch-callout: none`, `user-select: none`).
- CSS grid `cols`×`rows`; buttons placed by `x,y,w,h`. Small gap. Labels sized with container
  query units so they're as large as the button allows. Label color auto black/white by button
  color luminance.
- Thin top bar: pad tabs (hidden when only 1 pad or `?lock`), connection dot, menu (fullscreen,
  wake lock status, device settings, edit mode if admin). `?pad=ID` opens that pad; last pad
  remembered per device.

### Button states (the important part)

Rule: every state differs in **color + motion + shape**, so it reads at a glance in sun glare,
peripheral vision, or with color blindness. Big and bold beats subtle.

| State | Where | Look |
|---|---|---|
| READY | host | solid button color, huge label, still |
| ARMING | client | bright fill rising bottom→top over `holdMs`; label stays; at 100%: pop |
| CONFIRM | client | (confirm buttons) after first fire: flashing amber border + "AGAIN TO CONFIRM", times out after `confirmWindowMs` |
| SENDING | client | from fire until the host acks (normally ms); if no ack in 2 s → FAILURE "NO RESPONSE" |
| RUNNING | host | diagonal stripes scrolling across the whole button + elapsed seconds; `@status` text; `@progress` → determinate fill instead of stripes; `cancel` buttons show "hold to cancel" |
| SUCCESS | host | full-bleed green flood, giant ✓, result text, small elapsed; a thin bar drains over `resultHoldMs` |
| FAILURE | host | full-bleed red, giant ✗, slow pulse, result text / exit code / "TIMEOUT"/"CANCELLED"; drains like success |
| OFFLINE | client | grey, dashed border, ⚠; presses do nothing except shake |

Triggers:

- `hold`: fires when held `holdMs`. Released early → back to READY (fill drains fast).
  Finger moving more than `driftPx` from the start point → cancel.
- `tap`: fires on pointer up if it didn't drift.
- `double`: two taps within 400 ms.
- Keyboard: `key` maps a KeyboardEvent.key to a button (BLE remotes/clickers pair as keyboards).
  keydown starts the hold, keyup releases; auto-repeat ignored.
- Multi-touch: each button tracks its own pointer; pressing two buttons at once works.
- Haptics: `navigator.vibrate` where it exists (fire, success, failure patterns). Optional sounds
  (device setting, default off).

### Keep awake

Wake Lock API needs a secure context, which a LAN `http://` page isn't. So: use Wake Lock when
available; otherwise fall back to a muted, inline, looping tiny video (the NoSleep trick). Show
the keep-awake status in the menu. Re-acquire on `visibilitychange`.

### Edit mode (admin only)

- Entered from the menu. Grid lines visible. Tap an empty cell → new button there. Drag a button
  to move, drag its corner handle to resize; snaps to cells; overlap/out-of-bounds is refused
  visibly.
- Selecting a button opens an editor (bottom sheet on phones, side panel on wide screens): label,
  color, trigger, holdMs, driftPx, whileRunning, confirm, timeoutMs, resultHoldMs, key, action
  (type switch; exec: command + args list + cwd + env; shell: script + shell + cwd + env).
  Duplicate, delete.
- Pad management: add, rename, delete, reorder, cols/rows (shrinking that would clip buttons is
  refused with an explanation).
- Edits are a local draft until **Save** (PUT with `baseRev`). Unsaved indicator. Validation
  errors from the host are shown. 409 → offer reload/overwrite. Discard reverts.
- Admin extra: per-button run log (from `/api/runs`) to see why something failed.

## Testing

- `bun test` — unit + integration (machine, config, runner, HTTP/WS against a real host on port 0).
- `npx playwright test` (Node) — browser tests in `e2e/`. Chromium only here:
  `e2e/playwright.config.ts` points at `/opt/pw-browsers/chromium` when it exists.
- `bun run typecheck` must stay clean.
