#!/usr/bin/env bash
# scripts/dev/dev_stack.sh — the dev agent's validation stack (backend/app/dev.py start_stack).
#
#   scripts/dev/dev_stack.sh start [--worktree <path>] [--workspaces <dir>] [--corpus <name>]
#   scripts/dev/dev_stack.sh stop | status | restart
#
# Starts uvicorn on 8301 (--reload) and Vite on 5301 (proxying /api to 8301) from a ticket's worktree (default: the
# live checkout recorded in server.json). The environment comes only from <THIMBLE_HOME>/server.json.env, so it runs
# from a clean shell. THIMBLE_WORKSPACES_DIR points at a snapshot copy of the workspace (--corpus copies
# <workspaces_dir>/<corpus> into --workspaces once), never at the live workspaces. Pids go to
# <THIMBLE_HOME>/dev/stack.json and are stopped by pid. THIMBLE_STACK_PORT / THIMBLE_STACK_UI_PORT override 8301/5301;
# THIMBLE_STACK_VITE_CACHE is handed to Vite as VITE_CACHE_DIR, to keep a worktree's optimizer cache out of a shared
# node_modules.
set -euo pipefail

HOME_DIR="${THIMBLE_HOME:-$HOME/.thimble}"
STATE="$HOME_DIR/server.json"
DEV="$HOME_DIR/dev"
STACK="$DEV/stack.json"
API_PORT="${THIMBLE_STACK_PORT:-8301}"
UI_PORT="${THIMBLE_STACK_UI_PORT:-5301}"
BACKEND_LOG="$DEV/stack-backend.log"
VITE_LOG="$DEV/stack-vite.log"
HEALTH_WAIT_S="${THIMBLE_STACK_WAIT:-90}"

cmd="${1:-status}"
shift || true
WORKTREE=""
WORKSPACES=""
CORPUS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$2"; shift 2 ;;
    --workspaces) WORKSPACES="$2"; shift 2 ;;
    --corpus) CORPUS="$2"; shift 2 ;;
    *) echo "dev_stack.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

jsonq() {  # jsonq <file> <dotted.key>  → the value or ""
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
for k in sys.argv[2].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else d)
PY
}

spawn() {  # spawn <logfile> <cmd...> → pid. Own session (setsid), stdin /dev/null, stdout+stderr appended to the log,
  # every other fd closed: a child that inherits a copy of this script's stdout pipe keeps the caller's read() from
  # ever seeing EOF (dev.py's start_stack would hang on that).
  python3 - "$@" <<'PY'
import os, subprocess, sys
with open(sys.argv[1], "ab") as log:
    p = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                         start_new_session=True, close_fds=True, cwd=os.getcwd())
print(p.pid)
PY
}

alive() {  # a live, non-zombie process
  if [ -z "${1:-}" ] || ! kill -0 "$1" 2>/dev/null; then return 1; fi
  if [ "$(awk '{ sub(/.*\) /, ""); print $1 }' "/proc/$1/stat" 2>/dev/null || echo X)" = "Z" ]; then return 1; fi
  return 0
}
cmdline() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true; }
listening() { python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.3); sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1])))==0 else 1)' "$1"; }
healthy() { curl -sf -m 1 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; }

session_pids() {  # every live pid whose session id is $1 (the session setsid created for our command), leader first
  local leader="$1" p sid
  echo "$leader"
  for p in /proc/[0-9]*; do
    p="${p#/proc/}"
    if [ "$p" = "$leader" ]; then continue; fi
    sid="$(awk '{ sub(/.*\) /, ""); print $4 }' "/proc/$p/stat" 2>/dev/null || true)"
    if [ "$sid" = "$leader" ]; then echo "$p"; fi
  done
  return 0
}

kill_pid() {  # kill_pid <pid> <must-contain> <label>: TERM then KILL every pid in the leader's session (by pid, from
  local pid="$1" needle="$2" label="$3" victims p any    # /proc; never a name pattern), only when the leader is ours
  if ! alive "$pid"; then echo "$label: not running"; return 0; fi
  local cl; cl="$(cmdline "$pid")"
  case "$cl" in
    *"$needle"*) ;;
    *) echo "$label: pid $pid is not ours; left alone"; return 0 ;;
  esac
  victims="$(session_pids "$pid" || true)"
  for p in $victims; do kill -TERM "$p" 2>/dev/null || true; done
  for _ in $(seq 1 50); do
    any=0
    for p in $victims; do if alive "$p"; then any=1; fi; done
    if [ "$any" = 0 ]; then break; fi
    sleep 0.1
  done
  any=0
  for p in $victims; do if alive "$p"; then kill -KILL "$p" 2>/dev/null || true; any=1; fi; done
  if [ "$any" = 1 ]; then echo "$label: pid $pid killed"; else echo "$label: pid $pid stopped"; fi
  return 0
}

do_stop() {
  if [ ! -f "$STACK" ]; then echo "dev stack: not running"; return 0; fi
  kill_pid "$(jsonq "$STACK" backend_pid)" "uvicorn" "stack backend"
  kill_pid "$(jsonq "$STACK" vite_pid)" "vite" "stack vite"
  rm -f "$STACK"
}

do_status() {
  local up=false ui=false
  healthy && up=true
  listening "$UI_PORT" && ui=true
  local wt="" ws=""
  if [ -f "$STACK" ]; then wt="$(jsonq "$STACK" worktree)"; ws="$(jsonq "$STACK" workspaces)"; fi
  printf '{"api": "http://127.0.0.1:%s", "healthy": %s, "ui": "http://127.0.0.1:%s", "ui_listening": %s, "worktree": "%s", "workspaces": "%s"}\n' \
    "$API_PORT" "$up" "$UI_PORT" "$ui" "$wt" "$ws"
  $up
}

do_start() {
  if [ ! -f "$STATE" ]; then echo "dev_stack.sh: no $STATE (run thimble server up first)" >&2; exit 1; fi
  local DATA_DIR WS_SRC PLUGIN REPO
  DATA_DIR="$(jsonq "$STATE" env.data_dir)"
  WS_SRC="$(jsonq "$STATE" env.workspaces_dir)"
  PLUGIN="$(jsonq "$STATE" env.plugin_dir)"
  REPO="$(jsonq "$STATE" repo)"
  WORKTREE="${WORKTREE:-$REPO}"
  WORKSPACES="${WORKSPACES:-$DEV/stack.workspaces}"
  [ -d "$WORKTREE/backend" ] || { echo "dev_stack.sh: $WORKTREE has no backend/" >&2; exit 1; }
  [ -n "$DATA_DIR" ] || { echo "dev_stack.sh: server.json.env.data_dir is empty" >&2; exit 1; }
  mkdir -p "$DEV" "$WORKSPACES"
  if [ -n "$CORPUS" ] && [ -d "$WS_SRC/$CORPUS" ] && [ ! -d "$WORKSPACES/$CORPUS" ]; then
    cp -a "$WS_SRC/$CORPUS" "$WORKSPACES/$CORPUS"
    rm -rf "$WORKSPACES/$CORPUS/.claude-config" "$WORKSPACES/$CORPUS/kernels"
  fi
  if [ -f "$STACK" ]; then do_stop >/dev/null; fi
  if listening "$API_PORT"; then echo "dev_stack.sh: port $API_PORT is in use by a process this script did not start" >&2; exit 1; fi

  local common=(env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" LANG="${LANG:-C.UTF-8}"
    THIMBLE_DATA_DIR="$DATA_DIR" THIMBLE_WORKSPACES_DIR="$WORKSPACES"
    THIMBLE_PORT="$API_PORT" THIMBLE_UI_PORT="$UI_PORT" THIMBLE_FRONTEND_URL="http://127.0.0.1:$UI_PORT"
    THIMBLE_HOME="$DEV/stack.home" THIMBLE_PLUGIN_DIR="$PLUGIN" THIMBLE_DEV_STACK=0
    VITE_CACHE_DIR="$DEV/vite-cache")  # frontend/vite.config.ts: never the shared node_modules/.vite of a symlinked checkout
  [ -n "${THIMBLE_SKIP_KEY:-}" ] && common+=(THIMBLE_SKIP_KEY="$THIMBLE_SKIP_KEY")
  [ -n "${THIMBLE_MODEL_BACKEND:-}" ] && common+=(THIMBLE_MODEL_BACKEND="$THIMBLE_MODEL_BACKEND")
  [ -n "${VITE_CACHE_DIR:-}" ] && common+=(VITE_CACHE_DIR="$VITE_CACHE_DIR")  # a worktree's Vite cache off the shared node_modules (vite.config.ts)
  [ -n "${THIMBLE_DEV:-}" ] && common+=(THIMBLE_DEV="$THIMBLE_DEV")  # dev mode on the stack too (main.dev_mode)
  [ -n "${THIMBLE_PROMPT_CAPTURE:-}" ] && common+=(THIMBLE_PROMPT_CAPTURE="$THIMBLE_PROMPT_CAPTURE")  # backend/app/capture.py: every model call written to this directory

  local backend_pid vite_pid=""
  backend_pid="$(cd "$WORKTREE/backend" && spawn "$BACKEND_LOG" "${common[@]}" .venv/bin/python -m uvicorn app.main:app \
      --host 127.0.0.1 --port "$API_PORT" --reload --reload-dir app --timeout-graceful-shutdown 3)"
  if [ -d "$WORKTREE/frontend/node_modules" ]; then
    local vite_env=(BACKEND_PORT="$API_PORT")
    [ -n "${THIMBLE_STACK_VITE_CACHE:-}" ] && vite_env+=(VITE_CACHE_DIR="$THIMBLE_STACK_VITE_CACHE")
    vite_pid="$(cd "$WORKTREE/frontend" && spawn "$VITE_LOG" "${common[@]}" "${vite_env[@]}" npx vite \
        --port "$UI_PORT" --strictPort --host 127.0.0.1)"
  fi
  printf '{"backend_pid": %s, "vite_pid": %s, "worktree": "%s", "workspaces": "%s", "api": "http://127.0.0.1:%s", "ui": "http://127.0.0.1:%s", "started": "%s"}\n' \
    "$backend_pid" "${vite_pid:-null}" "$WORKTREE" "$WORKSPACES" "$API_PORT" "$UI_PORT" "$(date -u +%FT%TZ)" > "$STACK"
  local i
  for i in $(seq 1 $((HEALTH_WAIT_S * 2))); do
    healthy && break
    alive "$backend_pid" || { echo "dev_stack.sh: backend exited; tail of $BACKEND_LOG:" >&2; tail -20 "$BACKEND_LOG" >&2; do_stop >/dev/null; exit 1; }
    sleep 0.5
  done
  if ! healthy; then echo "dev_stack.sh: backend not healthy after ${HEALTH_WAIT_S}s" >&2; do_stop >/dev/null; exit 1; fi
  do_status
}

case "$cmd" in
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  restart)
    if [ -f "$STACK" ]; then WORKTREE="${WORKTREE:-$(jsonq "$STACK" worktree)}"; WORKSPACES="${WORKSPACES:-$(jsonq "$STACK" workspaces)}"; fi
    do_stop >/dev/null; do_start ;;
  *) echo "usage: dev_stack.sh start|stop|status|restart [--worktree <path>] [--workspaces <dir>] [--corpus <name>]" >&2; exit 2 ;;
esac
