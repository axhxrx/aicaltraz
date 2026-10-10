#!/bin/sh
# Emits @status/@progress for ~5 s.  Usage: progress.sh [steps=10] [ms_per_step=500]
. "$(dirname "$0")/_lib.sh"

steps=${1:-10}
ms=${2:-500}
i=0
echo "@status Warming up"
while [ "$i" -lt "$steps" ]; do
  sleep_ms "$ms"
  i=$((i + 1))
  echo "@status Step $i of $steps"
  echo "@progress $((i * 100 / steps))"
done
total=$((steps * ms))
echo "@result Finished $steps steps in $((total / 1000)).$((total % 1000 / 100)) s"
