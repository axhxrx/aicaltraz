#!/bin/sh
# Fake camera.  Usage: camera.sh <rec|snap|battery|upload|format>
. "$(dirname "$0")/_lib.sh"

case ${1:-} in
  rec) # toggles recording
    echo "@status Talking to the camera…"
    latency 200 700
    if [ -f "$STATE_DIR/camera-rec" ]; then
      secs=$(($(date +%s) - $(cat "$STATE_DIR/camera-rec")))
      rm -f "$STATE_DIR/camera-rec"
      clip=$(counter camera-clip 41)
      echo "@result REC stopped · clip_$(printf %04d "$clip").mov ($(printf '%d:%02d' $((secs / 60)) $((secs % 60))))"
    else
      date +%s > "$STATE_DIR/camera-rec"
      echo "@result ● Recording"
    fi
    ;;
  snap)
    latency 300 900
    echo "@result Saved IMG_$(printf %04d "$(counter camera-img 100)").JPG"
    ;;
  battery)
    latency 200 600
    pct=$((35 + $(rand 65)))
    echo "@result Battery $pct% (~$((pct * 3 / 2)) min left)"
    ;;
  upload)
    n=$((3 + $(rand 4)))
    i=0
    while [ $i -lt "$n" ]; do
      i=$((i + 1))
      echo "@status Uploading clip $i of $n"
      for p in 0 25 50 75; do
        echo "@progress $((((i - 1) * 100 + p) / n))"
        sleep_ms 250
      done
    done
    echo "@progress 100"
    echo "@result Uploaded $n clips"
    ;;
  format)
    echo "@status Formatting card…"
    for p in 10 35 60 85 100; do
      sleep_ms 400
      echo "@progress $p"
    done
    rm -f "$STATE_DIR/camera-clip" "$STATE_DIR/camera-img"
    echo "@result Card formatted (pretend: nothing was deleted)"
    ;;
  *)
    echo "usage: camera.sh <rec|snap|battery|upload|format>" >&2
    exit 2
    ;;
esac
