# ButtPad

A pad of a few huge buttons for moments when you can't fiddle with a screen: on a ladder setting
lights, mid-shoot, on a handlebar mount. Each button runs a preconfigured program or shell command
on a **host** (any Linux/macOS/Windows box with Bun); any phone, tablet or laptop on the LAN is a
remote via its browser. Buttons are little state machines — READY → (hold) → RUNNING → SUCCESS /
FAILURE → READY — shown with color + motion + shape so you can read them at a glance.

![states](docs/screenshots/states-gallery-phone.png)

Status: working prototype. Spec: [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

```sh
bun install
bun run example        # host with the example config: fake lights/camera scripts, 3 pads
```

It prints a **press URL** (and a QR code) and an **admin URL**. Open one on your phone (same
network). The token in the URL pairs the device and is then stripped from the address bar.

- `bun start` uses `./buttpad.config.json`, writing a harmless starter config if it's missing.
- No host handy? Open any host's page with `?demo` — an in-browser simulation of the whole thing.
- `?pad=lights` opens a pad; `?lock` hides navigation (kiosk); `?gallery` shows every button state.

Saving from the editor rewrites the config file, so `bun run example` edits
`examples/buttpad.example.json` in place — copy `examples/` somewhere if you care.

## Config

One JSON file (schema: `schema/buttpad.config.schema.json`, generated from
`src/core/config.ts`). Hand edits are picked up live; invalid edits are reported to admins and the
previous config keeps running. The admin UI's edit mode writes the same file.

```json
{
  "version": 1,
  "pads": [
    {
      "id": "lights", "name": "Lights", "cols": 2, "rows": 3,
      "buttons": [
        { "id": "key", "label": "Key light", "x": 0, "y": 0, "w": 2,
          "action": { "type": "exec", "command": "./scripts/light.sh", "args": ["key", "on"] } },
        { "id": "off", "label": "All off", "x": 0, "y": 1, "confirm": true, "key": "0",
          "action": { "type": "shell", "script": "curl -fsS http://hue.local/off && echo '@result Lights off'" } }
      ]
    }
  ]
}
```

- `exec` runs argv directly (no shell); `shell` runs a command string via `$SHELL -c` (or `cmd /c`).
  `cwd` defaults to the config file's directory; env gets `BUTTPAD_PAD`, `BUTTPAD_BUTTON`,
  `BUTTPAD_RUN_ID`, `BUTTPAD_LABEL`.
- Exit code 0 = SUCCESS. Script output protocol (stdout lines):
  `@progress 40` (determinate fill), `@status warming up`, `@result Key light ON 80%`.
  Without `@result`, the last stdout line is the result text (stderr's on failure).
- Per button: `trigger` hold|tap|double, `holdMs`, `driftPx`, `whileRunning` ignore|cancel|queue,
  `confirm`, `timeoutMs`, `resultHoldMs`, `key` (keyboard / BLE remote key), `color`, `x y w h`.

Other integrations: `curl -X POST -H "Authorization: Bearer $TOKEN" http://host:8787/api/press/lights/key`.

## Security model (read this)

- Two tokens in `buttpad.secrets.json` (0600): **press** (push buttons) and **admin** (edit the
  config — i.e. run any command on the host; treat it like an SSH key). `--rotate-tokens` revokes all.
- Browsers only ever name a pad + button; commands live in the host's config and are never sent to
  press-role devices. Press devices do see each run's one-line result text, so don't print secrets.
- Plain HTTP by default — use it on a network you trust, or `--tls-cert/--tls-key` (e.g. mkcert).
- Limits: 64 sockets (8 reserved for admin), press rate limit, 32 concurrent runs, same-origin
  WebSockets only.

## Keep-awake

The Wake Lock API needs HTTPS; on a plain-HTTP LAN page ButtPad falls back to a muted looping video
(the NoSleep trick). The menu shows which one is active. Belt and braces: set the device's
auto-lock to "never" while you work, and on iOS consider Guided Access.

## Development

```sh
bun run dev         # host with --dev (HMR, source maps) — never on an untrusted network
bun test            # host + core: unit and integration tests (real processes, real sockets)
bun run e2e         # Playwright, phone + desktop projects, demo backend and real host
bun run typecheck
bun run compile     # single-file executable in dist/buttpad (web app embedded)
```

Layout: `src/core` (the contract: config schema, protocol, state machine — what a future native
app would share), `src/server` (host), `src/web` (Preact client), `examples/` (fake device scripts
for dogfooding), `test/`, `e2e/`, `docs/` (spec, QA log, screenshots).

## Ideas not built yet

- Native iOS app (App Intents, Lock Screen / Action button) using the same config + protocol.
- A Mac menu-bar host; Shortcuts / AppleScript action types.
- Per-orientation layouts; progress from long-running background jobs; MQTT/HTTP action types.
