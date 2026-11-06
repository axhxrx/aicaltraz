#!/bin/sh
# Fake lighting scene: sets several lights one after another, with progress.
# Usage: scene.sh <interview|night|off>
. "$(dirname "$0")/_lib.sh"

scene=${1:-}
case $scene in
  interview) plan="key 80 fill 40 back 25" ;;
  night) plan="key 15 fill off back 10" ;;
  off) plan="key off fill off back off" ;;
  *) echo "usage: scene.sh <interview|night|off>" >&2; exit 2 ;;
esac
# shellcheck disable=SC2086
set -- $plan
total=$(($# / 2))
i=0
while [ $# -ge 2 ]; do
  i=$((i + 1))
  echo "@status $(cap "$1") light → $2 ($i/$total)"
  out=$("$(dirname "$0")/light.sh" "$1" "$2") || exit 1
  # The light's own buttons show its new state (light.sh's "@state:" lines); the scene keeps no chip.
  printf '%s\n' "$out" | grep '^@state:' || true
  echo "@progress $((i * 100 / total))"
  shift 2
done
echo "@result Scene “$(cap "$scene")” set ($total lights)"
