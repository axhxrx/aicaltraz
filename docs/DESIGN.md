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
                       [--rotate-tokens] [--no-qr] [--no-pair-code] [--ready-json] [--dev]
                       [--tls-cert PATH --tls-key PATH] [--allow-origin ORIGIN]…
```

- `--config` default `./buttpad.config.json` (env `BUTTPAD_CONFIG`). Missing file → write the
  built-in starter config there and say so.
- `--secrets` default: `<config dir>/buttpad.secrets.json`. Created on first run, mode 0600.
- `--host/--port` override `config.server`. `--port 0` = pick a free port.
- On start, print for each non-internal IPv4 (plus localhost, plus each `--allow-origin`) the
  **pairing URLs** `http://IP:PORT/#token=PRESS_TOKEN` and the admin one; next to them a one-time
  admin **pairing code** for a phone (see Pairing): `Pair a phone as admin: open
  http://IP:PORT/#pair and enter 123 456 (valid 10 min)` (`--no-pair-code`: none); a terminal QR
  code of the press URL for the first LAN IP (unless `--no-qr`). Warn that it's plain HTTP. The
  config's warnings (see Config store) come first. The web app is built and compressed right after
  listening, so the first page load doesn't wait for it.
- `--allow-origin ORIGIN` (repeatable; also `BUTTPAD_ALLOW_ORIGINS=O1,O2`): pages served from
  this exact origin — `scheme://host[:port]`, no path, no wildcard (refused with a usage error) —
  may open the WebSocket and pair, besides the host's own: a **reverse proxy** in front of the host
  (an HTTPS tunnel, an app's preview pane) whose page Origin is its own and which forwards with
  another Host. Everything is served at the root path, so the app works behind one as is (assets,
  `/api`, `/ws` as `wss:` from an https page, pairing); every client then has the proxy's address,
  and shares the per-address limits.
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
- HTTP: `Authorization: Bearer <token>`. Constant-time compare. Role = whichever token matched.
  Anything else → 401 (WS: reject the upgrade with 401).
- WebSocket: a browser can't set headers on one, and a URL ends up in logs (a reverse proxy's, a
  preview pane's: QA found the admin token in one, ~1 line a second while a probe ran), so **a
  browser never puts a token in a URL**. It trades its token for a one-time **ticket** —
  `POST /api/ws-ticket` with the Bearer header → 200 `{ticket, expiresInMs}` (`WsTicket`) — and
  opens `/ws?ticket=<ticket>` at once. A ticket is 32 random bytes (base64url), valid 30 s (the
  host's monotonic clock), and carries the role of the token that made it. It is good for one
  request: the first `/ws` request that shows it uses it up, whatever becomes of that request (a
  403, a 503, a plain request with no upgrade), so a ticket a proxy logged is worthless. An unknown,
  used or expired one → 401, like a wrong token. At most 64 are out per token: making one more
  drops that token's oldest (a press-token holder can't crowd out admin tickets). Kept as sha256
  digests. With `ticket` in the URL, `token` is ignored. `/ws?token=<token>` still works for
  scripts and other non-browser clients (their URL stays on their machine); browsers use tickets.
- A WS upgrade whose `Origin` host differs from its `Host` header → 403 (cross-site WebSocket
  hijacking), unless that Origin is one `--allow-origin` names exactly. No `Origin` (curl,
  scripts) is fine. A refusal is logged (at most once per 10 s, with a count) with the Origin and
  Host it saw and the flag that would allow it: `refused a WebSocket from a page at
  https://x.example (the request's Host is 127.0.0.1:8787): not this host's own address. If that is
  ButtPad through your reverse proxy (or a preview pane), start ButtPad with --allow-origin
  https://x.example`. `POST /api/pair` (no token), `POST /api/ws-ticket` and `POST /api/ws-check`
  take the same check. The 403 says it to the page too (`OriginRefusal`): `{"error": "cross-origin
  WebSocket refused" (pairing: "cross-origin request refused"), "origin": "https://x.example",
  "allowOrigin": "https://x.example"}` — `allowOrigin` is the exact `--allow-origin` value that
  would allow it, absent for an origin that never can be (`null`, malformed).
- `POST /api/ws-check` (Bearer header, any role, no body) is the client's probe, with nothing in the
  URL: what a WebSocket upgrade from this page would get now. 204: it would be taken; 401: the
  token is rejected; 403 (the body above): this page's origin is refused; 503 `{"error": "host
  full", "reason": "too many connections"}`: no room now for this role or address. It is a POST
  because a browser sends `Origin` on a same-origin POST but not on a same-origin GET (which would
  always look allowed); GET → 405.
- Pairing codes (see Pairing) trade for these tokens; they are not tokens themselves.
- The browser **never sends commands**: a press names `pad`+`button`; the host looks up the action.
- Press role never receives `action` fields (see `WireConfig`). Only admin can PUT config or read
  run logs. But every client sees each run's result text (≤200 chars, see Runner): a script must not
  print a secret as its last line.
- The admin token is a remote-shell credential. Treat it as such in docs and UI.
- **Known limitation (host security): no Host-header allowlist yet, so DNS rebinding gets past the
  origin checks.** They compare a page's Origin with the request's own Host header; a page whose
  DNS name was re-pointed at the host (`http://evil.example:8787` now resolving to 192.168.1.20)
  sends Origin and Host `evil.example:8787` alike, and to the browser it is same-origin. Such a
  page gets nothing that needs a token, can't read the tokens paired devices stored (they belong to
  the host's real origin), and its code guesses are rate limited like anyone's (Pairing). But one
  that already **knows a valid pairing code** (shown on a screen, read out, printed at startup)
  could trade it for that code's token over `POST /api/pair`. Planned fix: answer only requests
  whose Host is one of the host's own addresses or names (its interfaces' IPs, `localhost`, its
  host name and `<name>.local`) or an `--allow-origin` host, and refuse the rest (421).

### HTTP API

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/` | none | the web app (Bun HTML import of `src/web/index.html`), and its hashed chunks at `/chunk-….js`/`.css`: compressed, see Web app |
| POST | `/api/pair` | none (the code is the credential) | body `{code}` (`"123456"`; spaces, `-` and `.` are ignored) → 200 `{token, role}` (`PairResponse`); 401 `{error: "wrong or expired code"}` for a wrong, used or expired one alike; 429 `{error: "too many attempts: try again in N s"}` + `Retry-After: N` (seconds, the same N) when attempts are coming too fast (Pairing); 400 for a body without `code`; 403 `OriginRefusal` for a page of another origin |
| POST | `/api/ws-ticket` | any | no body → 200 `{ticket, expiresInMs}` (`WsTicket`): a one-time ticket for `/ws?ticket=…` (see Auth); 403 `OriginRefusal` for a page of a refused origin |
| POST | `/api/ws-check` | any | no body → what `/ws` would answer this page now, without upgrading: 204 it would be taken; 403 `OriginRefusal`; 503 host full (`{error, reason}`); 401. POST, not GET: see Auth |
| POST | `/api/pair-code` | admin | body `{}` (or none) for an admin code, `{"role": "press"}` for a press one → 200 `{code: "123456", expiresAt (host clock, epoch ms), role}`; 400 for another role |
| GET | `/api/health` | none | `{ok:true, version, protocol}`; no host name (anyone can ask, even a DNS-rebinding page; `hello` has it) |
| GET | `/api/config` | any | `{config: WireConfig, rev}` (redacted for press) |
| PUT | `/api/config` | admin | body `{config, baseRev, force?}` → 200 `{rev, warnings: string[]}` (saved; `warnings`: what would fail when pressed, see Config store); 400 `{errors:string[]}`, `parseConfig`'s `path: message` with index paths (`pads.0.buttons.5.holdMs: …`, for mapping onto fields); 409 `{rev, invalid?, errors?}` if `baseRev` ≠ the rev of the file's bytes now, valid or not (`invalid: true` + the file's `errors`, worded by id, when they aren't a valid config). `force: true` skips the check (replace whatever is there). 500 `{error, errors:[error]}` when the write fails (disk full, read-only file system…): the message says why, and the file is left as it was |
| GET | `/api/state` | any | `{states: StateMap, serverNow}` |
| POST | `/api/press/:pad/:button` | any | For curl/Stream Deck/etc. Optional `at` (when it was pressed: host clock, epoch ms; absent = now; older than the button's `maxLatenessMs` → `expired`) and `confirm`, as `?at=…&confirm=1` or a JSON body `{"at": …, "confirm": true}`. → 200 `{result: PressResult, runId?, state}` (`expired` included); 404 unknown button; 428 `{result: "needs-confirm", error}` for a `confirm` button pressed without confirm; 503 `{error: "host full", reason: "rate limited" \| "too many running actions", result: "ignored"}` + `Retry-After: 1` when a limit refuses it; 400 for a malformed `at`, `confirm` or body |
| GET | `/api/runs?pad=&button=` | admin | `RunRecord[]`, newest first, last 20 per button (both params optional) |

JSON bodies capped at 1 MB. Unknown routes 404.

### Pairing

A phone becomes an admin (or press) device by a one-time code instead of a 43-character token
(src/server/pairing.ts): the host prints one at startup next to the admin URL, an admin device
makes more (menu → Pair another device; `POST /api/pair-code`), and the other device opens
`…/#pair` and types it (`POST /api/pair` → the token). A code is 6 random digits, valid 10 minutes
(by the host's monotonic clock), used once; at most 3 are valid at a time (making a 4th drops the
oldest); a used or expired one is gone. Every attempt compares every valid code, in constant time
(sha256 digests, `timingSafeEqual`), right or wrong. Attempts are limited per client address (5 at
once, then 5 a minute) and over all addresses together (10 at once, then 20 a minute: an attacker
on the LAN can take many addresses); past either, 429 without comparing anything. The log says when
a device paired (and from which address), when an admin made a code, and wrong codes (once per
10 s, with a count) — never a code itself, except the startup one.

The trade-off, in numbers: while one code is valid, everyone together gets at most 10 + 20 × 10 =
210 guesses at 1 in 10⁶, so a LAN attacker guessing flat out wins with p ≤ 2.1 × 10⁻⁴ per code
(6.3 × 10⁻⁴ with 3 codes out) — and the pairing's legitimate user is the one locked out meanwhile
(429), which says something is wrong. Fewer digits would raise that tenfold per digit (5 digits:
2 × 10⁻³), hence ≥ 6. For comparison, the plain-HTTP admin URL itself crosses the Wi-Fi in the
clear every time a device connects; on a network where that is acceptable, so is this. A code can
be traded only from the host's own pages (or `--allow-origin` ones): a page elsewhere can't burn it.

### Web app

`/` and the bundle's chunks are served by the host (src/server/web-assets.ts), not by Bun's HTML
import route, which sends them uncompressed: gzip (level 9) for every compressible file over 1 KB,
and brotli (quality 11, made in the background: it takes ~0.9 s here, seconds on a Pi; gzip is
served until it is ready), chosen by Accept-Encoding (`Vary: Accept-Encoding`), each encoding with
its own ETag; `If-None-Match` → 304; HEAD; only GET/HEAD. The page is `no-cache` (revalidated, so
a new version shows at once), the hashed chunks `max-age` a year, `immutable`. Run from source,
the bundle is built in memory as Bun builds it in production (`Bun.build`: minified, no source
maps, `NODE_ENV=production` — byte for byte the size Bun serves); in a compiled host
(`bun build --compile`) it is the one in the executable, which `--compile` only minifies with
`--minify`. `--dev` keeps Bun's own serving (HMR). Measured on this app (round 4): 495 KB
uncompressed before; 188 KB with gzip, 169 KB with brotli (−66 %); the first `/` after startup
10 ms (preloaded).

### WebSocket

See `ServerMsg`/`ClientMsg` in `src/core/protocol.ts`.

- Connect to `/ws?ticket=<ticket>` (browsers: a one-time ticket from `POST /api/ws-ticket`, made
  right before each attempt) or `/ws?token=<token>` (scripts); see Auth. The upgrade answers 403
  (`OriginRefusal`), 401, 503 (`{"error":"host full","reason":"too many connections"}`) or 426 (a
  plain request: "expected a WebSocket upgrade"); a browser can't read those, so its client asks
  `POST /api/ws-check` afterwards.
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
- UI saves: validate with `parseConfig`, write safely (below), compact output that stays close to
  what the author wrote (`serializeConfig`): button fields equal to their schema defaults, exec's
  empty `args` and a `server` block at its defaults are left out — except fields the author wrote
  out for that button, even at a default; arrays of strings/numbers, and objects of only those, go
  on one line when it stays within 100 characters (`"args": ["wash", "100", "10"]`, a short
  `"action": { … }`); 2-space JSON otherwise. Key order follows the file being replaced (top level,
  pads and buttons by id, actions of the same type); a new key goes right after the last key the
  author has that precedes it in schema order (`timeoutMs` after `holdMs`), a new button follows
  the order of its pad's first one; without a file, schema order. Values round-trip exactly (QA:
  a 69-line hand-written file became 302 lines after one save; now 193, in its own order). A new
  file is created 0600 (it holds commands and their env); a rewrite keeps the file's mode.
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
  button, a `group` with no other button; a `key` that never fires (a modifier on its own:
  Control, Alt, Meta/⌘, AltGr — the page leaves those to shortcuts); a `shell` script run by
  /bin/sh (no `shell`, or `sh`/`dash`/`ash`) that uses bash syntax — `$RANDOM` (also inside
  `$(( ))`), `[[ ]]`, `function name`, `source`, arrays `name=(…)`, `${var,,}`/`${var^^}`, `<<<`,
  `{1..9}`, `&>` — outside quotes and comments: `…: the script uses bash syntax ($RANDOM), but runs
  with /bin/sh, which is not bash on many systems (dash on Debian, Ubuntu, Raspberry Pi OS): add
  "shell": "bash"` (QA: a `$((RANDOM % 3))` button failed 8 of 8 under dash, silently). They never
  block the save.
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
  affect the current run — except its time limit: a changed `timeoutMs` applies to the run going on,
  counted from its start (raised mid-show from 2:30 to 4:00, a 3-minute video plays to the end;
  lowered below what it has run, it stops at once as a time-out). The host log says so: `show/video
  #1: time limit 2.5 min → 4 min while it runs (3.7 min left)`.

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
    alone clears it (see State store). `@state:<pad>/<button> text` does the same for **another**
    button, any pad (an "All off" clearing the "ON 80%" on each light's own buttons:
    examples/scripts/light.sh), `@state:<pad>/<button>` alone clears it; no space around the `:`
    or `/`, ids as in the config (naming the run's own button = plain `@state`). A key that names
    no button in the config is ignored (logged, at most once per 10 s, with a count). Same
    sanitizing, cap, persistence and `latched` broadcast as `@state`; at most 256 buttons per
    update (one per 50 ms).
  - Without `@result`, result text = last non-empty, non-`@` stdout line; on failure with no
    stdout, last non-empty stderr line; spawn error → the error message. Truncate to 200 chars.
  - Result, status and latched text are sanitized: ANSI CSI/OSC/DCS sequences, C0/C1 control
    characters and bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069) are removed, tabs become
    spaces. Cut between graphemes, with an ellipsis. So are `RunRecord.error` and every host log
    line (what they quote from labels, paths, scripts' `#!` lines, a broken file's parse error),
    which keep only their own line breaks.
  - A last line without a newline counts, even while a background process holds the pipe open.
  - Output is read in turns with everything else: a flood (`yes`) can't stall timers or other presses.
  - When the main process has exited and its pipes had 250 ms to drain, the host closes its ends
    and stops reading: a background process still writing there gets EPIPE/SIGPIPE (`(yes &); echo
    x` would otherwise keep the host at 100% CPU forever). Background children of a finished run are
    otherwise left alone, not killed (a button may start a daemon on purpose: redirect its output).
- Timeout (`timeoutMs`) → kill → failure reason `timeout`, `RunRecord.error` `timed out after
  <the limit in force>`. A run's limit can be re-armed while it runs (`RunHandle.retime`, see
  Config store). Spawn failure → `spawn`, with text like
  `command not found: X`, `permission denied (chmod +x?): P`, `is a directory: P`,
  `not executable as a program (missing #! line?): P`, `interpreter not found (check the #! line): P`.
  Every client sees that text, so it names files by their base name (`command not found:
  light.sh`); the admin run log's `error` has the full path.
- Run log (`RunRecord`, admin): `command` (what ran: the argv shell-quoted, `/bin/sh -c '…'` for a
  shell action), `cwd` (resolved), `error` (the spawn failure in full, or how the host stopped it).
- Durations and throttles use a monotonic clock; only `startedAt`/`endedAt` are wall-clock (epoch ms).
- Keep only tails in memory: 16 KB per stream per run; last 20 runs per button. A button removed
  (or renamed) by a config change takes its runs with it, except a run the change killed: its
  record stays until the next config change. Over all buttons, at most 32 MB of output: past
  that, the oldest runs that hold output are dropped first. The finished runs survive a restart
  (see Run state file: the run log).

### State store

Holds `RunState` per button, runs `transition()` from `machine.ts`, performs the effects (start →
runner, kill → runner, scheduleReset → timer that feeds back `reset`, scheduleRequeue → timer that
feeds back `requeue`), broadcasts every change. READY's `last` (how the previous run ended) comes
from the machine; it is restored from the state file at startup.

A press is answered, checked in this order, with:

- `unknown-button`: no such button.
- `expired`: it carries `at`, and by the host's clock it is older than the button's
  `maxLatenessMs` (default `PRESS_MAX_AGE_MS`, 3 s; 200 ms–10 s: a cue that must not fire late can
  say 500 ms, a garage door on a slow link 8 s) when the host gets to it. Nothing runs; logged (at
  most once per 10 s, with a count). A press made in a dead zone that TCP delivers 14–45 s later
  lands here, and so does one that waited while the host itself was frozen (SIGSTOP, a stalled
  event loop): the age is taken when the host handles it. An `at` in the future (clock skew) counts
  as now; no `at` (curl) is accepted.
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
count. Action `none` spawns nothing: it never counts toward the 32 and is never refused by that
limit. A `none` button with `stops` (or a `group`) that has something to stop (a RUNNING button it
names, or of its group, that isn't being cancelled yet, or a queued re-run) is exempt from the rate
limits too, and takes no token: an emergency "All off" gets through even right after its device
(or everyone) used up the bursts. With nothing to stop it is an ordinary press, so a flood of it is
still limited. Behind a reverse proxy every client has the proxy's address, and shares these limits
(and the 16-connection cap, and the pairing attempts' per-address limit).

Queue: when a run with a queued re-run ends, its result is broadcast (with `queued: true`) and shown
for `REQUEUE_GAP_MS` (800 ms) before the re-run starts, so a failure is seen rather than hidden
behind the next run. The re-run waits longer while an earlier run's processes are dying or 32 runs
are going.

`stops` and `none`: a press that will start a run (a queued re-run too) first cancels every RUNNING
button its patterns name (`pad/button`, `pad/*`, `*`; never itself), whatever their own
`whileRunning`, and drops their queued re-runs (also one waiting out its result, and one behind a
run whose process already exited: too late to cancel, it ends as what it was, but without the
re-run). Those runs end FAILURE `cancelled` with the text `Stopped by <label>` (sanitized; the id
when nothing is left of it). Action `none` runs nothing: success at once, text `Stopped N` when it
stopped N > 0 buttons (each running one it names, also one an earlier stop is already taking down,
and each whose queued re-run it dropped; not a run that already exited, its output draining),
`Nothing was running` when its `stops`/group found nothing to stop, `Done` for one with neither.

`group` (exclusive buttons): a press that will start a run first stops the RUNNING buttons of the
same group, on any pad, never itself — exactly as if `stops` named them (same kill reason, same
text, their queued re-runs dropped), together with what its own `stops` name. A group member pressed
while it runs follows its own `whileRunning`. Two fade cues in group `wash`: starting one ends the
other, whichever was running.

Kill reasons, distinct in RunRecord.error and the host log (`■ pad/button #7 1.2s <reason>`):
`cancelled from a device` (the log adds the connection's address), `stopped by <label>`,
`stopped: button removed by a config change`, `stopped: host shutdown` (reason `interrupted`),
`timed out after <time>` (reason `timeout`, logged `✗`).

`@state` (latched device state): per button, kept across runs (failed ones too) and restarts; sent
in `hello.latched` and as `latched` broadcasts; `@state` alone clears it; removing the button
drops it. Any run may set any button's (`@state:<pad>/<button>`, see Runner), and that button's
own runs replace it as usual: the last word wins. A run cut off by a crash (shown INTERRUPTED by
the next host, see Run state file) may have changed the device after its last word: its button's
latched state gets a `? ` prefix (`? BGM ●`, at most 42 characters) until the next `@state` of that
button replaces it (only its own button: which others it would have set is not known). A run a
graceful shutdown stopped ended under the host's eyes, as a cancel does: its state stands.

### Run state file

`buttpad.state.json` next to the config (mode 0600) holds what must survive a restart or a crash:
per button the last run id, last result and latched state; the runs in flight `{key, runId, pid,
pgid, startedAt, fingerprint, command, cwd}`. Written with the config store's safe atomic write,
throttled: routine changes at most every 250 ms (≤ 4/s), a run's start or end within 50 ms; and at
shutdown and in the process `exit` handler. A save that fails is logged once (and when it works
again); the host keeps going.

At startup, once the port is bound (a second host that can't bind never touches the first one's
runs):

- Run ids continue where they left off (each button's `lastRunId`, and past runs that were in
  flight), from this file only: the run log's ids are display data (a crafted `runId` there of
  2^53 − 1 froze them: + 1 changed nothing). A run id above 2^40 (millennia of presses) is
  malformed and dropped like any other bad value, in either file: a clamp would bring it back down
  after every restart, and the ids after it would repeat.
- Each run that was in flight: if its process is still alive and its start-time fingerprint matches
  (Linux: `/proc/PID/stat` starttime plus the boot id; elsewhere `ps -o lstart=`) — the PID may
  have been reused — the host SIGTERMs its process group and SIGKILLs it after 2 s; presses of that
  button are `ignored` until it is gone. Anything else (another process now has the PID, no
  fingerprint) is left alone. Either way the button shows FAILURE `interrupted`
  ("Interrupted: host restarted") for its resultHoldMs, then READY with that as `last`; the run log
  gets a record of it. On Windows there is no fingerprint: nothing is killed.
- Only a **private** state file is trusted to name processes: owned by the host's user, mode 0600
  or stricter (`mode & 0o077` = 0, checked on the file as opened), in a folder that isn't group- or
  world-writable. A fingerprint is no secret (anyone can read `/proc`), so whoever could write any
  other file could aim that kill at any process group of the host's user. From a file that isn't
  private, the runs in flight are reported as above but left alone ("pid N left alone: the state
  file is not private"; once listening, a log line says why) and lose their fingerprints, so they
  stay inert even once saved again. The rest (run ids, results, latched states: checked, sanitized
  display data) is used as usual; the next save writes the file 0600. Keys that aren't
  `pad/button` ids are dropped.
- A graceful shutdown keeps the runs it stopped in the file (`stopped: "shutdown"`): the next host
  reports them the same way.
- A missing, unreadable (a FIFO or device is never opened for reading) or unknown-version file:
  start fresh, with a log line once listening; the next save replaces
  it. A file whose writer is still running (its pid and fingerprint alive): this host neither saves
  nor touches that host's runs, and says so.
- Not covered: a crash during a killed run's 2 s grace period (its main process had already exited)
  leaves SIGTERM-ignoring grandchildren behind; background processes of a finished run aren't tracked.

The run log (GET /api/runs) is kept in `buttpad.runs.json` next to it (`<name>.runs.json` next to
a state file of another name): the last 20 finished runs per button, each output tail cut to its
last 2 KB (marked with a leading `…`), `command`/`cwd` to 4 KB; at most 2 MB in all — past that, the
oldest runs over all buttons are left out of the file. Saved at most once a second (a run ending, a
config change dropping a button's runs), at shutdown and in the process `exit` handler; written 0600
by the same safe write. At startup the runs of the buttons still in the config come back (their ids
don't move the counter: that is the state file's); a run a graceful shutdown stopped is already there with its output (the
next host doesn't add it twice), one cut off by a crash is added as interrupted. Same trust posture
as the state file — it is display data: read without blocking (a FIFO is refused), at most 4 MB,
every record checked (its key, ids, times, reason) and capped, errors sanitized, malformed ones
dropped; one someone else could have written is shown and written back 0600 at once (nothing in it
is ever run or signalled). A missing file is the usual first start (nothing said); an unusable one
is logged once and the log starts empty.

## Client

### Connection & pairing

- Token from `location.hash` `#token=…`, the hash stripped at once with `history.replaceState`.
  With no token stored it is simply kept (`localStorage`, `buttpad.token`). One that would
  **replace a working pairing** is tried on the host first (`GET /api/state` with it; "Checking the
  pairing link…"): taken if the host takes it; rejected (a typo'd link, another host's) → this
  device stays paired as before and says so ("That link's token was rejected — still paired as
  before"); no answer either way (a flaky link) → taken, with the old token kept aside
  (`buttpad.token.fallback`) until the host says hello to the new one: if it turns the new one down,
  the old one is tried and, if the host still takes it, used again (same note). A token pasted on
  the pairing or rejected screen is checked the same way; a rejected one is refused in place.
  Storage blocked (private mode, site data blocked): tokens are kept in memory for the tab, and the
  pad says pairing won't be remembered.
- No token → pairing screen. First and big: **Pair with a code** — the way in from any address,
  including a page served through a reverse proxy, tunnel or preview pane (nothing in the client
  assumes the host's LAN address: every request goes to `location.origin`, `wss:` under https).
  Then the QR / pairing link / paste field. A pairing code typed into that field (digits, spaces,
  dashes, dots: "123 456", the one box on the screen) is no link or token: 6 digits open the code
  entry with it, tried at once; other digits say "That looks like a pairing code, but a code has 6
  digits." The code entry (also `…/#pair`, or `#pair=123456`, which is tried at once; and "Unlock
  editing…" in a press-only device's menu, whose note explains the admin link and the codes): one
  big field (number pad, `autocomplete=one-time-code`), labelled "Pairing code · 6 digits".
  **Exactly 6 digits, never more**: spaces, dashes and dots are ignored, the digits shown as
  "123 456" whatever was typed (a backspace right after the space takes the digit before it); an
  edit that would make a 7th digit — typed at the end or into the middle, or a longer paste — is
  refused whole, the field as it was (never cut down to a wrong code), with an inline "A code has 6
  digits." Pair stays disabled until all 6 are there (Enter before that says "A code has 6 digits
  (4 so far).") (QA: after an error a tap put the caret mid-code, and a new code typed there showed
  as "640 1696" of "640169616"; Pair took it and a try was burned). `POST /api/pair {code}` →
  `{token, role}`, the token then used as above. A code that fails is **selected** (as soon as the
  field, read-only while the host answers, can take focus again), and the next edit starts a new
  code wherever the caret is — a tap on the field moves it into the old digits (iOS), and the
  field selects it all again once the tap is done: what is typed or pasted replaces the code, a
  delete clears it. 401 → "That code didn't work: mistyped, used already, or expired"; 429 → "Too
  many tries", a countdown from `Retry-After`, Pair disabled meanwhile; 403 → the address advice
  below. An admin's menu has **Pair another device…**: `POST /api/pair-code`, the code shown big
  ("123 456") with the time it runs out (whole seconds left, host clock via the offset: a fresh
  10-minute code says 10:00 or 9:59, never 10:01) and the `…/#pair` address to type it at.
- **The host turns this address away** (a 403 `OriginRefusal` from `POST /api/pair`,
  `POST /api/ws-ticket` or `POST /api/ws-check`: the page comes through a reverse proxy, tunnel or
  preview pane the host wasn't told about), said the same on the code entry, the connecting screen
  and the pad's banner: this page's address, and the option to restart ButtPad with,
  `--allow-origin <origin>` — the `allowOrigin` the host's answer names, else `location.origin` —
  in a box of its own. The address never breaks inside: each origin (and the option) is an
  unbreakable unit that moves to the next line whole (QA: "https://mason-" / "preview.test:44617",
  split at the hyphen, ran off a 390 px screen with the env-variable example). **Copy for the
  operator** puts exactly `--allow-origin <origin>` on the clipboard (Clipboard API on a secure
  page; on plain HTTP a selected text area and `execCommand('copy')`; where neither works the
  option is selected for copying by hand, and the button says so), "Copied ✓" for 2.5 s. On the
  code entry it adds **"Restarting ButtPad prints a NEW pairing code — ask for it."** (the old one
  is gone with the restart); a paired device instead says it stays paired and connects once the
  host lets it.
- **The token never goes in a URL** (a reverse proxy's or preview pane's log kept the admin token,
  a line a second): every connection attempt opens `/ws?ticket=<ticket>` (`wss:` under https) with
  a one-time ticket of its own, traded for the token by `POST /api/ws-ticket` (Bearer header) →
  `{ticket, expiresInMs}`; a ticket is never reused, whatever became of its attempt. The next
  attempt's ticket is fetched while the socket is up (a **spare**: after the hello, and again when it
  is 10 s from expiring, on the next frame, page visible), so a reconnect opens its socket at once
  on a new connection, as before tickets: a ticket fetched only then can go out on a pooled HTTP
  connection that died with the socket (a NAT forgetting it while the phone slept) and hang. With
  no spare (a stretch hidden, a second attempt in a row) the request gets the quick probe's wait
  (1.5 s on a fast link), doubled after each one in a row that didn't answer in time; given up
  on, its connection closes and the next attempt gets another. Its 401 → token rejected (stop, as
  below); 403 → the address advice above (and keep trying); no answer, or anything else → a failed
  attempt like a socket that failed. HTTP carries the token only in `Authorization` headers; the
  `#token=` of a pairing link is a fragment, which never leaves the browser.
- WS with auto-reconnect (backoff 0, 250 ms → 5 s). The backoff starts over only after a
  connection held 10 s: a host or proxy that drops every socket right after `hello` is not
  hammered. A socket waits 5 s for its `hello` (from when it is made; a ticket request has its own
  wait, above), then 10, 20… (≤ 60 s) after each one that timed out: a big config over a slow link gets
  through. Reconnect gets a fresh `hello`; state is authoritative from the host, so a reload or
  flaky Wi-Fi never loses track of a running action. Offline, a touch on a button tries to connect
  at once (not at the next retry, seconds away), giving up on a ticket request or socket that has
  been opening for 1.5 s.
- Liveness: a link can die without a TCP close, and the host sends no heartbeats, so the client
  asks. A socket quiet for 5 s (page visible) gets `{"t":"ping"}`; the host answers a type it
  doesn't know with `error`, and any frame counts as the answer. Nothing back in 3 s (1.5 s when
  in doubt: back from the background, a window `online`/`offline` event, a press with no ack for
  0.6 s) → the socket is dropped on the spot (handlers detached, its unacked presses failed,
  OFFLINE) and a new one opened; nobody waits for the browser's close handshake (up to a minute on
  a dead link). Every socket keeps its own pending presses and timers: a stale socket's late
  events can't touch the current one.
- Those waits follow the link (flaky Wi-Fi made 0.3–0.5 s false NO RESPONSE / OFFLINE flashes):
  round trips are measured (pings answered, presses acked; the last 20, none that spans a stretch
  in the background), and with ≥ 3 of them, their 90th percentile p sets: the ack wait 4p within
  2–6 s, the probe 4p within 3–8 s, the doubtful probe 3p within 1.5–5 s, "no ack yet" 2p within
  0.6–3 s. Until there are 3, p is the last ticket request's round trip as the network stack timed
  it (Resource Timing, `responseStart − requestStart`: no connecting, unaffected by the page
  stalling; none where the browser has no such entry), before the first one the page's own
  request's (navigation timing: it came over the same link). QA, a link 2 s each way: a fresh socket's
  first press got the fast-link 0.6 + 1.5 s for a frame and the link was dropped, press after press,
  so no round trip was ever measured. Slower to say NO RESPONSE on a slow link, never faster than
  before, never past 6 s; and never a success that didn't happen (only the host's answer or state
  shows one).
- **Syncing**: back from a stretch in the background (hidden ≥ 5 s), a frozen tab resuming
  (Page Lifecycle `resume`, a back/forward-cache restore), or a page that didn't run for a while
  (a 1 s heartbeat that comes ≥ 8 s late: a 4 s stall isn't that): what the screen shows may be
  minutes old, and a socket that stayed up first delivers the frames it queued meanwhile (runs that
  started and ended long ago: they flashed RUNNING "10:15" and ✓ OTHER DEVICE for ~350 ms). Until
  the host's current word is in — a fresh hello, or the answer to a ping sent on waking, which the
  host gives after everything it sent before — every button is SYNCING (dimmed, still, "SYNCING…"),
  the bar says SYNCING, presses wait (a WAIT · SYNCING badge, nothing sent), and what the backlog
  replays is settled without a buzz and isn't marked as another device's live run. A render that
  comes before the backend has noticed (a running clock's tick first thing after a freeze) asks it
  (`isStale()`) and shows SYNCING too.
- Startup: alongside the first socket, `GET /api/state` (and `/api/config` when no layout is
  cached): a rejected token shows at once, and a socket that hangs doesn't show a running action
  as READY. While offline the last-known states stay on screen (see OFFLINE). Browsers hide why an
  upgrade was refused, so a socket that never got its hello is followed by `POST /api/ws-check`
  (Bearer header, nothing in the URL; a POST because a same-origin GET carries no Origin), which
  answers what an upgrade from this page would get now: 503 → "Host is full (too many devices
  connected)" instead of "Can't reach the host"; 403 → the host turns this address away (the advice
  above, with the `allowOrigin` its body names); 401 → token rejected; 204 = there's room.
- Clocks: everything the client times itself (elapsed counters, confirm windows, countdowns,
  cooldowns) runs on `wall()` (`src/web/lib/clock.ts`): epoch ms that follow `performance.now()`, so
  setting the device's clock moves no counter; after a stretch in the background it catches up with
  `Date.now()` (a sleeping device may pause `performance.now()`). The host-clock offset is learned
  from every `hello.serverNow` (and `/api/state`'s), corrected by the one-way delay the socket's
  opening measured. The host stamps serverNow when it takes the socket, so the offset is taken as
  of the socket's opening (its upgrade answer), not as of the hello's arrival: a big config over a
  slow link takes seconds more to arrive. The opening took the upgrade's round trip, plus one for
  connecting unless that was free (a proxy or tunnel on the device's side): the one-way delay is a
  quarter to a half of it. A quarter (≤ 1 s), unless the ticket request timed the round trip on
  its own (Resource Timing, above): half of that, within those bounds (≤ 4 s). QA: through a proxy
  2 s each way the quarter came out at 1 s, and every press looked a second older to the host.
- A press goes out at once or not at all, never queued for later, and carries `at` (when it was
  made, host clock: the gesture's own time — a tap's release, a hold reaching `holdMs`, a keydown —
  so a press a stalled page sends late is still dropped as too old) and, after the confirm step,
  `confirm: true`. NOT SENT if it never left the device, NO RESPONSE if it was sent and no ack came
  within the ack wait (2 s; longer on a slow link, above; the face says how long it waited, or that
  the link dropped); a late `expired` answer (the host dropped it: it sat in a dead link longer
  than the button's `maxLatenessMs`, 3 s by default) turns NO RESPONSE into NOT SENT "too late —
  not sent", and it never runs. That answer goes to the socket it came on, though, which may be
  dead: so once reconnected (a fresh hello), `maxLatenessMs` past the press's `at` (the longer of
  the button's value when it went out and now; and 1 s more for the offset's error), with no run of
  it on the host, NO RESPONSE turns into DIDN'T RUN (it never will: the host drops a press that
  old). If the host's state shows the press did run (`runId` past the one seen at press time, or a
  late `started` ack), the button shows that (RUNNING, SUCCESS, FAILURE, or, when it already
  finished, its outcome from READY's `last`: "IT RAN" only if the host no longer knows), not NO
  RESPONSE; a run that started more than `maxLatenessMs` after the press was made isn't it (the host
  would have dropped the press), unless it is the queued re-run behind the run a queue press was
  made on. A press answered `expired` sooner after it was made than it could have been held up (1 s,
  or a third of `maxLatenessMs` if that is less) means the offset is wrong (the host's clock was
  set), so the socket is renewed for a fresh hello. A config without `maxLatenessMs` (an older host,
  a cached layout) counts as 3 s.
- Whose run is it: only a run an ack's `runId` says this device started (or queued) is "ours"
  (v1 hosts without `runId`: the next run). A queued re-run stops being ours once it is dropped:
  the run it waits for ends, or is being cancelled, without it (All off, a cancel, a host
  restart). Its outcome gets the success/failure buzz; a failure stays on screen (see Button
  states). A run seen starting with no ack of ours behind it is another device's: a small OTHER
  DEVICE mark, no buzz. A press that loses a race to another device's press (ack `ignored` while
  their run starts) says ALREADY RUNNING. Run ids that go backwards (a host started without its
  state file, the demo's Reset) start this memory over: the old runs are gone, their ids name new
  ones.
- A config change that drops (or renames) a button takes that button's state with it: the host
  sends no last word about a key that's gone, so nothing shows it RUNNING forever (nor offers to
  "stop" it on the next save).
- 401 → "token rejected" screen with re-pair options (paste, a pairing code, try the token again).
  "Pair again" in the menu takes a second tap, and isn't there under `?lock` (nor are "Unlock
  editing…" and "Pair another device…").
- **Backend interface**: the UI talks to an abstract backend with two implementations:
  `ws` (the host) and `demo` (in-browser: runs `machine.ts` locally with simulated actions, config
  in localStorage, the host's rules: acks with `runId`, `expired`/`needs-confirm`, already-queued
  `ignored`, the 800 ms requeue gap, `stops` and exclusive `group`s (any pad), `none` saying
  "Stopped N" (running ones and dropped re-runs) / "Nothing was running" / "Done", `@state` and
  `@state:<pad>/<button>` (another button's chip; one naming no button is ignored), per-button
  `maxLatenessMs`, the
  per-connection rate limit of bursts of 10 then 5/s; its controls simulate an outage, a lost ack, a
  press held up on the way, a host restart). `?demo` selects demo. Demo exists so the UI can be tried on a phone with no host,
  and so the UI can be built/tested independently.

### Run mode (the default, locked-down)

- Full viewport (`100dvh`, safe-area insets), no scroll, no zoom, no text selection, no
  long-press callout/context menu, no pull-to-refresh (`touch-action: none`,
  `overscroll-behavior: none`, `-webkit-touch-callout: none`, `user-select: none`).
- CSS grid `cols`×`rows`; buttons placed by `x,y,w,h`. Small gap; each button's hit area takes
  the half of the gap next to it (no dead touches). Labels sized with container query units so
  they're as large as the button allows (the measuring is capped: a label thousands of characters
  long can't stall the page). Label ink black or white, whichever has the higher WCAG contrast
  (white on orange is 2.9:1, black 7.2:1). A color that doesn't paint an opaque button on its own
  (`transparent`, `currentColor`, `var(…)`, half-transparent, invalid), or a system color
  (`Canvas`, `ButtonFace`…: it follows the color scheme, so its ink can't be chosen), is painted as
  the default.
- Thin top bar: pad tabs (hidden when only 1 pad or `?lock`), connection indicator (LIVE dot;
  OFFLINE / CONNECTING / HOST FULL in words; DEMO in the demo, never a green dot), menu
  (fullscreen, keep-awake status, device settings, edit mode if admin; pairing entries). SYNCING
  (hollow dot) while catching up after a stretch away. Tabs scroll sideways when
  they don't fit, the active one kept in view (also when a wider badge comes up); a tab shows a dot
  when something on its pad is running (white ring) or failed (red). Tabs and the menu button take
  a deliberate touch: ≥ 80 ms down without sliding (a 60 ms glove brush does nothing; mouse clicks
  and the keyboard as usual), and act on the tap's own click, so that click can't land on what
  opened. Keep-awake off (or not holding the screen) shows SCREEN MAY SLEEP in the bar.
- Which pad: `?pad=` names one by id or name, any case; `?lock` without `?pad` is the first pad
  (not the one this device remembers); otherwise the last pad picked here. A pad that isn't there
  — asked for by the link, or deleted while on screen (renamed: followed by id, or by name if only
  its id changed) — gets a "Pad “X” no longer exists" screen (with the pads to pick from, unless
  locked), never another pad's buttons. A locked screen in that state ignores keys too. Leaving the
  editor lands on the pad the editor had open when it closed (a `?pad=` link's page too: QA, the
  owner built "Stage", saved, closed the editor and was back on "Test"). A pad saved just then may
  reach the page a moment after the save's answer (with the socket's `config`): the page waits up
  to 10 s for it, on the pad that was on screen meanwhile, unless another pad is picked; one never
  saved (a draft thrown away) leaves the pad that was on screen before.
- Banners (unsaved edits kept on the device, storage blocked, host full, address refused, config
  errors, pairing notes) take their own room below the pad, which shrinks for them: never over a
  button (on a 360×640 phone one covered the bottom row). Toasts (a key pressed a button on another
  pad) are brief and overlay, and take no touches.
- `?lock` (kiosk, handlebar mount): no tabs, no edit entry, no "Pair again"; keys press only the
  locked pad's buttons; the menu opens only on a ~1 s press of its button (a ring fills
  meanwhile), never from the keyboard.
- Device settings (menu, per device): sounds, haptics, keep awake, **rough mode** for gloves
  and vibrating mounts: one button at a time per pad (a second contact on another button while one
  is down is ignored, though it still counts toward a palm), finger taps need 80 ms of contact, a
  cooldown of at least 800 ms, 1.5× `driftPx`; and **show mode** for a dark house (below).

### Button states (the important part)

Rule: every state differs in **color + motion + shape**, so it reads at a glance in sun glare,
peripheral vision, or with color blindness. Big and bold beats subtle.

| State | Where | Look |
|---|---|---|
| READY | host | solid button color, huge label, still; a corner mark says how the last run ended (`last`: "✓ 12 s ago", "✗ 3 m ago", ■ stopped, ! interrupted), with its result text when that is short (≤ 40 characters) and fits whole beside the latched chip ("✓ printing 37% · 3 s ago"; measured, never cut: where it doesn't fit, only "3 s ago") |
| ARMING | client | bright fill rising bottom→top over `holdMs`; label stays; at 100%: pop |
| CONFIRM | client | (confirm buttons) after the first fire: flashing amber border + "HOLD / TAP / DOUBLE-TAP / PRESS AGAIN TO CONFIRM" (said the way the first press was made: PRESS for a key), times out after `confirmWindowMs`. A press begun inside the window confirms, even if it completes after it |
| SENDING | client | from fire until the host acks (normally ms); no ack within the ack wait (2 s; up to 6 s on a slow link) → NO RESPONSE. Pressing again meanwhile → BUSY (nothing is dropped silently) |
| RUNNING | host | diagonal stripes scrolling across the whole button; the label stays the big text (never below ~9% of the button's height), the elapsed clock second (at most 90% of the label's size); `@status` text; `@progress` → a determinate fill, with the stripes still moving, slower, underneath (2% must not look READY); `cancel` buttons show "tap/hold to cancel" once a cancel would count (700 ms after the start); "+1 QUEUED" |
| SUCCESS | host | full-bleed green flood, giant ✓, result text, small elapsed; a thin bar drains over `resultHoldMs`; "NEXT RUN QUEUED" when a queued re-run starts in 800 ms |
| FAILURE | host | full-bleed red with thin dark **cross-hatching** (still; it fades in after the flood), ✗, slow pulse: not "just red" next to a red E-STOP, in grayscale too (RUNNING's stripes are wide and move, INTERRUPTED's are wide hazard bands); the reason is the headline (the result text, ≤ 2 lines, else TIMEOUT / CAN'T START / EXIT 3 / KILLED), the exit code small print. This device's own failure stays until its next run (see Sticky results); NOT SENT and DIDN'T RUN look the same. Under OFFLINE ("LAST RUN: EXIT 3") the hatching stays, faint |
| STOPPED | host | slate, ■, still: cancelled on purpose (a cancel press, another button's `stops`, removed by a config change): no red, no failure buzz |
| UNKNOWN | client | amber, "?", dashed frame: NO RESPONSE (sent, no answer: it may or may not have run); IT RAN (it ran, the outcome is lost) |
| INTERRUPTED | host | amber with dark hazard stripes, lightning glyph, pulse: the host stopped (or crashed) while it ran |
| OFFLINE | client | grey, dashed border, ⚠; the last-known state stays visible underneath (stripes or progress dimmed and still, a tint for a result, "LAST SEEN RUNNING · 12s" frozen at the last word from the host, "LAST RUN: EXIT 3"); presses do nothing except shake, and try to reconnect |
| SYNCING | client | back from a long stretch away (see Connection: Syncing): the button's color dimmed, desaturated, still, its label and "SYNCING…"; no stripes, flood, pulse or clock; presses shake with WAIT · SYNCING. Usually one round trip |

Latched device state (`@state`, e.g. "REC ●", "ON 80%") is a solid chip in the top corner in every
state, offline too. One the host can't vouch for — it starts with `? `: a crash cut off the run that
set it, so the device may be in any state ("? REC ●") — is hollow with a dashed outline instead.
A run another device started gets an OTHER DEVICE mark.

**Show mode** (device setting, a dark house; the stage manager's results flooded the tile ~4×
brighter just as the house went dark): every face is its hue dimmed to the same low lightness
(OKLCH L 0.25, chroma ≤ 0.07: a yellow button no brighter than a navy one; `lib/color.ts`
`showPalette`), a thin edge in the hue, and a light ink with the hue's tint (≥ 7:1 on the face). A
result is a colored edge (4 px or more; dashed for UNKNOWN), the glyph and the text in the result's
color on a near-black face, never a full-tile flood; FAILURE keeps its hatching (in red) and pulses
its edge instead of the brightness. No bright flashes: the fire flash peaks at 14 % ink (65 % white
otherwise), badges and pills are dim (pills outlined), the arming fill is fainter. The `@state`
chip stays a solid chip, but in the face's hue a step lighter (OKLCH L 0.36, `showPalette().chip`)
with the ink on it (≥ 4.5:1), not a chip in the ink (QA: "ON 80%" was the brightest thing on a dark
pad, 0.35 on a 0.025 face; now ~0.11, darker than the label). Measured on a
phone (mean relative luminance of a tile): READY 0.25 / 0.53 (blue / yellow) → 0.06 / 0.07, a
SUCCESS flood 0.44 → 0.07, a FAILURE 0.24 → 0.08: a result about as bright as READY was, where
normal mode's green flood is 1.8× a blue button's READY, and many times a dark one's (BLACKOUT).
The whole states gallery: 0.20 → 0.06 (e2e/run-r4.spec.ts measures it on screen). Motion and shape still tell every state apart (`?gallery&show`).

Sticky results: a FAILURE (and INTERRUPTED, NO RESPONSE, NOT SENT, DIDN'T RUN) of this device's own
press stays on screen until the next run on the button supersedes it, or its ✕ chip (top corner)
clears it without a press. A press on it is an ordinary press, a retry ("TAP / HOLD / 2× TAP TO
RETRY"): the trigger, confirm and cooldown rules as always, a key too (also one for a button on
another pad). It clears the result when it fires; a press that comes to nothing (SLIPPED, a graze)
leaves it, and a CONFIRM step shows over it (it's back if the window runs out). The retry pill (and
NEXT RUN QUEUED) has a row of its own along the bottom edge, taken out of the room the fitted text
is sized for, like the top band's (QA: on 122 px buttons, a 3 × 6 pad on a phone, and in the
gallery, it printed over "EXIT 3"); on short buttons (one row) it goes.

Badges flash over the face (as a small chip over a result, so the result stays readable): BUSY
(pressed while running or sending; briefly and without a buzz within the cooldown), BUSY / TRY
AGAIN (the host refused a start for now), ALREADY RUNNING (someone else's run got there first),
ALREADY QUEUED (also, without sending anything, for a press while a result says NEXT RUN QUEUED:
the host takes none until that re-run starts), SLIPPED / HOLD (TAP) AGAIN (released early or slid
off), NOT ON HOST.

Text is laid out where it was measured: labels break only at spaces and at the phrase boundaries
`Intl.Segmenter` finds in CJK/Thai text (rendered as `<wbr>`, with `word-break: keep-all`, and
`auto-phrase` where the browser has it), so a size computed for two lines is laid out on two.
Short buttons (≤ 84 px) put their items in one row with fixed shares of the width, dropping the
glyph and then the number/headline when the button isn't wide enough. Chips: the trigger
("HOLD 1.5s" for holds of a second or more; "TAP AGAIN" while a double waits for its second tap)
and the key, by name (VOL+, SPACE, ↑, PG↓, ⏯…); on narrow buttons they shrink (the key loses its
keyboard glyph, the trigger its word) rather than spill out. Under 110 px wide (a 4-column pad on a
phone: ~90 px) what matters for safety stays, as glyphs, centered: the trigger (hold / tap / double;
a hold's duration "1.5s") and the confirm lock; the key chip goes.

Forced colors (Windows high contrast): every face gets an edge, its border style differs by state
(dotted running, double success, thick failure, dashed stopped/unknown/offline), the hold fill,
progress and stripes paint in the highlight color, and the state is also written out (RUNNING,
DONE, FAILED…).

Triggers:

- `hold`: fires when held `holdMs`. Released early → back to READY (fill drains fast) with
  SLIPPED — HOLD AGAIN and a soft buzz. Finger moving more than `driftPx` from the start point →
  the same.
- `tap`: fires on pointer up if it didn't drift, was down at most 1.5 s (a resting thumb is not a
  tap) and, for a finger, at least 40 ms (a graze isn't a tap; a mouse or pen click of any length
  is deliberate).
- `double`: two taps within 400 ms.
- Contacts landing on 3+ buttons within 60 ms are a palm or a sleeve: none of them fires (rough
  mode too: the contacts it ignores still count).
- Cooldown (`cooldownMs`, default 400): after a fire, presses of that button from this device are
  ignored for that long (no fire buzz, a brief BUSY): key chatter, a bounce.
- Confirm: the confirming press must begin after the first press fully ended and at least 400 ms
  (or the cooldown) after CONFIRM appeared, by the event's own time: a chattering key or a pothole
  bounce doesn't confirm. The host also refuses a confirm button's press without `confirm: true`
  (`needs-confirm`): the client then asks for the confirm step.
- A press begun while the button looked READY isn't sent if someone else's run started before it
  fired (on a cancel button it would cancel theirs): ALREADY RUNNING.
- A config change that moves, resizes or removes the button under a held finger (or a switch of
  pad) cancels the press.
- Timing goes by the input events' own timestamps, not by when a handler ran: on a stalled main
  thread a finger lifted before `holdMs` doesn't fire, one held past it does (a late hold timer
  first lets queued input land).
- A second contact on a pressed button (rolling thumb, glove) joins the press and carries it on
  when the first lifts. The trigger and timings are taken when a press begins: a config change
  mid-press doesn't change it.
- Keyboard: `key` maps a KeyboardEvent.key to a button (BLE remotes/clickers pair as keyboards,
  and send keydown and keyup together). A mapped key fires on keydown for `hold` and `tap`
  buttons alike (no hold); `double` = two keydowns within 400 ms (and not within 60 ms: a bounce);
  confirm and cooldown still apply; auto-repeat ignored. Enter/Space on a focused control stay
  with that control. Keys are global (not under `?lock`): the pad on screen first, else the one
  button on any other pad with that key fires; a toast says what it did there, "▶ PULL OVER (Ride)"
  only when it fired, else why not (press again to confirm, press again for a double, too soon
  after the last press, still sending, already queued, not connected). A key on several other pads
  does nothing and says so. Keys keep working while the menu is open (the key closes it).
- Every button has one controller for the whole session (`src/web/run/session.ts`), whichever pad
  is on screen: a run's outcome still buzzes after switching pads.
- Multi-touch: each button tracks its own pointers; pressing two buttons at once works (not in
  rough mode).
- Haptics: `navigator.vibrate` where it exists (touch, fire, confirm, success, failure, busy,
  denied, a soft "cancelled" for a press that came to nothing, "unknown" for NO RESPONSE /
  INTERRUPTED), only for this device's own runs. iOS (no vibrate: the system switch's tick): fired
  1 tick, success 2, failure 3; the first tick happens synchronously in the gesture handler.
  Optional sounds (device setting, default off), unlocked on any user-activation event.

### Keep awake

Wake Lock API needs a secure context, which a LAN `http://` page isn't. So: use Wake Lock when
available; otherwise fall back to a muted, inline, looping tiny video (the NoSleep trick). The
menu says it in plain words ("Keeping the screen on (video trick — plain-HTTP pages can't use
Wake Lock)", "Tap anywhere to keep the screen on", "Off: the screen may go dark and lock"); the
bar shows SCREEN MAY SLEEP while it's off or not holding. Re-acquire on `visibilitychange`. Until
the screen is held, every user-activation event (a touch counts on its way up) starts the video
synchronously inside the handler.

### Edit mode (admin only)

- Entered from the menu. Grid lines visible. Tap an empty cell → new button there. Drag a button
  to move, drag its corner handle to resize; snaps to cells; overlap/out-of-bounds is refused
  visibly (red ring, a shake). A duplicate lands with a calm glow instead.
- Closing it (✕, Save and close, Discard changes) reports the pad open in the editor, by its id on
  the host (a pad whose id the draft changed: the host's; after Save and close: the saved one; a
  new pad thrown away: none), and run mode lands on that pad (QA: the owner built "Stage", closed
  the editor, and was back on "Test").
- Selecting a button opens an editor (bottom sheet on phones, side panel on wide screens): label,
  color, trigger, holdMs, driftPx, confirm (+ confirmWindowMs), cooldownMs, maxLatenessMs ("Max
  lateness": a press that reaches the host later than this — dead Wi-Fi, a frozen host — is
  dropped rather than run late), key, whileRunning, timeoutMs, resultHoldMs, id; the action (type
  switch: shell: script + shell + cwd + env; exec: command + args list + cwd + env; **Nothing
  (stop others)**: `none`), its **Group** and **Stops** (any type). Group: an exclusive group's
  name, any pad ("starting one stops the others in its group"), with the groups in use as
  suggestions and one-tap chips; the field names its mates, and the canvas tags every button with
  its group. Stops: chips per pad for `pad/button`, "All of <pad>" for `pad/*`, a switch for `*`
  (everything); a wider pick shows what it covers, and so does the group (its mates show as
  stopped, tagged, and count in the summary); a pattern naming nothing is listed to remove.
  Renaming or deleting a button or pad in the editor carries the patterns along (or drops them),
  in the same undo step. Duplicate, delete.
- Durations are typed in **seconds** and kept in ms: "10" in "Show result for" is 10 s; "2,5" (a
  comma keyboard), "500 ms" and "2 min" work too. Number fields show their range (hold 0.1–5 s,
  confirm window 0.5–60 s, cooldown 0–10 s, max lateness 0.2–10 s, time limit up to 24 h, result
  up to 60 s); arrow keys stay inside it; an out-of-range value is an inline error in words, in
  seconds ("Must be at most 60 s (1 min)"), that blocks saving. A half-typed value is left alone.
  Labels (≤ 200), pad names (1–60, not blank), groups, a program's path, folders and the shell are
  saved trimmed, as the schema keeps them: the draft is tidied right before the PUT, so the host's
  copy is exactly the draft.
- The time limit says it **applies to a run in progress too** (the host re-times a running run:
  the new limit counts from its start). When the draft changes the limit of a running button, a
  notice near Save says so ("once saved, “Video” has a 4 min time limit (it has run 2 min)"); a
  limit shorter than it has run stops it at once: the notice says that, and saving asks first,
  like any save that stops a run.
- Non-blocking warnings: a READY color that reads like SUCCESS green or FAILURE red (by OKLCH hue
  and chroma; the palette's pink/orange/teal are fine); a key also bound on another pad (keys work
  from every pad: the visible pad's button first, else the one unique match, else nothing); a
  Nothing button that stops nothing (group mates count); a time limit under 2 s or a result shown
  under 0.5 s (a slip, likely); an argument or env value with a blank at either end (a phone
  keyboard's space after a word broke a button): the value as the program gets it, in quotes, its
  blanks shown (␣), with a one-tap "Remove it". Key binding takes the next key pressed; a
  modifier pressed on its own (Shift, Control, Alt, Meta, AltGr…) is refused in words ("modifier
  keys can't be bound — press a key like F1, Space, VolumeUp") while listening goes on, and one
  already in the file is pointed out.
- A new button's action is a placeholder that fails visibly when pressed ("No action set — edit
  this button", via stderr and exit 1), never a ✓ for nothing. Switching a placeholder (or
  Nothing) to another type starts that type blank: no sample `sh -c` arguments left behind.
- Pad management: add, rename, delete, reorder, cols/rows (shrinking that would clip buttons is
  refused with an explanation).
- Edits are a local draft until **Save** (PUT with `baseRev`). Unsaved indicator; **Discard**
  (undoable) in plain sight on every layout. Validation errors from the host are shown; long lists
  ("+3 more": a broken file's errors, the problems) open up in full. The host's PUT `warnings`
  (saved, but e.g. a program it can't find, bash syntax under /bin/sh, a modifier key, a group of
  one) are about the whole config, so each save tells what it changed from the rest (diffing the
  saved config against the one the draft was based on, by identity: a renamed button is the same
  button). Warnings about a button it added or changed, a group a button joined or left (the one
  left alone in it), or a `pad/*` pattern whose buttons it removed show after the save as a notice
  ("Saved, but the host warns about this:") — no "Saved" toast over it, nor one left from an
  earlier save. The rest is old news (an example's intentionally broken button on a pad the user
  never touched: QA saw "Test › Missing binary" after every save): one quiet line, "N other
  warnings elsewhere", that opens up to the list; inside that notice, or alone, muted and last of
  the notices, with the "Saved" toast. Every warning also marks the button and field it names (an
  amber badge, a callout in its editor: Command, Shell, Key, Group…) until that part of it
  changes. Dialogs that could destroy work focus their safe way out (Cancel / Keep editing).
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
- Saving asks first when it would stop running actions (a running button deleted, its or its
  pad's id changed, or its time limit cut below how long it has run): "This will stop: “Record”
  (running 2 min)". The canvas marks running buttons; the id fields say what an id change breaks
  (`?pad=` links, `/api/press/…`, run histories).
- New buttons never take an id the host has on that pad (e.g. one deleted in the draft): until the
  save, that id still names the host's button. Duplicates don't copy the key binding.
- Shell ⇄ Program switching keeps the meaning: only a plain word list becomes argv (no quotes, `~`,
  `NAME=value`, globs, `$`, shell syntax or builtins); anything else becomes `sh -c SCRIPT`, which
  switches back unwrapped. argv becomes a properly quoted command line. Empty arguments get a
  warning (allowed); env names are checked as typed.
- Admin extra: per-button run log (from `/api/runs`) to see why something failed: outcome, the
  output tails, what ran (`command`), in which folder (`cwd`), and why it couldn't start or was
  stopped (`error`; a path it couldn't start is shown exactly, in quotes, blanks visible, with what
  it tried to run right under it). A Nothing (`none`) run, which runs no program, reads "Done"
  (not "exit 0") with what the host said it did, from the button's state while it has it ("Stopped
  2", "Nothing was running"), like any result: never as a failure or a "why it stopped". It
  refetches every second while the button runs. **Run now** for a saved,
  unchanged button; otherwise **Save & run** (saves the draft, then runs the saved version). On a
  `confirm` button both ask first (a dialog that focuses Cancel) and the press then carries
  `confirm: true` (the host refuses unconfirmed ones). While the button runs, Run now is never a
  silent cancel: it's **Cancel run** for `whileRunning: cancel`, else a disabled "Running…".
- Phones, down to 360 × 640: the status chip shrinks rather than run under Undo; the pad tabs
  scroll sideways (the edges fade; the selected tab, and the "+" after the last, stay in view).
  Notices sit above the canvas, most urgent first (what answers the last action, then what needs a
  decision, then the state of things); one line per host warning about the save ("+2 more"), the
  others folded into "N other warnings elsewhere", and they scroll
  within what the canvas can spare: under the editor sheet it keeps rows of 44 px. Toasts go under
  the notices, never over one. With the on-screen keyboard up (the visual viewport shrinks ~45%)
  the editor takes the whole screen: the sheet goes full height, the canvas, notices and pad row
  step aside, the heads get compact, and the field being typed in is scrolled into view (where the
  keyboard shrinks only the visual viewport, iOS, the editor follows the part on screen). Canvas
  taps are pointer events: the click a browser makes up after a touch is cancelled, so it can't
  land on what just opened under the finger (the sheet's grab handle, its Delete button).

## Testing

- `bun test` — unit + integration (machine, config, runner, HTTP/WS against a real host on port 0).
- `npx playwright test` (Node) — browser tests in `e2e/`. Chromium only here:
  `e2e/playwright.config.ts` points at `/opt/pw-browsers/chromium` when it exists.
- `bun run typecheck` must stay clean.
