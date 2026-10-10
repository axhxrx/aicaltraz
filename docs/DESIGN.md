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
| PUT | `/api/config` | admin | body `{config, baseRev, force?}` → 200 `{rev, warnings: string[]}` (saved; `warnings`: what would fail when pressed, see Config store); 400 `{errors:string[]}`, `parseConfig`'s `path: message` with index paths (`pads.0.buttons.5.holdMs: …`, for mapping onto fields); 409 `{rev, invalid?, errors?}` if `baseRev` ≠ the rev of the file's bytes now, valid or not (`invalid: true` + the file's `errors`, worded by id, when they aren't a valid config). `force: true` skips the check (replace whatever is there). 500 `{error, errors:[error]}` when the write fails (disk full, read-only file system…): the message says why, and the file is left as it was |
| GET | `/api/state` | any | `{states: StateMap, serverNow}` |
| POST | `/api/press/:pad/:button` | any | For curl/Stream Deck/etc. Optional `at` (when it was pressed: host clock, epoch ms; absent = now) and `confirm`, as `?at=…&confirm=1` or a JSON body `{"at": …, "confirm": true}`. → 200 `{result: PressResult, runId?, state}` (`expired` included); 404 unknown button; 428 `{result: "needs-confirm", error}` for a `confirm` button pressed without confirm; 503 `{error: "host full", reason: "rate limited" \| "too many running actions", result: "ignored"}` + `Retry-After: 1` when a limit refuses it; 400 for a malformed `at`, `confirm` or body |
| GET | `/api/runs?pad=&button=` | admin | `RunRecord[]`, newest first, last 20 per button (both params optional) |

JSON bodies capped at 1 MB. Unknown routes 404.

### WebSocket

See `ServerMsg`/`ClientMsg` in `src/core/protocol.ts`.

- On connect: `hello` (role, redacted-or-full config, rev, all states, serverNow, host info, and
  `latched`: the latched device state per button key, see `@state`).
- Every state change → `state` to **all** clients; a latched device state change → `latched`
  `{key, text}` (`null` = cleared) to all. Config change (UI save or hand edit) → `config` to all
  (each redacted for its role).
- `press` → host replies `ack` to that client with the `PressResult`, then state broadcasts follow.
  For `started`/`queued`/`cancelling` the ack carries `runId`: the run the press started, is queued
  behind, or is cancelling. A press may carry `at` (when the user fired it, in the host's clock:
  the client's clock plus the offset learned from `hello.serverNow`) and `confirm: true` (it went
  through the button's confirm step); see State store.
- Malformed message → `error`, keep the socket (also for a non-number `at`, a non-boolean `confirm`).
- At most 64 connections (all roles together; the last 8 only for the admin token) and 16 per
  client address; beyond that the upgrade is refused with 503
  `{"error":"host full","reason":"too many connections"}`. Logged at most once per 10 s, with a count.

### Config store

- Source of truth is the file. Hand edits are first-class: watch the file (debounce ~200 ms, at
  most 1 s for a file that keeps changing), re-parse, and on success swap + broadcast. On failure
  keep the old config, log the errors and send `configError` to admins.
- Watching = `fs.watch` on the directories (survives editors' rename-over) **plus a stat poll every
  2 s** (dev/ino/size/mtime of the configured path, and the identity of each watched directory), for
  what fs.watch misses: the directory moved away and recreated, a symlinked directory swapped
  (deploy-style `ln -sfn rel2 current`), a single-file bind mount edited from outside, network file
  systems. A watched directory that was replaced gets a new watcher.
- Only regular files are read: a FIFO, device, socket or directory is refused ("… is a named pipe
  (FIFO), not a regular file") without blocking (stat first, then open non-blocking and fstat). At
  most 16 MB.
- `rev` = sha256 (hex, first 16 chars) of the file's bytes.
- The file's errors (CLI, host log, `configError`, a 409's `errors`) are worded for whoever edits it:
  JSON syntax errors as `invalid JSON at line 12, column 5: a comma is missing between "holdMs" and
  "key"`; validation errors all in one pass (field errors together with
  duplicate ids, overlaps and buttons outside the grid), named by id, with the line, in file order:
  `pad "lights" › button "key": holdMs must be ≤ 5000 (line 42)` (`pad #2` / `button #3` when the id
  can't name it). `parseConfig` itself, and so PUT's 400, keeps `path: message` with index paths,
  which the editor maps onto its fields.
- UI saves: validate with `parseConfig`, write safely (below), compact output (omit button fields
  equal to their schema defaults; 2-space JSON). A new file is created 0600 (it holds commands and
  their env); a rewrite keeps the file's mode.
- Every file the host writes (config, secrets, state) goes through one safe write
  (`atomicWrite`, src/server/files.ts): a temp file in the same directory, written fully (short
  writes continued), fsync'ed, read back and compared, renamed over the target, then the directory
  fsync'ed. Any failure throws with the target untouched and no temp file left: a full disk is a
  500 "no space left on the device (ENOSPC); it was left as it was", never a cut-off file. A target
  that can't be renamed over (a single-file bind mount, Docker-style: EBUSY/EXDEV; a directory
  without write permission) is rewritten in place instead: grown first (a full disk fails before
  any old byte changes), overwritten, truncated, fsync'ed, read back; on failure its old bytes are
  put back. It refuses to replace anything but a regular file, or a file without write permission;
  errors name the real cause (EROFS), not a failed cleanup.
- After a save, the 200 carries `warnings` (also logged, and printed at startup): what would fail
  when pressed, resolved as the runner resolves it (relative to the action's working folder, else
  PATH, from the action's env if it sets one): command not found / not executable / no `#!` line /
  interpreter missing, shell missing, working folder missing, `stops` patterns that match no other
  button. They never block the save.
- Paths given to `--config`, `--secrets`, `--tls-cert`/`--tls-key` and `BUTTPAD_CONFIG` may start
  with `~/` (quoted, or after `=`, the shell leaves it). Startup failures say what to fix: `can't
  listen on 192.0.2.7:8787: no network interface on this machine has the address 192.0.2.7
  (server.host in the config); …`, `port 8787 is in use (another ButtPad?)`, a host name that doesn't
  resolve, unreadable TLS files.
- A save's `baseRev` must name the file's bytes as they are at that moment, valid config or not: a
  hand edit with a typo, or one caught mid-write by a non-atomic editor, is someone's work too, so
  it gets a 409 (`invalid: true`), never a silent overwrite. The file is read again right before
  the rename; a write that landed meanwhile stays and the save gets a 409. `force: true` (the user
  chose to overwrite) skips both checks.
- A symlinked config is read and watched through its path: saves replace the link's current
  target; edits of the target and replacing the link itself (`sed -i`) are both picked up. Relative
  paths (actions, secrets) resolve against the directory of the file the path's own symlink points
  to (a config linked from a dotfiles checkout runs the scripts next to the real file); symlinked
  directories above it are followed when an action starts, so after a deploy-style swap actions run
  from the new release.
- Removing a button that is running kills its action. Changing a running button's action does not
  affect the current run.

### Runner

- `exec`: `Bun.spawn([command, ...args])`. `shell`: POSIX `[shell ?? '/bin/sh', '-c', script]` —
  never `$SHELL`, so a script behaves the same whether the host was started from a terminal or by a
  service (a bash-ism that worked by hand would fail under systemd); Windows
  `[shell ?? %ComSpec% ?? 'cmd.exe', '/d', '/s', '/c', script]`. `none`: no process at all (see
  State store, `stops`).
- `cwd` defaults to the config file's directory; relative `cwd` resolves against it too.
- env = host env + action `env` (names `[A-Za-z_][A-Za-z0-9_]*`) + `BUTTPAD_PAD`, `BUTTPAD_BUTTON`,
  `BUTTPAD_RUN_ID`, `BUTTPAD_LABEL`.
- stdin ignored. Spawn detached (POSIX: own process group) so kill hits the whole tree:
  SIGTERM to `-pid`, then SIGKILL after 2 s. Windows: `taskkill /T /F /PID`. A killed run is
  *dying* until its group is seen empty (on Linux, zombies awaiting their reaper don't count) or got
  the SIGKILL. A group seen empty is never signalled again: its id may be recycled.
- **Output protocol** (stdout, line-based, UTF-8; `\n`, `\r\n` or a bare `\r` ends a line, so a
  progress bar's last line is what was left on screen):
  - `@progress N` (0–100) → `progress`; `@status text` → `status`; `@result text` → result text;
    `@state text` → the button's latched device state ("REC ●", "ON 80%"; ≤ 40 chars), `@state`
    alone clears it (see State store).
  - Without `@result`, result text = last non-empty, non-`@` stdout line; on failure with no
    stdout, last non-empty stderr line; spawn error → the error message. Truncate to 200 chars.
  - Result, status and latched text are sanitized: ANSI CSI/OSC/DCS sequences, C0/C1 control
    characters and bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069) are removed, tabs become
    spaces. Cut between graphemes, with an ellipsis.
  - A last line without a newline counts, even while a background process holds the pipe open.
  - Output is read in turns with everything else: a flood (`yes`) can't stall timers or other presses.
  - When the main process has exited and its pipes had 250 ms to drain, the host closes its ends
    and stops reading: a background process still writing there gets EPIPE/SIGPIPE (`(yes &); echo
    x` would otherwise keep the host at 100% CPU forever). Background children of a finished run are
    otherwise left alone, not killed (a button may start a daemon on purpose: redirect its output).
- Timeout (`timeoutMs`) → kill → failure reason `timeout`. Spawn failure → `spawn`, with text like
  `command not found: X`, `permission denied (chmod +x?): P`, `is a directory: P`,
  `not executable as a program (missing #! line?): P`, `interpreter not found (check the #! line): P`.
  Every client sees that text, so it names files by their base name (`command not found:
  light.sh`); the admin run log's `error` has the full path.
- Run log (`RunRecord`, admin): `command` (what ran: the argv shell-quoted, `/bin/sh -c '…'` for a
  shell action), `cwd` (resolved), `error` (the spawn failure in full, or how the host stopped it).
- Durations and throttles use a monotonic clock; only `startedAt`/`endedAt` are wall-clock (epoch ms).
- Keep only tails in memory: 16 KB per stream per run; last 20 runs per button.

### State store

Holds `RunState` per button, runs `transition()` from `machine.ts`, performs the effects (start →
runner, kill → runner, scheduleReset → timer that feeds back `reset`, scheduleRequeue → timer that
feeds back `requeue`), broadcasts every change. READY's `last` (how the previous run ended) comes
from the machine; it is restored from the state file at startup.

A press is answered, checked in this order, with:

- `unknown-button`: no such button.
- `expired`: it carries `at`, and by the host's clock it is more than `PRESS_MAX_AGE_MS` (3 s) old
  when the host gets to it. Nothing runs; logged (at most once per 10 s, with a count). A press made
  in a dead zone that TCP delivers 14–45 s later lands here, and so does one that waited while the
  host itself was frozen (SIGSTOP, a stalled event loop): the age is taken when the host handles
  it. An `at` in the future (clock skew) counts as now; no `at` (curl) is accepted.
- `ignored`: a re-run is already queued (`queued` on RUNNING, or on the result it shows before the
  re-run starts).
- `needs-confirm`: it would start (or queue) a run of a `confirm` button and doesn't carry
  `confirm: true` (HTTP: `?confirm=1` / `{"confirm": true}`). Cancelling needs no confirm. The
  browser's confirm step is an accident guard; this makes it a rule for every client: a press token
  handed out by QR code can't run "Format card" with a bare curl.
- `ignored`: running with `whileRunning: ignore`; (`cancel`) within 700 ms of the run's start (a
  double press must not start and cancel at once), or the cancel no longer reaches a process (the
  action already exited, its output is still draining: the run ends as what it was); it would start
  a run while an earlier one of that button is still alive or dying (removed and re-added
  meanwhile, a killed group in its grace period, a previous host's leftover): never two instances
  of one button; or a limit refuses it (below).
- otherwise `started` / `queued` / `cancelling`. A cancel drops a queued re-run.

Limits, on presses that would start or queue a run: token buckets of bursts of 10, then 5/s, per
WebSocket connection and per client address (all of an address's connections and its HTTP presses
together: more sockets don't buy a device more presses), so one press token can't lock everyone
out; one over all sources of bursts of 40, then 20/s; and at most 32 runs at a time. A refusal is
`ignored` over WebSocket and a 503 "host full" over HTTP; logged at most once per 10 s with a
count. Behind a reverse proxy every client has the proxy's address, and shares these limits (and
the 16-connection cap).

Queue: when a run with a queued re-run ends, its result is broadcast (with `queued: true`) and shown
for `REQUEUE_GAP_MS` (800 ms) before the re-run starts, so a failure is seen rather than hidden
behind the next run. The re-run waits longer while an earlier run's processes are dying or 32 runs
are going.

`stops` and `none`: a press that will start a run (a queued re-run too) first cancels every RUNNING
button its patterns name (`pad/button`, `pad/*`, `*`; never itself), whatever their own
`whileRunning`, and drops their queued re-runs (also one waiting out its result). Those runs end
FAILURE `cancelled` with the text `Stopped by <label>`. Action `none` runs nothing: success at once,
text `Stopped N` when it stopped N > 0 runs, else `Done`.

Kill reasons, distinct in RunRecord.error and the host log (`■ pad/button #7 1.2s <reason>`):
`cancelled from a device` (the log adds the connection's address), `stopped by <label>`,
`stopped: button removed by a config change`, `stopped: host shutdown` (reason `interrupted`),
`timed out after <time>` (reason `timeout`, logged `✗`).

`@state` (latched device state): per button, kept across runs (failed ones too) and restarts; sent
in `hello.latched` and as `latched` broadcasts; `@state` alone clears it; removing the button
drops it.

### Run state file

`buttpad.state.json` next to the config (mode 0600) holds what must survive a restart or a crash:
per button the last run id, last result and latched state; the runs in flight `{key, runId, pid,
pgid, startedAt, fingerprint, command, cwd}`. Written with the config store's safe atomic write,
throttled: routine changes at most every 250 ms (≤ 4/s), a run's start or end within 50 ms; and at
shutdown and in the process `exit` handler. A save that fails is logged once (and when it works
again); the host keeps going.

At startup, once the port is bound (a second host that can't bind never touches the first one's
runs):

- Run ids continue where they left off, also past runs that were in flight.
- Each run that was in flight: if its process is still alive and its start-time fingerprint matches
  (Linux: `/proc/PID/stat` starttime plus the boot id; elsewhere `ps -o lstart=`) — the PID may
  have been reused — the host SIGTERMs its process group and SIGKILLs it after 2 s; presses of that
  button are `ignored` until it is gone. Anything else (another process now has the PID, no
  fingerprint) is left alone. Either way the button shows FAILURE `interrupted`
  ("Interrupted: host restarted") for its resultHoldMs, then READY with that as `last`; the run log
  gets a record of it. On Windows there is no fingerprint: nothing is killed.
- A graceful shutdown keeps the runs it stopped in the file (`stopped: "shutdown"`): the next host
  reports them the same way.
- A missing, unreadable or unknown-version file: start fresh, with a log line; the next save replaces
  it. A file whose writer is still running (its pid and fingerprint alive): this host neither saves
  nor touches that host's runs, and says so.
- Not covered: a crash during a killed run's 2 s grace period (its main process had already exited)
  leaves SIGTERM-ignoring grandchildren behind; background processes of a finished run aren't tracked.

## Client

### Connection & pairing

- Token from `location.hash` `#token=…` → `localStorage` (`buttpad.token`), then strip the hash
  with `history.replaceState`. No token → pairing screen: explain how to pair (scan the QR the
  host prints / open the pairing URL), with a paste field.
- WS with auto-reconnect (backoff 0, 250 ms → 5 s). The backoff starts over only after a
  connection held 10 s: a host or proxy that drops every socket right after `hello` is not
  hammered. Reconnect gets a fresh `hello`; state is authoritative from the host, so a reload or
  flaky Wi-Fi never loses track of a running action.
- Liveness: a link can die without a TCP close, and the host sends no heartbeats, so the client
  asks. A socket quiet for 5 s (page visible) gets `{"t":"ping"}`; the host answers a type it
  doesn't know with `error`, and any frame counts as the answer. Nothing back in 3 s (1.5 s when
  in doubt: back from the background, a window `online`/`offline` event, a press with no ack) →
  the socket is dropped on the spot (handlers detached, its unacked presses failed, OFFLINE) and
  a new one opened; nobody waits for the browser's close handshake (up to a minute on a dead
  link). Every socket keeps its own pending presses and timers: a stale socket's late events
  can't touch the current one.
- Startup: alongside the first socket, `GET /api/state` (and `/api/config` when no layout is
  cached): a rejected token shows at once, and a socket that hangs doesn't show a running action
  as READY. While offline the last-known states stay on screen (see OFFLINE).
- A press goes out at once or not at all, never queued for later (a press that fires late is
  worse than none): NOT SENT if it never left the device, NO RESPONSE if it was sent and no ack
  came within 2 s of sending. If the host's state later shows the button's `runId` went past
  the one seen at press time, the press did run: the button shows that (RUNNING, SUCCESS,
  FAILURE, or "IT RAN" when it already finished), not NO RESPONSE. (A press frame the OS had
  already handed to TCP can still arrive if the link recovers before the connection times out;
  only the host could drop such stale presses, which would need a timestamp in the protocol.)
- 401 → "token rejected" screen with re-pair option. "Pair again" in the menu takes a second tap,
  and isn't there under `?lock`.
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
| CONFIRM | client | (confirm buttons) after first fire: flashing amber border + "AGAIN TO CONFIRM", times out after `confirmWindowMs`. A press begun inside the window confirms, even if it completes after it |
| SENDING | client | from fire until the host acks (normally ms); if no ack in 2 s → FAILURE "NO RESPONSE". Pressing again meanwhile → BUSY (nothing is dropped silently) |
| RUNNING | host | diagonal stripes scrolling across the whole button + elapsed seconds; `@status` text; `@progress` → determinate fill instead of stripes; `cancel` buttons show "tap/hold to cancel" once a cancel would count (700 ms after the start, see State store) |
| SUCCESS | host | full-bleed green flood, giant ✓, result text, small elapsed; a thin bar drains over `resultHoldMs` |
| FAILURE | host | full-bleed red, giant ✗, slow pulse, result text / exit code / "TIMEOUT"/"CANCELLED"; drains like success |
| OFFLINE | client | grey, dashed border, ⚠; the last-known state stays visible underneath (stripes or progress dimmed and still, a green/red tint for a result, "RUNNING · 12s" / "LAST RUN: EXIT 3"); presses do nothing except shake |

Badges flash over any state: BUSY (pressed while running or sending), BUSY / TRY AGAIN (the host
refused a start for now: rate limit, last run still dying), NOT SENT, IT RAN, NOT ON HOST.

Text is laid out where it was measured: labels break only at spaces and at the phrase boundaries
`Intl.Segmenter` finds in CJK/Thai text (rendered as `<wbr>`, with `word-break: keep-all`, and
`auto-phrase` where the browser has it), so a size computed for two lines is laid out on two.
Short buttons (≤ 84 px) put their items in one row with fixed shares of the width, dropping the
glyph and then the number/title when the button isn't wide enough.

Triggers:

- `hold`: fires when held `holdMs`. Released early → back to READY (fill drains fast).
  Finger moving more than `driftPx` from the start point → cancel.
- `tap`: fires on pointer up if it didn't drift, and if it was down at most 1.5 s (a resting
  thumb is not a tap).
- `double`: two taps within 400 ms.
- Timing goes by the input events' own timestamps, not by when a handler ran: on a stalled main
  thread a finger lifted before `holdMs` doesn't fire, one held past it does (a late hold timer
  first lets queued input land).
- A second contact on a pressed button (rolling thumb, glove) joins the press and carries it on
  when the first lifts. The trigger and timings are taken when a press begins: a config change
  mid-press doesn't change it.
- Keyboard: `key` maps a KeyboardEvent.key to a button (BLE remotes/clickers pair as keyboards,
  and send keydown and keyup together). A mapped key fires on keydown for `hold` and `tap`
  buttons alike (no hold); `double` = two keydowns within 400 ms; confirm still applies;
  auto-repeat ignored. Enter/Space on a focused control stay with that control.
- Multi-touch: each button tracks its own pointers; pressing two buttons at once works.
- Haptics: `navigator.vibrate` where it exists (touch, fire, confirm, success, failure, busy,
  denied, a soft "cancelled" for a press that came to nothing, "unknown" for NO RESPONSE). iOS:
  the first tick happens synchronously in the gesture handler. Optional sounds (device setting,
  default off), unlocked on any user-activation event.

### Keep awake

Wake Lock API needs a secure context, which a LAN `http://` page isn't. So: use Wake Lock when
available; otherwise fall back to a muted, inline, looping tiny video (the NoSleep trick). Show
the keep-awake status in the menu. Re-acquire on `visibilitychange`. Until the screen is held,
every user-activation event (a touch counts on its way up) starts the video synchronously inside
the handler.

### Edit mode (admin only)

- Entered from the menu. Grid lines visible. Tap an empty cell → new button there. Drag a button
  to move, drag its corner handle to resize; snaps to cells; overlap/out-of-bounds is refused
  visibly (red ring, a shake). A duplicate lands with a calm glow instead.
- Selecting a button opens an editor (bottom sheet on phones, side panel on wide screens): label,
  color, trigger, holdMs, driftPx, confirm (+ confirmWindowMs), cooldownMs, key, whileRunning,
  timeoutMs, resultHoldMs, id; the action (type switch: shell: script + shell + cwd + env; exec:
  command + args list + cwd + env; **Nothing (stop others)**: `none`), and **Stops** (any type):
  chips per pad for `pad/button`, "All of <pad>" for `pad/*`, a switch for `*` (everything); a
  wider pick shows what it covers, a pattern naming nothing is listed to remove. Renaming or
  deleting a button or pad in the editor carries the patterns along (or drops them), in the same
  undo step. Duplicate, delete.
- Number fields show their range (hold 100–5000 ms, confirm window 0.5–60 s, cooldown 0–10 s,
  time limit up to 24 h, result up to 60 s); arrow keys stay inside it; an out-of-range value is an
  inline error in words ("Must be at most 60000 ms (1 min)") that blocks saving. A half-typed value
  is left alone. Labels (≤ 200) and pad names (1–60, not blank) are saved trimmed: the draft is
  tidied right before the PUT, so the host's copy is exactly the draft.
- Non-blocking warnings: a READY color that reads like SUCCESS green or FAILURE red (by OKLCH hue
  and chroma; the palette's pink/orange/teal are fine); a key also bound on another pad (keys work
  from every pad: the visible pad's button first, else the one unique match, else nothing); a
  Nothing button that stops nothing.
- A new button's action is a placeholder that fails visibly when pressed ("No action set — edit
  this button", via stderr and exit 1), never a ✓ for nothing. Switching a placeholder (or
  Nothing) to another type starts that type blank: no sample `sh -c` arguments left behind.
- Pad management: add, rename, delete, reorder, cols/rows (shrinking that would clip buttons is
  refused with an explanation).
- Edits are a local draft until **Save** (PUT with `baseRev`). Unsaved indicator; **Discard**
  (undoable) in plain sight on every layout. Validation errors from the host are shown; long lists
  ("+3 more": a broken file's errors, the problems) open up in full. The host's PUT `warnings`
  (saved, but e.g. a program it can't find) show after the save as a notice, and on the button they
  name (an amber badge, a callout in its editor) until that part of it changes. Dialogs that could
  destroy work focus their safe way out (Cancel / Keep editing).
- The draft is kept on the device (localStorage, per host origin; written right after each change
  and when the page is hidden) until saved or discarded: a reload, an evicted tab, a rotated token
  (401) or a pairing link opened in the tab don't lose it (a pairing link opened while the draft is
  dirty asks first). The next edit session, and run mode for an admin, offers it back ("Restore
  unsaved changes from 10:42?"), merged with the host's config as it is by then.
- The host config changing under the draft (hand edit, another admin): with nothing unsaved it is
  simply taken. Under unsaved changes it is merged: a three-way merge (`src/web/edit/merge.ts`;
  base = the config the draft started from, mine = the draft, theirs = the host's now) at pad and
  button granularity. What changed on one side only merges on its own, as one undoable step
  ("Merged 2 changes from the host"). The same pad or button changed on both sides, or deleted on
  one and changed on the other, is listed, and the user picks mine or theirs per item. Identity
  follows the draft's renames (a pad or button id changed in the draft still gets their changes).
- This session's own saves coming back over the socket (late, or several in a row) are not news;
  neither is what a lagging socket says before it gets to a state already learned over HTTP.
- A save with no answer within 10 s, or whose link dropped, is checked with `GET /api/config`: if
  the host has exactly what was sent, it saved (also when the socket's echo shows it later). A 409
  gets the same check, then offers: merge their changes (fetched fresh), overwrite with mine
  (`force`), or cancel. A config file on the host that is currently invalid is replaced only after
  the user confirms (`force`).
- Saving asks first when it would stop running actions (a running button deleted, or its or its
  pad's id changed): "This will stop: “Record” (running 2 min)". The canvas marks running buttons;
  the id fields say what an id change breaks (`?pad=` links, `/api/press/…`, run histories).
- New buttons never take an id the host has on that pad (e.g. one deleted in the draft): until the
  save, that id still names the host's button. Duplicates don't copy the key binding.
- Shell ⇄ Program switching keeps the meaning: only a plain word list becomes argv (no quotes, `~`,
  `NAME=value`, globs, `$`, shell syntax or builtins); anything else becomes `sh -c SCRIPT`, which
  switches back unwrapped. argv becomes a properly quoted command line. Empty arguments get a
  warning (allowed); env names are checked as typed.
- Admin extra: per-button run log (from `/api/runs`) to see why something failed: outcome, the
  output tails, what ran (`command`), in which folder (`cwd`), and why it couldn't start or was
  stopped (`error`). It refetches every second while the button runs. **Run now** for a saved,
  unchanged button; otherwise **Save & run** (saves the draft, then runs the saved version). On a
  `confirm` button both ask first (a dialog that focuses Cancel) and the press then carries
  `confirm: true` (the host refuses unconfirmed ones). While the button runs, Run now is never a
  silent cancel: it's **Cancel run** for `whileRunning: cancel`, else a disabled "Running…".

## Testing

- `bun test` — unit + integration (machine, config, runner, HTTP/WS against a real host on port 0).
- `npx playwright test` (Node) — browser tests in `e2e/`. Chromium only here:
  `e2e/playwright.config.ts` points at `/opt/pw-browsers/chromium` when it exists.
- `bun run typecheck` must stay clean.
