#!/bin/sh
# Fake haze machine: heats up, then hazes for 45 s (or $1 seconds) with progress. Longer than the
# old 30 s default timeout; the 120 s default covers it. Press again to cancel (whileRunning: cancel).
. "$(dirname "$0")/_lib.sh"

secs=${1:-45}
case $secs in '' | *[!0-9]*) echo "usage: haze.sh [seconds]" >&2; exit 2 ;; esac
i=0
trap 'echo "haze.sh: stopped after ${i}s" >&2; exit 143' TERM INT
echo "@status Heating up…"
sleep 2 &
wait $!
while [ "$i" -lt "$secs" ]; do
  echo "@status Hazing: $((secs - i)) s left"
  echo "@progress $((i * 100 / secs))"
  sleep 1 &
  wait $!
  i=$((i + 1))
done
echo "@progress 100"
echo "@result Hazed for ${secs} s"
