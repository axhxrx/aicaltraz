# Helpers shared by the fake-device scripts. Sourced: . "$(dirname "$0")/_lib.sh"

# Fake devices remember their state here between runs.
STATE_DIR=${BUTTPAD_FAKE_STATE:-${TMPDIR:-/tmp}/buttpad-fake-devices}
mkdir -p "$STATE_DIR"

# rand N: random integer in [0, N)
rand() {
  _r=$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' ')
  echo $(( ${_r:-$$} % $1 ))
}

# sleep_ms MS (fractional sleep works with GNU, BSD/macOS and busybox sleep)
sleep_ms() {
  sleep "$(($1 / 1000)).$(printf '%03d' $(($1 % 1000)))"
}

# latency MIN_MS MAX_MS: pretend to wait for a device on the network
latency() {
  sleep_ms $(($1 + $(rand $(($2 - $1 + 1)))))
}

# cap word: "key" -> "Key"
cap() {
  printf '%s\n' "$1" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }'
}

# counter NAME START: increment a persistent counter and print it
counter() {
  _n=$(cat "$STATE_DIR/$1" 2>/dev/null || echo "$2")
  _n=$((_n + 1))
  echo "$_n" > "$STATE_DIR/$1"
  echo "$_n"
}
