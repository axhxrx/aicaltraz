#!/bin/sh
# Fake smart light.  Usage: light.sh <key|fill|back|all> <on|off|toggle|0-100>
# Takes 0.2-1.5 s to "reach" the light, remembers its level, reports e.g. "@result Key light ON 80%",
# and latches the light's state on the button ("@state ON 80%" / "@state OFF"; not for "all": one
# button's chip can't speak for three lights).
. "$(dirname "$0")/_lib.sh"

usage() {
  echo "usage: light.sh <key|fill|back|all> <on|off|toggle|0-100>" >&2
  exit 2
}
[ $# -eq 2 ] || usage
name=$1
cmd=$2
case $name in key | fill | back | all) ;; *) echo "light.sh: unknown light \"$name\" (key, fill, back or all)" >&2; exit 2 ;; esac
case $cmd in
  on | off | toggle) ;;
  *[!0-9]* | '') usage ;;
  *) [ "$cmd" -le 100 ] || usage ;;
esac

# set_one NAME CMD: apply CMD to one light, print its new state
set_one() {
  cur=$(cat "$STATE_DIR/light-$1" 2>/dev/null || echo 0)
  last=$(cat "$STATE_DIR/light-$1.last" 2>/dev/null || echo 80)
  case $2 in
    on) new=$last ;;
    off) new=0 ;;
    toggle) if [ "$cur" -gt 0 ]; then new=0; else new=$last; fi ;;
    *) new=$2 ;;
  esac
  echo "$new" > "$STATE_DIR/light-$1"
  if [ "$new" -gt 0 ]; then
    echo "$new" > "$STATE_DIR/light-$1.last"
    echo "$(cap "$1") light ON $new%"
  else
    echo "$(cap "$1") light OFF"
  fi
}

if [ "$name" = all ]; then
  for n in key fill back; do
    echo "@status $(cap "$n") light…"
    latency 100 500
    state=$(set_one "$n" "$cmd")
  done
  case $state in *OFF) echo "@result All lights OFF" ;; *) echo "@result All lights ON" ;; esac
else
  echo "@status Connecting to $(cap "$name") light…"
  latency 200 1500
  state=$(set_one "$name" "$cmd")
  echo "@state ${state#* light }"
  echo "@result $state"
fi
