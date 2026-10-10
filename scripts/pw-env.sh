#!/usr/bin/env bash
# Runs a command with Playwright pointed at this machine's browsers.
# In the cloud dev container, browsers are preinstalled at /opt/pw-browsers but at revisions that
# don't match our @playwright/test pin, so alias the expected ffmpeg revision to the system ffmpeg
# (needed for video recording). Elsewhere (your Mac), this is a no-op: use `npx playwright install`.
set -euo pipefail
if [[ -d /opt/pw-browsers ]] && command -v ffmpeg >/dev/null; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
  alias_dir="$root/node_modules/.cache/pw-browsers"
  rev="$(node -e 'const b=require(process.argv[1]).browsers.find(b=>b.name==="ffmpeg");console.log(b.revision)' "$root/node_modules/playwright-core/browsers.json")"
  mkdir -p "$alias_dir/ffmpeg-$rev"
  for d in /opt/pw-browsers/*; do ln -sfn "$d" "$alias_dir/$(basename "$d")"; done
  ln -sf "$(command -v ffmpeg)" "$alias_dir/ffmpeg-$rev/ffmpeg-linux"
  export PLAYWRIGHT_BROWSERS_PATH="$alias_dir"
  export BUTTPAD_CHROMIUM=/opt/pw-browsers/chromium
fi
exec "$@"
