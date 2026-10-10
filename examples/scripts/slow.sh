#!/bin/sh
# Takes 20 s (or $1 seconds), reporting elapsed time. For cancel and timeout testing.
secs=${1:-20}
i=0
trap 'echo "slow.sh: stopped after ${i}s" >&2; exit 143' TERM INT
while [ "$i" -lt "$secs" ]; do
  echo "@status ${i}s of ${secs}s"
  sleep 1 &
  wait $!
  i=$((i + 1))
done
echo "@result Done after ${secs}s"
