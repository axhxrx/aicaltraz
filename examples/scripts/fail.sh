#!/bin/sh
# Always fails: a status line, then an error on stderr and exit code 3.
echo "@status Waking the projector…"
sleep 0.5
echo "projector: connection refused (192.0.2.50:4352)" >&2
exit 3
