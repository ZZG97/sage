#!/usr/bin/env bash
set -euo pipefail

PORT="${AGENT_CHROME_PORT:-9222}"
DEBUG_ADDRESS="${AGENT_CHROME_DEBUG_ADDRESS:-127.0.0.1}"
PROFILE="${AGENT_CHROME_PROFILE:-$HOME/chrome-debug-profile}"
CHROME_BIN="${AGENT_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
LOG_FILE="${AGENT_CHROME_LOG:-/tmp/agent-chrome.log}"
SCREEN_SESSION="${AGENT_CHROME_SCREEN_SESSION:-agent-chrome}"

cdp_url="http://${DEBUG_ADDRESS}:${PORT}/json/version"

is_cdp_ready() {
  curl -fsS "$cdp_url" >/dev/null 2>&1
}

agent_chrome_main_pids() {
  ps -axo pid=,command= | awk \
    -v port="--remote-debugging-port=${PORT}" \
    -v profile="--user-data-dir=${PROFILE}" \
    '$0 ~ port && $0 ~ profile && $0 !~ /Google Chrome Helper/ && $0 !~ /awk/ { print $1 }'
}

agent_chrome_pids() {
  ps -axo pid=,command= | awk \
    -v profile="--user-data-dir=${PROFILE}" \
    '$0 ~ profile && $0 !~ /awk/ { print $1 }'
}

screen_session_exists() {
  command -v screen >/dev/null 2>&1 || return 1
  local sessions
  sessions="$(screen -ls 2>/dev/null || true)"
  grep -Eq "[[:space:]][0-9]+\\.${SCREEN_SESSION}[[:space:]]" <<<"$sessions"
}

clean_stale_singletons() {
  if [[ -z "$(agent_chrome_pids || true)" ]]; then
    rm -f "${PROFILE}/SingletonLock" "${PROFILE}/SingletonCookie" "${PROFILE}/SingletonSocket"
  fi
}

wait_for_cdp() {
  local i
  for i in {1..50}; do
    if is_cdp_ready; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

start() {
  if is_cdp_ready; then
    echo "Agent Chrome is already available at ${cdp_url}"
    return 0
  fi

  if [[ ! -x "$CHROME_BIN" ]]; then
    echo "Chrome binary not found or not executable: ${CHROME_BIN}" >&2
    return 1
  fi

  mkdir -p "$PROFILE" "$(dirname "$LOG_FILE")"
  clean_stale_singletons

  if [[ -n "$(agent_chrome_pids || true)" ]]; then
    echo "Agent Chrome process exists but CDP is not ready; stop it first." >&2
    agent_chrome_pids | sed 's/^/PID: /' >&2
    return 1
  fi

  if command -v screen >/dev/null 2>&1; then
    screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
    screen -dmS "$SCREEN_SESSION" bash -lc 'log_file="$1"; shift; exec "$@" >>"$log_file" 2>&1' bash \
      "$LOG_FILE" \
      "$CHROME_BIN" \
      "--remote-debugging-address=${DEBUG_ADDRESS}" \
      "--remote-debugging-port=${PORT}" \
      "--user-data-dir=${PROFILE}" \
      --no-first-run \
      --no-default-browser-check \
      about:blank
  else
    nohup "$CHROME_BIN" \
      "--remote-debugging-address=${DEBUG_ADDRESS}" \
      "--remote-debugging-port=${PORT}" \
      "--user-data-dir=${PROFILE}" \
      --no-first-run \
      --no-default-browser-check \
      about:blank \
      >>"$LOG_FILE" 2>&1 &

    disown "$!" 2>/dev/null || true
  fi

  if wait_for_cdp; then
    echo "Started Agent Chrome at ${cdp_url}"
    echo "Profile: ${PROFILE}"
    echo "Log: ${LOG_FILE}"
    if screen_session_exists; then
      echo "Screen: ${SCREEN_SESSION}"
    fi
    return 0
  fi

  echo "Agent Chrome was launched but CDP did not become ready: ${cdp_url}" >&2
  echo "Check log: ${LOG_FILE}" >&2
  return 1
}

status() {
  if is_cdp_ready; then
    echo "Agent Chrome is available at ${cdp_url}"
    agent_chrome_main_pids | sed 's/^/PID: /'
    if screen_session_exists; then
      echo "Screen: ${SCREEN_SESSION}"
    fi
  else
    echo "Agent Chrome is not available at ${cdp_url}"
    if [[ -n "$(agent_chrome_pids || true)" ]]; then
      echo "Profile processes without ready CDP:" >&2
      agent_chrome_pids | sed 's/^/PID: /' >&2
    fi
    return 1
  fi
}

stop() {
  local pids
  pids="$(agent_chrome_main_pids || true)"

  if screen_session_exists; then
    screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
  fi

  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
  fi

  local i
  for i in {1..50}; do
    if [[ -z "$(agent_chrome_pids || true)" ]]; then
      clean_stale_singletons
      echo "Stopped Agent Chrome"
      return 0
    fi
    sleep 0.1
  done

  echo "Agent Chrome did not stop after SIGTERM; sending SIGKILL to remaining PIDs:" >&2
  agent_chrome_pids | sed 's/^/PID: /' >&2
  agent_chrome_pids | xargs kill -9 2>/dev/null || true
  clean_stale_singletons
  echo "Stopped Agent Chrome"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [start|stop|status]

Environment:
  AGENT_CHROME_PORT            Default: 9222
  AGENT_CHROME_DEBUG_ADDRESS   Default: 127.0.0.1
  AGENT_CHROME_PROFILE         Default: \$HOME/chrome-debug-profile
  AGENT_CHROME_BIN             Default: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  AGENT_CHROME_LOG             Default: /tmp/agent-chrome.log
  AGENT_CHROME_SCREEN_SESSION  Default: agent-chrome
EOF
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h|--help|help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
