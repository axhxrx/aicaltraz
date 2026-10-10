#!/bin/sh
# Fails ~30% of the time (or $1 percent) with an error on stderr, like a device on bad Wi-Fi.
. "$(dirname "$0")/_lib.sh"

pct=${1:-30}
echo "@status Pinging the fog machine…"
latency 200 1000
if [ "$(rand 100)" -lt "$pct" ]; then
  echo "fog machine: no response after 3 retries (192.0.2.77)" >&2
  exit 1
fi
echo "@result Fog burst OK ($((5 + $(rand 40))) ms)"
