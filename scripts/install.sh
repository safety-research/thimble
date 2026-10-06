#!/usr/bin/env bash
# scripts/install.sh — install thimble: a git checkout in place (a Dev install), or an unzipped release, copied into
# ~/.thimble/app (a Global install).
#
#   scripts/install.sh [--dry-run] [--verbose] [--browser bundled|system|off] [--sandbox-deps | --no-sandbox-deps]
#                      [--plugin | --no-plugin] [--dir DIR] [--dev] [--python PATH] [--deps-only] [--require-pinned]
#                      [--marketplace-name NAME]
#
# It opens with one screen: what it found (Claude Code, Python or uv, Node, a browser, Claude Code's sandbox), what it
# installs where and about how big, what it changes in your Claude Code setup, and the questions that remain, often
# none. It asks those, then prints a line per step. Every command it runs, with its output, goes to
# $THIMBLE_HOME/install.log (~/.thimble/install.log).
#
# The questions, each asked only when it remains, and the flags that answer them without asking:
#   --browser bundled|system|off   a browser for screenshots, asked only when no Chrome or Edge that starts under
#                          automation is found where Playwright looks (one that does is used, and nothing is downloaded).
#                          bundled downloads Playwright's headless Chromium (about 210 MB to download, 650 MB on disk);
#                          system uses the Chrome or Edge found anyway; off takes no screenshots
#   --sandbox-deps         on Linux, asked only while Claude Code's sandbox can't run: install what it lacks with sudo
#                          (bubblewrap and socat, and on Ubuntu 23.10+ an AppArmor profile for bwrap). --no-sandbox-deps
#                          answers no
# An answer is kept in $THIMBLE_HOME, so a re-run or `thimble update` doesn't ask it again; its flag changes it. Without a
# terminal install.sh stops while a question remains without its flag, and lists those.
#
#   --dry-run              print the opening screen and the questions that remain, each with its flags; change nothing.
#                          An agent installing thimble for someone asks exactly those questions (CLAUDE.md, Installing)
#   --verbose              also print each command it runs and its output; with --dry-run, every step's commands
#   --plugin               add thimble to every Claude Code session; --no-plugin takes back what an earlier --plugin
#                          added. Without either nothing changes: the `thimble` command loads its plugin into the
#                          sessions it starts
#   --dir DIR              where the tree goes (default: this checkout, in place; $THIMBLE_HOME/app for a release)
#   --dev                  also install the backend's test extras (a checkout always gets them)
#   --python PATH          use the virtual environment of the python at PATH as backend/.venv: install.sh checks that it
#                          holds what backend/pyproject.toml asks for and installs nothing into it
#   --deps-only            stop after the browser: no `thimble` command, plugin or doctor
#   --require-pinned       install only pinned versions: stop where the package index lacks one, and where nothing pins
#                          them (a Dev install without uv or without backend/uv.lock)
#   --marketplace-name N   the name Claude Code registers the tree under (default: .claude-plugin/marketplace.json's)
#   --trust-workspaces, --no-trust-workspaces   accepted and ignored: thimble 0.6.0's agents need no folder Claude Code
#                          trusts, so install.sh no longer asks about it
# THIMBLE_BIN_DIR, when set, is the folder the `thimble` link goes into in place of ~/.local/bin.
set -euo pipefail
# How it works (not printed by --help).
# Steps: what it finds (check_prerequisites) and plans (plan: each question's plan, the plugin, the link) · the opening
# screen · the questions · the sandbox's packages, right after the questions, so that only sudo asks for more (its
# password) · copy the release into --dir · backend/.venv · the frontend's packages and frontend/dist · the browser ·
# the app-dir pointer and `thimble` on PATH (~/.local/bin/thimble → the tree's plugin/bin/thimble) · the plugin, only on
# --plugin or --no-plugin or an earlier yes (scripts/plugin.sh) · doctor · what to do next.
# Each question is one block of functions named after it, which adds its name to QUESTIONS; the rest of the script
# reaches a question only through those functions, so deleting its block removes it.
# The browser and plugin answers are kept in $THIMBLE_HOME (config.json's "browser", plugin.json). A
# Chrome or Edge used because it was found and started is not recorded: the server picks it too when config.json names
# no browser (backend/app/userconf.py browser), and a later run asks only if it stops working.
# Another install's plugin registration (a marketplace added from another folder) and a ~/.local/bin/thimble linked into
# another install are never changed unasked: install.sh names that install, and only on a terminal asks to switch them.
# Re-running it (after `git pull`, over a newer release, or to answer a question again with its flag) skips the steps that
# are done: the same release is not copied again, pinned packages already installed are kept, and the browser is fetched
# only on a yes and only when the build thimble's Playwright needs is missing.
# A checkout gets backend/.venv from uv.lock with uv sync, and npm ci when package-lock.json changed since the packages were
# installed; it rebuilds frontend/dist when it is older than the frontend's sources or the lockfile, so a pulled clone ends
# with the current UI.
# A release installs from the package indexes the machine is set up with: the backend's packages from backend/requirements.txt
# (uv.lock's versions, with their hashes) by uv pip, or by pip where pip is set up with an index and uv is not; with its
# prebuilt frontend/dist, only the frontend packages the server and its scripts load (frontend/runtime, pinned by its own
# lockfile). Where the index lacks a pinned version, the newest versions pyproject.toml or frontend/runtime/package.json
# allow that the index has are installed instead (uv keeps the backend's other pins), and the packages that differ from
# the pinned versions are listed; --require-pinned stops there instead. A file whose hash differs from the pinned one
# stops the install, from either index.
# Needs: uv (or python3 >= 3.12); node >= 20 for custom views (a checkout: 20.19+, 22.13+ or 24+, which its frontend tests
# need), for the sandbox runtime card code and code tickets run in (a package of the frontend's), and to build
# frontend/dist when it is missing or out of date; the claude CLI to run thimble at all.
# The marketplace name is thimble-local from a release zip and thimble from a checkout (.claude-plugin/marketplace.json).

usage()  { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------------------------------------- output
# The terminal gets the opening screen, the questions, and a line per step: ✓ when it is done, ! when it needs you
# (show, ok, warn, note). The details (say), each command run (run, run_in) and its output go to fd 4, the log
# ($home/install.log, opened by keep_log; /dev/null in a dry run), and to the terminal too with --verbose. A command's
# output is also kept in $tmp/out, whose tail tail_out shows when the command failed. On a terminal, busy shows what
# a long step is doing until its line replaces it.
verbose=0 dry=0 busy_on=0 log_file="" wrap=0 cols=100 c_ok="" c_warn="" c_head="" c_off="" todo=()
init_term() {
  if [ -t 1 ]; then
    wrap=1
    cols="$( (tput cols) 2>/dev/null || echo 100)"; case "$cols" in '' | *[!0-9]*) cols=100;; esac
    [ "$cols" -le 100 ] || cols=100
    if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
      c_ok=$'\033[32m' c_warn=$'\033[33m' c_head=$'\033[1m' c_off=$'\033[0m'
    fi
  fi
}
clear_busy() { if [ "$busy_on" = 1 ]; then printf '\r\033[K'; busy_on=0; fi; }
show()    { clear_busy; printf '%s\n' "$*"; printf '%s\n' "$*" >&4; }
showf()   { clear_busy; printf '%s\n' "$*" | folded 0; printf '%s\n' "$*" >&4; }  # show, folded at the terminal's width
heading() { clear_busy; printf '\n%s%s%s\n' "$c_head" "$*" "$c_off"; printf '\n%s\n' "$*" >&4; }
mark()    { # mark ok|warn TEXT: TEXT after ✓ or !, folded at the terminal's width with its later lines indented
  local sym="✓" col="$c_ok"
  [ "$1" = ok ] || { sym="!"; col="$c_warn"; }
  clear_busy
  printf '%s\n' "$2" | folded 2 | sed "1s/^  /$col$sym$c_off /"
  printf '%s %s\n' "$sym" "$2" >&4
}
ok()      { if [ "$dry" = 1 ]; then say "(dry run: would print) ✓ $*"; else mark ok "$*"; fi; }
warn()    { if [ "$dry" = 1 ]; then say "(dry run: would print) ! $*"; else mark warn "$*"; fi; }
note()    { if [ "$dry" = 1 ]; then say "(dry run: would print)   $*"; else clear_busy; printf '%s\n' "$*" | folded 2; printf '  %s\n' "$*" >&4; fi; }
say()     { printf '%s\n' "$*" >&4; if [ "$verbose" = 1 ]; then clear_busy; printf '%s\n' "$*"; fi; }
busy()    { say "… $*"; if [ "$verbose" = 0 ] && [ "$wrap" = 1 ] && [ "$dry" = 0 ]; then clear_busy; printf '… %s' "$*"; busy_on=1; fi; }
todo()    { todo+=("$*"); }   # todo TEXT: left for the user, listed at the end
folded()  { # folded INDENT: stdin with each line indented by INDENT spaces, folded at the terminal's width on a terminal
  local ind; ind="$(printf '%*s' "$1" '')"
  if [ "$wrap" = 1 ]; then fold -s -w $((cols - $1)) | sed -e "s/^/$ind/" -e 's/ *$//'; else sed "s/^/$ind/"; fi
}
die() {
  clear_busy
  printf 'install.sh: %s\n' "$*" >&2  # which keep_log also sends to the log
  [ -z "$log_file" ] || printf 'Every command install.sh ran, with its output, is in %s\n' "$(tilde "$log_file")" >&2
  exit 1
}
tilde() { case "$1" in "$HOME") printf '~\n';; "$HOME"/*) printf '~%s\n' "${1#"$HOME"}";; *) printf '%s\n' "$1";; esac; }
tildes() {  # tildes TEXT: TEXT with each path under $HOME written ~/…
  local t="$1" out=""
  [ -n "${HOME:-}" ] && [ "$HOME" != / ] || { printf '%s\n' "$t"; return 0; }
  while [[ "$t" == *"$HOME/"* ]]; do out="$out${t%%"$HOME/"*}~/"; t="${t#*"$HOME/"}"; done
  printf '%s\n' "$out$t"
}
_run() {  # _run LINE CMD…: LINE as a detail, then (not in a dry run) CMD, its output a detail and kept in $tmp/out
  local line="$1" rc=0; shift
  say "$line"
  [ "$dry" = 1 ] && return 0
  if [ "$verbose" = 1 ]; then clear_busy; { "$@" 2>&1 | tee "$tmp/out"; } || rc=$?
  else "$@" > "$tmp/out" 2>&1 || rc=$?; fi
  cat "$tmp/out" >&4
  [ "$rc" = 0 ] || say "(exit $rc)"
  return "$rc"
}
run()    { _run "+$(printf ' %q' "$@")" "$@"; }
in_dir() { ( cd "$1" && shift && "$@" ); }
run_in() { local d="$1"; shift; _run "+ cd $(printf '%q' "$d") &&$(printf ' %q' "$@")" in_dir "$d" "$@"; }
logged() {  # logged LOG CMD…: run, with the command's output also copied to LOG
  local log="$1" rc=0; shift
  run "$@" || rc=$?
  [ "$dry" = 1 ] || cp "$tmp/out" "$log"
  return "$rc"
}
tail_out() {  # the last lines of the command that just failed, on the terminal (its whole output is in the log)
  [ "$dry" = 0 ] && [ "$verbose" = 0 ] && [ -s "$tmp/out" ] || return 0
  clear_busy
  tail -n 12 "$tmp/out" | sed 's/^/    /'
}
json_get() {  # json_get FILE KEY — a top-level string value (python3 when present, else a sed for the flat case)
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2"
  else sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; fi
}
keep_log() {  # fd 4: $home/install.log, the last run's whole output, which `thimble feedback` carries; stderr goes there too
  [ "$dry" = 1 ] && return 0
  { mkdir -p "$home" && chmod 700 "$home" && (umask 077 && : > "$home/install.log"); } 2>/dev/null || return 0
  exec 4>>"$home/install.log"
  exec 2> >(tee -a "$home/install.log" >&2)
  log_file="$home/install.log"
}

QUESTIONS=()  # the questions in the order they are asked; each block below adds its own (see "How it works")
took=0        # the arguments a question's flag function used (parse_args)

parse_args() {
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  home="${THIMBLE_HOME:-$HOME/.thimble}"
  bin_dir="${THIMBLE_BIN_DIR:-$HOME/.local/bin}"
  dir="" mp_name="" dev=0 deps_only=0 plugin="" byo="" require_pinned=0 trust_ignored=""
  local q
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2;;
      --marketplace-name) mp_name="$2"; shift 2;;
      --dev) dev=1; shift;;
      --python) byo="$2"; shift 2;;
      --deps-only) deps_only=1; shift;;
      --require-pinned) require_pinned=1; shift;;
      --plugin) plugin=yes; shift;;
      --no-plugin) plugin=no; shift;;
      --trust-workspaces | --no-trust-workspaces) trust_ignored="$1"; shift;;  # 0.5.0's question, gone (opening)
      --dry-run) dry=1; shift;;
      -v | --verbose) verbose=1; shift;;
      -h | --help) usage; exit 0;;
      *) took=0
         for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if "${q}_flag" "$@"; then break; fi; done
         [ "$took" -gt 0 ] || { echo "install.sh: unknown argument $1" >&2; usage >&2; exit 2; }
         shift "$took";;
    esac
  done
}

locate_tree() {  # checkout or release, in place or copied, and the version
  [ -f "$src/backend/pyproject.toml" ] && [ -d "$src/plugin/bin" ] || die "$src is not a thimble tree (no backend/pyproject.toml + plugin/bin)"
  checkout=0; [ -e "$src/.git" ] && checkout=1
  if [ "$checkout" = 1 ]; then dev=1; fi  # a Dev install gets the backend's test extras
  if [ -z "$dir" ]; then if [ "$checkout" = 1 ]; then dir="$src"; else dir="$home/app"; fi; fi
  in_place=0
  if [ -d "$dir" ] && [ "$(cd "$dir" && pwd -P)" = "$src" ]; then in_place=1; dir="$src"; fi  # the resolved spelling, however --dir wrote it
  # copying a release over a clone would mix the release's files into the clone's tracked ones
  if [ "$in_place" = 0 ] && [ -e "$dir/.git" ]; then
    die "$dir is a git checkout (a dev install), and install.sh copies no tree over one. Update it with git pull (thimble update does it), or install the release elsewhere with THIMBLE_HOME=<dir> or --dir <dir>"
  fi
  # copying replaces entries of $dir with `rm -rf`, so it goes only into an empty folder or an earlier install
  if [ "$in_place" = 0 ]; then
    if [ "$dir" -ef / ] || [ "$dir" -ef "$HOME" ]; then
      die "the install folder $dir is $( [ "$dir" -ef / ] && echo 'the root directory' || echo 'your home directory' ); install into a folder of its own, such as $home/app"
    fi
    if [ -e "$dir" ] && [ ! -d "$dir" ]; then die "the install folder $dir is not a directory"; fi
    if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ] && [ ! -f "$dir/plugin/.claude-plugin/plugin.json" ]; then
      die "the install folder $dir is neither empty nor a thimble install (no plugin/.claude-plugin/plugin.json), and installing would replace entries in it; install into an empty folder or an earlier install"
    fi
  fi
  version="$(json_get "$src/plugin/.claude-plugin/plugin.json" version)"
  say "thimble $version from $src ($( [ "$checkout" = 1 ] && echo 'git checkout' || echo 'unpacked release' )) → $dir$( [ "$in_place" = 1 ] && echo ' (in place)' )"
  # a THIMBLE_HOME other than ~/.thimble must stay set: the plugin copy in Claude Code's cache, `thimble update` and the
  # server find this install and its state through $THIMBLE_HOME/app-dir (plugin/bin/thimble-app-dir)
  custom_home=0
  if [ -n "${THIMBLE_HOME:-}" ] && [ "${THIMBLE_HOME%/}" != "$HOME/.thimble" ]; then
    custom_home=1
    say "THIMBLE_HOME=$THIMBLE_HOME: server state and the app-dir pointer go there$( [ "$checkout" = 0 ] && [ "$dir" = "$home/app" ] && echo ', and the release to its app/' ), in place of ~/.thimble"
  fi
}

py_ok() {  # py_ok PYTHON: it runs and is at least pyproject's requires-python
  (cd / && "$1" -I -c "import sys; sys.exit(0 if sys.version_info >= tuple(int(x) for x in '$req_py'.split('.')) else 1)") 2>/dev/null
}

sets_key() {  # sets_key REGEX FILE…: a line of one of the existing FILEs matches REGEX
  local re="$1" f; shift
  for f in "$@"; do if [ -n "$f" ] && [ -f "$f" ] && grep -qiE "$re" "$f"; then return 0; fi; done
  return 1
}

config_files() {  # config_files NAME: NAME under each folder of XDG_CONFIG_DIRS, where pip and uv look for the machine's settings
  local rest="${XDG_CONFIG_DIRS:-/etc/xdg}:" d
  while [ -n "$rest" ]; do d="${rest%%:*}"; rest="${rest#*:}"; [ -z "$d" ] || printf '%s\n' "$d/$1"; done
}

pip_index_set() {  # pip is set up with a package index: PIP_INDEX_URL or its kin, or the same setting in a pip config file
  [ -z "${PIP_INDEX_URL:-}${PIP_EXTRA_INDEX_URL:-}${PIP_FIND_LINKS:-}${PIP_NO_INDEX:-}" ] || return 0
  local files=("${PIP_CONFIG_FILE:-}" "${XDG_CONFIG_HOME:-$HOME/.config}/pip/pip.conf" "$HOME/.pip/pip.conf"
               "$HOME/Library/Application Support/pip/pip.conf" /etc/pip.conf "/Library/Application Support/pip/pip.conf") f
  while IFS= read -r f; do files+=("$f"); done < <(config_files pip/pip.conf)
  sets_key '^[[:space:]]*(index[-_]url|extra[-_]index[-_]url|find[-_]links|no[-_]index)[[:space:]]*[=:]' "${files[@]}"
}

uv_index_set() {  # uv is set up with a package index: UV_DEFAULT_INDEX or its kin, or an index in a uv.toml it reads
  [ -z "${UV_DEFAULT_INDEX:-}${UV_INDEX:-}${UV_INDEX_URL:-}${UV_EXTRA_INDEX_URL:-}${UV_FIND_LINKS:-}${UV_NO_INDEX:-}" ] || return 0
  local files=("${UV_CONFIG_FILE:-}" "${XDG_CONFIG_HOME:-$HOME/.config}/uv/uv.toml" /etc/uv/uv.toml) f
  while IFS= read -r f; do files+=("$f"); done < <(config_files uv/uv.toml)
  sets_key '^[[:space:]]*((index-url|extra-index-url|find-links|no-index)[[:space:]]*=|\[\[index\]\])' "${files[@]}"
}

check_byo() {  # --python, before anything changes: the environment it belongs to (sys.prefix) runs its own bin/python, the
  # path backend/.venv will link to, and holds what pyproject.toml asks for (backend/app/env_check.py)
  local lacking
  case "$byo" in /*) ;; */*) byo="$PWD/$byo";; *) byo="$(command -v "$byo" || printf '%s' "$byo")";; esac
  py_ok "$byo" || die "--python $byo: not a python >= $req_py that runs"
  byo_prefix="$(cd / && "$byo" -I -c 'import sys; print(sys.prefix)')"
  [ "$(cd / && "$byo_prefix/bin/python" -I -c 'import sys; print(sys.prefix)' 2>/dev/null)" = "$byo_prefix" ] \
    || die "--python $byo: its environment $byo_prefix has no bin/python of its own; give the python of a virtual environment (<venv>/bin/python)"
  if [ -e "$dir/backend/.venv" ] && [ ! -L "$dir/backend/.venv" ] && [ ! "$dir/backend/.venv" -ef "$byo_prefix" ]; then
    die "$dir/backend/.venv is the environment an earlier install made; to use $byo_prefix in its place, delete it (rm -rf $dir/backend/.venv) and run this again"
  fi
  if ! lacking="$(cd / && "$byo_prefix/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" 2>&1)"; then
    die "the environment $byo_prefix lacks what thimble's backend needs. Install these into it, then run this again:
$lacking"
  fi
  byo_v="$(cd / && "$byo" -I -c 'import platform; print(platform.python_version())')"
  say "python: $byo_prefix/bin/python, $byo_v, holds what backend/pyproject.toml asks for; backend/.venv will link to it"
  if [ "$dev" = 1 ] && ! lacking="$(cd / && "$byo_prefix/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" --extra dev 2>&1)"; then
    say "it lacks the test extras, which only the tests need:"; say "$lacking"
  fi
}

check_prerequisites() {  # uv or python >= pyproject's requires-python, or --python's environment; node >= 20 unless
  # frontend/dist is built; the claude CLI. Each sets its line of the opening screen (found_*: a mark and a text)
  req_py="$(sed -n 's/^requires-python *= *">=\([0-9][0-9.]*\)".*/\1/p' "$src/backend/pyproject.toml")"; req_py="${req_py:-3.12}"
  have_uv=0 py="" pytool=pip
  ! command -v uv >/dev/null 2>&1 || have_uv=1
  for cand in python3 python3.14 python3.13 python3.12; do
    if command -v "$cand" >/dev/null 2>&1 && py_ok "$cand"; then py="$(command -v "$cand")"; break; fi
  done
  if [ "$have_uv" = 1 ] && { uv_index_set || ! pip_index_set; }; then pytool=uv; fi
  local uv_v="" py_v=""
  [ "$have_uv" = 0 ] || uv_v="uv $(uv --version 2>/dev/null | sed -e 's/^uv //' -e 's/ (.*//')"
  [ -z "$py" ] || py_v="Python $("$py" -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  found_py=ok
  if [ -n "$byo" ]; then
    check_byo
    found_py_text="Python $byo_v: your environment $(tilde "$byo_prefix"), which holds what thimble needs; nothing is installed into it"
  elif [ "$checkout" = 1 ] && [ "$have_uv" = 1 ]; then
    found_py_text="$uv_v: installs thimble's Python packages at their tested versions, and Python $req_py if this machine lacks it"
  elif [ "$have_uv" = 0 ] && [ -z "$py" ]; then
    die "neither uv nor Python $req_py+ was found. Install uv (https://docs.astral.sh/uv/getting-started/installation/) or Python $req_py+, then run this again"
  elif [ "$checkout" = 1 ]; then
    found_py=warn
    found_py_text="$py_v at $(tilde "$py"), and no uv: thimble's Python packages get the lowest versions it allows, not the tested ones (uv installs those: https://docs.astral.sh/uv/getting-started/installation/)"
  elif [ "$pytool" = uv ]; then
    found_py_text="$uv_v: installs thimble's pinned Python packages, and Python $req_py if this machine lacks it"
  elif [ "$have_uv" = 1 ]; then
    found_py_text="${py_v:-Python} with pip, which is set up with a package index (uv is not): pip installs thimble's pinned Python packages from it"
  else
    found_py_text="$py_v at $(tilde "$py"): pip installs thimble's pinned Python packages from the package index it is set up with"
  fi
  say "python: $found_py_text"
  has_dist=0; [ -f "$src/frontend/dist/index.html" ] && has_dist=1
  stale=""; if [ "$has_dist" = 1 ] && [ "$checkout" = 1 ] && [ "$in_place" = 1 ]; then stale="$(dist_stale "$src/frontend")"; fi
  node_found="$(command -v node >/dev/null 2>&1 && node -v || echo none)"
  major="$(printf '%s' "$node_found" | sed -n 's/^v\([0-9]*\).*/\1/p')"
  node_ok=0; [ "${major:-0}" -ge 20 ] && node_ok=1
  # a checkout's frontend tests, which a code ticket's checks run, need more: jsdom and the packages it loads require()
  # ES modules (their engines: ^20.19.0 || ^22.13.0 || >=24; cli.NODE_TESTS_FLOOR)
  minor="$(printf '%s' "$node_found" | sed -n 's/^v[0-9]*\.\([0-9]*\).*/\1/p')"
  if [ "$checkout" = 1 ] && [ "$node_ok" = 1 ] && ! { [ "$major" -ge 24 ] || { [ "$major" = 22 ] && [ "${minor:-0}" -ge 13 ]; } || { [ "$major" = 20 ] && [ "${minor:-0}" -ge 19 ]; }; }; then
    old_node="node $node_found at $(command -v node) is older than a checkout needs: the frontend's tests, which a code ticket's checks run, need Node 20.19+, 22.13+ or 24+. Upgrade Node and run this script again"
    if [ "$dry" = 1 ]; then show "install.sh stops here: $old_node"; else die "$old_node"; fi
  fi
  local no_node="Node 20+ not found"
  [ "$node_found" = none ] || no_node="Node $node_found is older than the 20 thimble needs"
  found_node=ok found_node_text="Node $node_found"
  if [ "$node_ok" = 1 ]; then :
  elif [ -n "$stale" ]; then
    found_node=warn found_node_text="$no_node, so the web interface stays at its last build, older than its sources, until Node 20+ (https://nodejs.org) is installed and this runs again"
  elif [ "$has_dist" = 1 ]; then
    found_node=warn found_node_text="$no_node: custom views, and the sandbox card code and code tickets run in, need it (https://nodejs.org); everything else installs"
  elif [ "$checkout" = 1 ]; then
    slug="$(json_get "$src/plugin/.claude-plugin/plugin.json" repository | sed -e 's#^https\{0,1\}://github\.com/##' -e 's#\.git$##')"
    die "no frontend/dist and no node >= 20 (found: $node_found). Install Node 20+ (https://nodejs.org) and re-run this script, or install from the release zip, which carries the built UI: gh release download --repo $slug --pattern 'thimble-*.zip' --dir ~/Downloads"
  else
    found_node=warn found_node_text="$no_node: the web interface needs a build, which needs it (https://nodejs.org); everything else installs"
  fi
  say "node: $found_node_text"
  if [ "$node_ok" != 1 ]; then
    if [ "$(uname -s)" = Darwin ]; then
      say "without node >= 20 card code gets no sandbox: the notebook kernel runs with your user's access"
    else
      say "without node >= 20 card code gets no sandbox runtime: the notebook kernel runs in bubblewrap where that works, else with your user's access"
    fi
    say "without node >= 20 a code ticket's checks run outside the sandbox, so thimble asks you before each code ticket starts"
  fi
  have_claude=0 found_claude=warn
  found_claude_text="Claude Code not found: thimble runs inside it, so install it before you run thimble (https://docs.anthropic.com/en/docs/claude-code)"
  if command -v claude >/dev/null 2>&1; then
    have_claude=1 found_claude=ok found_claude_text="Claude Code $(claude --version 2>/dev/null | head -n 1 | sed 's/ (Claude Code)$//')"
  fi
  say "claude: $found_claude_text"
  say "auth: thimble uses whichever auth path you have configured for claude"
}

copy_tree() {  # a release install: the release's entries replace the install's; .venv, node_modules, workspaces/, data/ and dev/ stay
  if [ "$in_place" = 1 ]; then say "the tree: in place, nothing to copy"; return 0; fi
  if [ -f "$src/RELEASE.json" ] && cmp -s "$src/RELEASE.json" "$dir/RELEASE.json"; then
    say "this release is installed there already (RELEASE.json matches, and it is copied last): nothing to copy"
    dir="$(cd "$dir" && pwd -P)"
    ok "thimble $version is in $(tilde "$dir") already"
    return 0
  fi
  busy "Copying thimble $version to $(tilde "$dir")"
  say "copying the release into $dir (kept there if present: backend/.venv, frontend/node_modules, workspaces/, data/, dev/)"
  run mkdir -p "$dir"
  for entry in plugin mods extensions backend prompts frontend .claude-plugin scripts README.md INSTALL.md docs LICENSE THIRD_PARTY_NOTICES RELEASE.json; do
    [ -e "$src/$entry" ] || continue
    keep=""; case "$entry" in backend) keep=.venv;; frontend) keep=node_modules;; esac
    say "+ replace $dir/$entry${keep:+/* except $keep}"
    [ "$dry" = 1 ] && continue
    if [ -z "$keep" ]; then rm -rf "$dir/$entry"; cp -R "$src/$entry" "$dir/$entry"; continue; fi
    mkdir -p "$dir/$entry"; find "$dir/$entry" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} +
    for e in "$src/$entry"/* "$src/$entry"/.[!.]*; do
      if [ -e "$e" ] && [ "$(basename "$e")" != "$keep" ]; then cp -R "$e" "$dir/$entry/"; fi
    done
  done
  if [ -d "$dir" ]; then dir="$(cd "$dir" && pwd -P)"; fi
  ok "Copied thimble $version to $(tilde "$dir")"
}

make_venv() {  # --python's environment linked; a linked one kept and checked; a checkout's from uv.lock (uv sync, else
  # venv + pip from pyproject); a release's from backend/requirements.txt (release_venv)
  local venv="$dir/backend/.venv" lacking where
  where="$(tilde "$venv")"
  extra=(); if [ "$dev" = 1 ]; then extra=(--extra dev); fi
  busy "Installing thimble's Python packages"
  if [ -n "$byo" ] && [ "$venv" -ef "$byo_prefix" ]; then
    say "backend/.venv is $byo_prefix already; used as it is"
    ok "Python packages: your environment $(tilde "$byo_prefix"), used as it is"
  elif [ -n "$byo" ]; then
    run ln -sfn "$byo_prefix" "$venv"
    ok "Python packages: your environment $(tilde "$byo_prefix"), linked as $where; nothing installed into it"
  elif [ -L "$venv" ]; then
    say "backend/.venv → $(readlink "$venv"): an environment of your own (install.sh --python), used as it is"
    if [ "$dry" = 0 ] && ! lacking="$(cd / && "$venv/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" 2>&1)"; then
      warn "Python packages: your environment $(readlink "$venv") lacks what this version needs, so the server may not start until these are installed into it:"
      note "$lacking"
    else
      ok "Python packages: your environment $(readlink "$venv"), used as it is"
    fi
  elif [ "$checkout" = 0 ]; then
    release_venv
  elif [ "$have_uv" = 1 ] && [ -f "$src/backend/uv.lock" ]; then
    run_in "$dir/backend" uv sync --frozen --no-dev --no-install-project ${extra[@]+"${extra[@]}"} \
      || { tail_out; die "uv sync could not install the backend's packages (above)"; }
    ok "Python packages ready in $where (the versions backend/uv.lock pins)"
  elif [ "$have_uv" = 1 ]; then
    [ "$require_pinned" = 0 ] || die "backend/uv.lock is missing, so nothing pins the backend's versions, and --require-pinned installs only pinned ones"
    run_in "$dir/backend" uv sync --no-dev --no-install-project ${extra[@]+"${extra[@]}"} \
      || { tail_out; die "uv sync could not install the backend's packages (above)"; }
    ok "Python packages installed in $where (backend/uv.lock is missing, so at the newest versions allowed, not the tested ones)"
  else
    [ "$require_pinned" = 0 ] || die "without uv the backend's pinned versions (backend/uv.lock) can't be installed, and --require-pinned installs only pinned ones; install uv (https://docs.astral.sh/uv/getting-started/installation/)"
    [ -x "$venv/bin/python" ] || run "$py" -I -m venv "$venv" || { tail_out; die "python -m venv failed (above)"; }
    say "pip from pyproject.toml (the minimum versions, not the pinned ones in uv.lock)"
    run "$venv/bin/python" -I -m pip install --quiet --upgrade pip || { tail_out; die "pip could not upgrade itself (above)"; }
    if [ "$dev" = 1 ]; then run "$venv/bin/python" -I -m pip install --quiet -e "$dir/backend[dev]" || { tail_out; die "pip could not install the backend's packages (above)"; }
    else run "$venv/bin/python" -I -m pip install --quiet -e "$dir/backend" || { tail_out; die "pip could not install the backend's packages (above)"; }; fi
    ok "Python packages installed in $where, at the lowest versions allowed (without uv, not the tested ones)"
  fi
}

new_venv() {  # new_venv VENV: a release's backend/.venv, made by uv, else by the venv module, with pip in it when pip installs
  local venv="$1" clear=()
  [ ! -e "$venv" ] || clear=(--clear)  # a venv whose python no longer runs
  if [ "$pytool" = pip ] && [ -n "$py" ]; then
    run "$py" -I -m venv ${clear[@]+"${clear[@]}"} "$venv" || { tail_out; die "python -m venv failed (above)"; }
  else
    run uv venv --quiet ${clear[@]+"${clear[@]}"} --python ">=$req_py" "$venv" || { tail_out; die "uv venv failed (above)"; }
    [ "$pytool" = uv ] || run "$venv/bin/python" -I -m ensurepip --quiet || { tail_out; die "ensurepip failed (above)"; }
  fi
}

py_install() {  # py_install LOG ARGS…: uv pip or pip installs ARGS into backend/.venv; LOG keeps the output
  local log="$1" venv="$dir/backend/.venv"; shift
  if [ "$pytool" = uv ]; then logged "$log" uv pip "$@" --python "$venv/bin/python"
  else logged "$log" "$venv/bin/python" -I -m pip install --quiet --disable-pip-version-check "$@"; fi
}

py_ranges() {  # py_ranges WHICH: pyproject's dependencies (all, or dev: the dev extra alone), at the versions it allows
  local req="$tmp/requirements.txt"
  [ "$dry" = 1 ] || "$dir/backend/.venv/bin/python" -I -c 'import sys, tomllib
p = tomllib.load(open(sys.argv[1], "rb"))["project"]
dev = p.get("optional-dependencies", {}).get("dev", []) if sys.argv[3] == "1" else []
print("\n".join(dev if sys.argv[2] == "dev" else p.get("dependencies", []) + dev))' "$src/backend/pyproject.toml" "$1" "$dev" > "$req"
  say "+ the requirements of backend/pyproject.toml$( [ "$1" = dev ] && echo "'s dev extra" ) into $req"
  if [ "$pytool" = uv ]; then set -- install -r "$req"; else set -- -r "$req"; fi
  py_install "$tmp/py.log" "$@" || { tail_out; die "the backend's packages could not be installed (above)"; }
}

py_differs() {  # py_differs REQ: the packages in backend/.venv at a version other than the one REQ pins
  [ "$dry" = 1 ] && return 0
  "$dir/backend/.venv/bin/python" -I - "$1" <<'PY' || true
import re, sys
from importlib import metadata


def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


text = open(sys.argv[1], encoding="utf-8").read()
pins = {norm(m[1]): (m[1], m[2]) for m in re.finditer(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)", text, re.M)}
have = {norm(d.metadata.get("Name")): d.version for d in metadata.distributions() if d.metadata.get("Name")}
diff = [f"  {name} {have[key]} (pinned {version})" for key, (name, version) in sorted(pins.items())
        if key in have and have[key] != version]
if diff:
    print("these packages differ from the versions backend/requirements.txt pins:", *diff, sep="\n")
else:
    print("every installed package is at the version backend/requirements.txt pins")
PY
}

release_venv() {  # the pinned packages of backend/requirements.txt (uv.lock's, with their hashes: release.sh) from the index
  # uv or pip is set up with (check_prerequisites); where that index lacks a pinned version, the newest versions
  # pyproject.toml allows that it has (py_ranges), and the list of those that differ from the pins
  local venv="$dir/backend/.venv" req="$src/backend/requirements.txt" stamp="$dir/backend/.venv/.thimble-requirements.txt" args
  local where; where="$(tilde "$venv")"
  if [ "$dev" = 0 ] && [ -f "$req" ] && cmp -s "$req" "$stamp" && (cd / && "$venv/bin/python" -I -c '') 2>/dev/null; then
    say "backend/.venv holds the packages backend/requirements.txt pins, installed by an earlier run"
    ok "Python packages in $where are up to date"
    return 0
  fi
  if ! { [ -x "$venv/bin/python" ] && (cd / && "$venv/bin/python" -I -c '') 2>/dev/null; }; then new_venv "$venv"
  elif [ "$pytool" = pip ] && ! (cd / && "$venv/bin/python" -I -c 'import pip') 2>/dev/null; then
    run "$venv/bin/python" -I -m ensurepip --quiet || { tail_out; die "ensurepip failed (above)"; }  # a venv an earlier install made with uv, which holds no pip
  fi
  if [ ! -f "$req" ]; then
    [ "$require_pinned" = 0 ] || die "no backend/requirements.txt, so nothing pins the backend's versions, and --require-pinned installs only pinned ones"
    say "no backend/requirements.txt, so nothing pins the versions: those backend/pyproject.toml allows"
    py_ranges all
    ok "Python packages installed in $where (nothing pins their versions, so the newest allowed)"
    return 0
  fi
  args=(sync --require-hashes "$req"); [ "$pytool" = uv ] || args=(--require-hashes --no-deps -r "$req")
  if py_install "$tmp/py.log" "${args[@]}"; then
    if [ "$dev" = 0 ]; then
      say "+ cp $req $stamp"
      [ "$dry" = 1 ] || cp "$req" "$stamp"
    else
      py_ranges dev
    fi
    ok "Python packages installed in $where"
  elif grep -qE 'Hash mismatch|DO NOT MATCH THE HASHES' "$tmp/py.log"; then
    tail_out; die "the package index served a file whose hash is not the one backend/requirements.txt pins (above), so nothing more is installed from it"
  elif [ "$require_pinned" = 1 ]; then
    tail_out; die "the package index lacks a version backend/requirements.txt pins (above), and --require-pinned installs only pinned versions"
  else
    say "the package index lacks a version backend/requirements.txt pins"
    if [ "$pytool" != uv ] || ! prefer_pins "$req"; then
      say "so install.sh installs the newest versions backend/pyproject.toml allows that the index has"
      py_ranges all
    fi
    local differs; differs="$(py_differs "$req")"
    say "$differs"
    warn "Python packages installed in $where, but the package index lacks some pinned versions, so newer ones were installed"
    [ -z "$differs" ] || note "$differs"
  fi
}

prefer_pins() {  # prefer_pins REQ (uv): backend/pyproject.toml resolved from the index with REQ's pins kept wherever the
  # index has them, the others at the newest versions it allows that the index has, installed with their hashes checked
  local out="$tmp/prefs.txt" py="$dir/backend/.venv/bin/python" extra=()
  [ "$dev" = 0 ] || extra=(--extra dev)
  say "so install.sh keeps each pin the index has, and for the others installs the newest versions backend/pyproject.toml allows that the index has"
  run cp "$1" "$out"  # uv pip compile keeps the versions its output file already names where it can
  logged "$tmp/py.log" uv pip compile "$src/backend/pyproject.toml" ${extra[@]+"${extra[@]}"} -o "$out" --generate-hashes \
    --quiet --python "$py" || return 1
  logged "$tmp/py.log" uv pip sync --require-hashes "$out" --python "$py"
}

dist_stale() {  # dist_stale FRONTEND: the first file frontend/dist is built from that is newer than its index.html (git
  # writes every file a pull or checkout changes, so a changed source is newer than the build), or nothing
  local fe="$1"
  (cd "$fe" && find src public index.html render.html package.json package-lock.json vite.config.* tsconfig*.json \
    -newer dist/index.html -type f -print 2>/dev/null | head -n 1) || true
}

install_packages() {  # a release with its UI built: the runtime packages (runtime_packages); else npm ci from
  # package-lock.json, and again whenever the lockfile differs from the copy the last run left in node_modules (after an
  # update). A symlinked node_modules is left alone. A checkout's node_modules installed without this script is kept while
  # npm's own record of the install (node_modules/.package-lock.json) is newer than package-lock.json. Returns 1 when npm
  # failed; a file whose hash is not the pinned one stops the install (npm_integrity). pkg_note: what it did, for the line
  local fe="$dir/frontend" stamp="$dir/frontend/node_modules/.thimble-package-lock.json"
  pkg_note="installed" pkg_differs=""
  if [ -L "$fe/node_modules" ]; then
    say "frontend/node_modules is a symlink → $(readlink "$fe/node_modules"); left alone"
    pkg_note="left as they are (a link to $(readlink "$fe/node_modules"))"
  elif [ "$checkout" = 0 ] && [ "$has_dist" = 1 ] && [ -f "$src/frontend/runtime/package-lock.json" ]; then
    runtime_packages || return 1
  elif [ -f "$stamp" ] && cmp -s "$fe/package-lock.json" "$stamp"; then
    say "frontend/node_modules matches package-lock.json"
    pkg_note="up to date"
  elif [ "$checkout" = 1 ] && [ ! -f "$stamp" ] && [ -f "$fe/node_modules/.package-lock.json" ] \
       && [ ! "$fe/package-lock.json" -nt "$fe/node_modules/.package-lock.json" ]; then
    say "frontend/node_modules present, installed after the last change to package-lock.json: kept"
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
    pkg_note="up to date"
  else
    logged "$tmp/npm.log" npm ci --prefix "$fe" --no-audit --no-fund || { npm_integrity package-lock.json; return 1; }
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
  fi
}

npm_integrity() {  # npm_integrity LOCKFILE: stop when npm's failure (in $tmp/npm.log) was a file whose hash is not the one
  # LOCKFILE pins
  if grep -q EINTEGRITY "$tmp/npm.log" 2>/dev/null; then
    tail_out; die "the npm registry served a file whose hash is not the one frontend/$1 pins (above), so nothing more is installed from it"
  fi
}

npm_differs() {  # the packages in frontend/node_modules at a version other than the one frontend/runtime/package-lock.json pins
  [ "$dry" = 1 ] && return 0
  "$dir/backend/.venv/bin/python" -I - "$dir/frontend" <<'PY' || true
import json, sys
from pathlib import Path

fe = Path(sys.argv[1])
diff = []
for key, entry in sorted(json.loads((fe / "runtime" / "package-lock.json").read_text("utf-8")).get("packages", {}).items()):
    if not key.startswith("node_modules/"):
        continue
    try:
        have = json.loads((fe / key / "package.json").read_text("utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        continue
    if have != entry.get("version"):
        diff.append(f"  {key.rsplit('node_modules/', 1)[1]} {have} (pinned {entry.get('version')})")
if diff:
    print("these packages differ from the versions frontend/runtime/package-lock.json pins:", *diff, sep="\n")
else:
    print("every installed package is at the version frontend/runtime/package-lock.json pins")
PY
}

runtime_packages() {  # only the frontend packages the server and its scripts load (frontend/runtime, which release.sh
  # writes: their part of package-lock.json, with each file's hash), from the registry npm is set up with; where it lacks
  # a pinned version, the newest versions frontend/runtime/package.json allows that it has, and the list of those that
  # differ from the pins (npm_differs). npm installs them in frontend/runtime, and they move to frontend/node_modules,
  # where the server and the scripts look. The stamp is written only for the pinned ones, so a later run tries those again
  local fe="$dir/frontend" rt="$dir/frontend/runtime" stamp="$dir/frontend/node_modules/.thimble-package-lock.json" pinned
  if [ -f "$stamp" ] && cmp -s "$rt/package-lock.json" "$stamp"; then
    say "frontend/node_modules holds the runtime packages frontend/runtime/package-lock.json pins"
    pkg_note="up to date"
    return 0
  fi
  say "the frontend's packages the server loads (frontend/runtime/package.json); the UI is built already"
  if logged "$tmp/npm.log" npm ci --prefix "$rt" --no-audit --no-fund; then
    pinned=1
  else
    npm_integrity runtime/package-lock.json
    [ "$require_pinned" = 0 ] || { tail_out; die "the npm registry lacks a version frontend/runtime/package-lock.json pins (above), and --require-pinned installs only pinned versions"; }
    say "the registry lacks a version frontend/runtime/package-lock.json pins, so install.sh installs the newest versions frontend/runtime/package.json allows that the registry has"
    run npm install --prefix "$rt" --no-audit --no-fund --no-package-lock || return 1
    pinned=0
  fi
  say "+ mv $rt/node_modules $fe/node_modules"
  [ "$dry" = 1 ] || { rm -rf "$fe/node_modules"; mv "$rt/node_modules" "$fe/node_modules"; }
  if [ "$pinned" = 1 ]; then
    say "+ cp $rt/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$rt/package-lock.json" "$stamp"
  else
    pkg_differs="$(npm_differs)"
    say "$pkg_differs"
    pkg_note="installed, but the npm registry lacks some pinned versions, so newer ones were installed"
  fi
}

build_ui() {  # with node >= 20 the frontend's packages, which custom views need; a checkout's frontend/dist older than
  # its sources is rebuilt (scripts/rebuild_ui.sh, which swaps the build in under a running server), any other existing
  # frontend/dist is kept, and without one the typecheck and vite build make it
  local where ui="" failed=0
  where="$(tilde "$dir/frontend/node_modules")"
  if [ "$node_ok" != 1 ]; then
    if [ "$has_dist" = 1 ]; then
      warn "Node packages not installed: custom views, and the sandbox card code and code tickets run in, need Node 20+"
    else
      warn "Node packages not installed and the web interface not built, since both need Node 20+"
    fi
    todo "install Node 20+ (https://nodejs.org), then run: bash $(tilde "$dir")/scripts/install.sh"
    return 0
  fi
  busy "Installing thimble's Node packages"
  if ! install_packages; then
    tail_out
    [ "$has_dist" = 1 ] || die "npm ci failed in $dir/frontend (above), so the web interface cannot be built; fix that and run this script again"
    failed=1 stale=""
  fi
  if [ -n "$stale" ]; then
    busy "Rebuilding the web interface (its sources changed)"
    say "rebuilding frontend/dist, which is older than frontend/$stale"
    if run bash "$dir/scripts/rebuild_ui.sh" --frontend "$dir/frontend"; then ui="; web interface rebuilt, since its sources changed"
    else tail_out; ui=""; warn "the web interface could not be rebuilt (above): it stays at its earlier build, older than its sources"; fi
  elif [ "$has_dist" = 0 ]; then
    busy "Building the web interface"
    say "building frontend/dist (the server serves it at its own port when THIMBLE_DEV is off)"
    run_in "$dir/frontend" npx tsc --noEmit -p tsconfig.app.json || { tail_out; die "the web interface's type check failed (above)"; }
    run_in "$dir/frontend" npx vite build || { tail_out; die "the web interface's build failed (above)"; }
    ui="; web interface built"
  else
    say "built UI at frontend/dist — the server serves it at its own port when THIMBLE_DEV is off (to rebuild after a source change: npx vite build in frontend/)"
  fi
  if [ "$failed" = 1 ]; then
    warn "Node packages: npm failed (above); custom views need them, so run this script again"
  elif [ -n "$pkg_differs" ]; then
    warn "Node packages $pkg_note$ui ($where)"
    note "$pkg_differs"
  else
    ok "Node packages $pkg_note in $where$ui"
  fi
}

# ---------------------------------------------------------------------------------- the browser question
QUESTIONS+=(browser)
browser=""  # --browser's value: bundled, system or off
browser_flag() {  # browser_flag ARG…: --browser VALUE or --browser=VALUE (took: how many arguments)
  case "$1" in
    --browser) browser="${2:-}"; took=$(( $# > 1 ? 2 : 1 ));;
    --browser=*) browser="${1#--browser=}"; took=1;;
    *) return 1;;
  esac
  case "$browser" in system | bundled | off) ;; *) die "--browser takes system, bundled or off (got '${browser}')";; esac
}

system_browser() {  # sys_channel, sys_name, sys_path: the Chrome or Edge that Playwright's chrome and msedge channels
  # launch, found where those channels look; all empty when neither is there
  local e c n p entries=()
  sys_channel="" sys_name="" sys_path=""
  case "$(uname -s)" in
    Darwin) entries=("chrome|Google Chrome|/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                     "msedge|Microsoft Edge|/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");;
    Linux) entries=("chrome|Google Chrome|/opt/google/chrome/chrome" "msedge|Microsoft Edge|/opt/microsoft/msedge/msedge");;
  esac
  # the tests' seam: one "channel|name|path" in place of the platform's (backend/tests_public/test_install_scripts.py)
  [ -z "${THIMBLE_TEST_SYSTEM_BROWSER:-}" ] || entries=("$THIMBLE_TEST_SYSTEM_BROWSER")
  for e in ${entries[@]+"${entries[@]}"}; do
    IFS='|' read -r c n p <<< "$e"
    if [ -x "$p" ]; then sys_channel="$c" sys_name="$n" sys_path="$p"; return 0; fi
  done
}

probe_browser() {  # sys_starts=1 when the system browser starts headless with remote debugging on, which is how
  # Playwright drives it (a policy such as RemoteDebuggingAllowed turns that off); 0 when it does not within 10 s
  local profile="$tmp/browser-probe" log="$tmp/browser-probe.log" pid
  sys_starts=0
  [ -n "$sys_path" ] || return 0
  mkdir -p "$profile"
  "$sys_path" --headless=new --no-sandbox --no-first-run --no-default-browser-check --disable-gpu \
    --use-mock-keychain --password-store=basic \
    --user-data-dir="$profile" --remote-debugging-port=0 about:blank > "$log" 2>&1 &
  pid=$!
  for _ in $(seq 40); do
    if grep -q 'DevTools listening on' "$log" 2>/dev/null; then sys_starts=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  say "$sys_name at $sys_path $( [ "$sys_starts" = 1 ] && echo 'starts' || echo 'does not start' ) headless with remote debugging"
}

BUNDLED_SIZE="about 210 MB to download, 650 MB on disk"  # both headless Chromium builds and ffmpeg, measured

pw_cache() {  # the folder Playwright downloads its browsers into, as Playwright resolves it
  case "${PLAYWRIGHT_BROWSERS_PATH:-}" in
    0) printf '%s\n' "the playwright package's own folder";;
    "") if [ "$(uname -s)" = Darwin ]; then printf '%s\n' "$HOME/Library/Caches/ms-playwright"
        else printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"; fi;;
    *) printf '%s\n' "$PLAYWRIGHT_BROWSERS_PATH";;
  esac
}

pw_location() {  # pw_location PLAYWRIGHT…: where that Playwright keeps the headless Chromium it launches (its install --dry-run)
  "$@" install --dry-run chromium-headless-shell 2>/dev/null \
    | awk '/^browser: chromium-headless-shell/ { f = 1; next } f && /Install location:/ { sub(/.*Install location: */, ""); print; exit }'
}

browser_prev() {  # the browser an earlier install or the user chose: config.json's "browser" in thimble's home; else
  # bundled over an earlier install whose backend's headless Chromium is downloaded (installs before 0.3.0 fetched it
  # without asking); else ""
  local v="" loc=""
  [ ! -f "$home/config.json" ] || v="$(json_get "$home/config.json" browser 2>/dev/null)" || v=""
  case "$v" in
    system | bundled | off) printf '%s\n' "$v";;
    *) if earlier_install; then loc="$(pw_location "$dir/backend/.venv/bin/python" -I -m playwright)" || loc=""; fi
       if [ -n "$loc" ] && [ -f "$loc/INSTALLATION_COMPLETE" ]; then printf 'bundled\n'; fi;;
  esac
}

earlier_install() { [ -e "$dir/backend/.venv" ]; }  # an earlier install is in --dir, which this run installs over

record_browser() {  # record_browser VALUE: config.json's "browser" (the file is created with that key alone when missing)
  local py="python3"
  command -v python3 >/dev/null 2>&1 || py="$dir/backend/.venv/bin/python"
  say "+ set \"browser\": \"$1\" in $home/config.json"
  [ "$dry" = 1 ] && return 0
  mkdir -p "$home"
  "$py" -I - "$home/config.json" "$1" <<'PY' >&4 2>&1 || note "(the answer was not recorded, so a later run asks again)"
import json, os, sys, tempfile
path, value = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
except ValueError as e:
    sys.exit(f"{path} is not valid JSON ({e}); fix it or remove it")
if not isinstance(data, dict):
    sys.exit(f"{path} does not hold a JSON object")
data["browser"] = value
fd, tmp = tempfile.mkstemp(prefix=".config.json.", dir=os.path.dirname(path))
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(json.dumps(data, indent=2) + "\n")
os.replace(tmp, path)
PY
}

launch_check() {  # launch_check [CHANNEL]: one launch by the card harness's Playwright (a system browser's CHANNEL, else
  # the headless Chromium), since a bare Linux server may lack the system libraries a downloaded one links. lc: "" when
  # it starts (or can't be tried), nolibs, or failed with lc_why
  local venv="$dir/backend/.venv"
  lc="" lc_why=""
  [ "$dry" = 1 ] && return 0
  "$venv/bin/python" -I -c 'import playwright' 2>/dev/null || return 0
  lc_why="$("$venv/bin/python" -I - "${1:-}" 2>&1 <<'PY'
import asyncio, sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        await (await p.chromium.launch(headless=True, **({"channel": sys.argv[1]} if sys.argv[1] else {}))).close()

try:
    asyncio.run(main())
except Exception as e:
    print(str(e).splitlines()[0][:300] if str(e) else type(e).__name__)
PY
)" || true
  lc_why="$(printf '%s\n' "$lc_why" | sed '/^[[:space:]]*$/d' | tail -n 1)"  # an exception's one line, or a traceback's last
  if [ -z "$lc_why" ]; then say "it starts"
  elif printf '%s' "$lc_why" | grep -qiE 'missing dependencies|install-deps'; then lc=nolibs; say "it lacks system libraries: $lc_why"
  else lc=failed; say "it did not start: $lc_why"; fi
}

fetch_bundled() {  # the headless Chromium each of thimble's Playwrights launches: the backend's (the card harness,
  # backend/app/render.py) and the frontend's (a view's checks and the screenshots, scripts/view_shot.mjs and ui_shot.mjs),
  # which pin different builds; one already in Playwright's cache is not fetched again. fetched: how many it downloaded;
  # fetch_failed=1 when a download failed
  local venv="$dir/backend/.venv" fe="$dir/frontend" loc what pw
  fetched=0 fetch_failed=0
  for what in backend frontend; do
    if [ "$what" = backend ]; then
      if [ "$dry" != 1 ] && ! "$venv/bin/python" -I -c 'import playwright' 2>/dev/null; then
        say "backend/.venv has no playwright, so the card harness has no browser to fetch"; continue
      fi
      pw=("$venv/bin/python" -I -m playwright)
    else
      [ -x "$fe/node_modules/.bin/playwright" ] || { [ "$dry" = 1 ] && [ "$node_ok" = 1 ]; } || continue
      pw=("$fe/node_modules/.bin/playwright")
    fi
    loc=""; [ "$dry" = 1 ] || loc="$(pw_location "${pw[@]}")"
    if [ -n "$loc" ] && [ -f "$loc/INSTALLATION_COMPLETE" ]; then
      say "the $what's headless Chromium is in $loc already: not fetched again"
    elif run "${pw[@]}" install chromium-headless-shell; then
      fetched=$((fetched + 1))
    else
      tail_out; fetch_failed=1
    fi
  done
}

browser_plan() {  # before the opening screen: the earlier answer (browser_was, and browser_how, where it came from) and,
  # without it or a flag, whether the Chrome or Edge found starts under automation (browser_auto=system: used without
  # asking, and not recorded); bundled_there=1 when the backend's headless Chromium is downloaded already
  local loc=""
  browser_was="$(browser_prev)" browser_auto="" sys_starts="" bundled_there=0
  browser_how="your earlier answer; --browser changes it"
  if [ -n "$browser_was" ] && [ "$(json_get "$home/config.json" browser 2>/dev/null)" != "$browser_was" ]; then
    browser_how="an earlier install downloaded it; --browser changes it"
  fi
  if earlier_install; then loc="$(pw_location "$dir/backend/.venv/bin/python" -I -m playwright)" || loc=""; fi
  [ -z "$loc" ] || [ ! -f "$loc/INSTALLATION_COMPLETE" ] || bundled_there=1
  system_browser
  if [ -z "$browser$browser_was" ] && [ -n "$sys_path" ]; then
    probe_browser
    [ "$sys_starts" = 0 ] || browser_auto=system
  fi
}
browser_pending() { [ -z "$browser$browser_was$browser_auto" ]; }
browser_found() {  # its line in the opening screen's Found
  local how="$browser_how"
  [ -z "$browser" ] || how="--browser $browser"
  case "${browser:-$browser_was}" in
    system) if [ -n "$sys_path" ]; then found ok "$sys_name at $(tilde "$sys_path") for screenshots ($how)"
            else found warn "Chrome or Edge for screenshots ($how), but neither is where Playwright looks, so no screenshots"; fi;;
    bundled) found ok "Playwright's headless Chromium for screenshots ($how)";;
    off) found ok "no browser, so no screenshots ($how)";;
    *) if [ "$browser_auto" = system ]; then found ok "$sys_name at $(tilde "$sys_path"): screenshots use it, so nothing is downloaded"
       elif [ -n "$sys_path" ]; then found warn "$sys_name at $(tilde "$sys_path") did not start under automation here, which a policy can block: a question below"
       else found warn "No Chrome or Edge for screenshots: a question below"; fi;;
  esac
}
browser_installs() {  # its row in the opening screen's Installs, when it downloads
  [ "${browser:-$browser_was}" = bundled ] || browser_pending || return 0
  if [ "$bundled_there" = 1 ]; then row "headless Chromium" "$(tilde "$(pw_cache)")" "downloaded already"
  else row "headless Chromium" "$(tilde "$(pw_cache)")" "$BUNDLED_SIZE$(browser_pending && echo ', only on a yes')"; fi
}
browser_title()  { echo "Download a browser for screenshots?"; }
browser_text() {
  local why="No Chrome or Edge was found."
  [ -z "$sys_path" ] || why="$sys_name at $(tilde "$sys_path") did not start under automation here, which a policy on this machine can block."
  echo "thimble takes screenshots of the cards and views it draws, to check how they look. $why Playwright's headless Chromium does the job: $BUNDLED_SIZE, in $(tilde "$(pw_cache)")."
  if [ -n "$sys_path" ]; then echo "With a no, thimble tries $sys_name anyway."; else echo "With a no, thimble works without screenshots."; fi
}
browser_prompt()  { echo "Download it?"; }
browser_default() { echo y; }
browser_choices() {
  echo "yes, download it: --browser bundled"
  [ -z "$sys_path" ] || echo "no, try $sys_name anyway: --browser system"
  echo "no screenshots: --browser off"
}
browser_need()   { echo "a browser for screenshots: --browser bundled$( [ -z "$sys_path" ] || echo ', --browser system') or --browser off"; }
browser_answer() { if [ "$1" = y ]; then browser=bundled; elif [ -n "$sys_path" ]; then browser=system; else browser=off; fi; }
browser_phase()  { echo deps; }
browser_step() {  # after the packages, since it launches the browser with thimble's Playwright: the answer's browser,
  # downloaded only when it is bundled; a new answer is recorded in config.json
  local choice="${browser:-${browser_was:-$browser_auto}}" fix="bash $(tilde "$dir")/scripts/install.sh --browser bundled"
  case "$choice" in
    system)
      if [ -z "$sys_path" ]; then
        warn "No screenshots: no Chrome or Edge is where Playwright looks for one"
        todo "for screenshots, install Chrome, or download Playwright's headless Chromium: $fix"
      else
        busy "Checking that $sys_name starts for screenshots"
        launch_check "$sys_channel"
        if [ -z "$lc" ]; then ok "Screenshots use $sys_name ($(tilde "$sys_path"))"
        else
          warn "$sys_name did not start under automation (${lc_why}), which a policy on this machine can block, so there are no screenshots"
          todo "for screenshots, download Playwright's headless Chromium: $fix"
        fi
      fi;;
    bundled)
      busy "Downloading Playwright's headless Chromium (about 210 MB)"
      fetch_bundled
      launch_check
      if [ "$fetch_failed" = 1 ]; then
        warn "Playwright's headless Chromium could not be downloaded (above), so there are no screenshots"
        todo "for screenshots, run this again when the download works: $fix"
      elif [ "$lc" = nolibs ]; then
        warn "Playwright's headless Chromium is downloaded, but this machine lacks the system libraries it needs, so there are no screenshots"
        todo "for screenshots, install those libraries: sudo $dir/backend/.venv/bin/python -m playwright install-deps chromium-headless-shell"
      elif [ "$lc" = failed ]; then
        warn "Playwright's headless Chromium did not start ($lc_why), so there are no screenshots"
      elif [ "$fetched" -gt 0 ]; then ok "Screenshots use Playwright's headless Chromium, downloaded to $(tilde "$(pw_cache)")"
      else ok "Screenshots use Playwright's headless Chromium, downloaded already ($(tilde "$(pw_cache)"))"; fi;;
    off)
      ok "No screenshots, as you chose: thimble can't check how its cards and views look (--browser bundled or --browser system turns them on)";;
    *)
      say "(the answer to the browser question, above)";;
  esac
  if [ -n "$browser" ] && [ "$browser" != "$browser_was" ]; then record_browser "$browser"; fi
}

# ----------------------------------------------------------------------- the sandbox question (Linux)
QUESTIONS+=(sandbox)
sandbox_deps=""  # --sandbox-deps (yes) or --no-sandbox-deps (no)
sandbox_flag() { case "$1" in --sandbox-deps) sandbox_deps=yes;; --no-sandbox-deps) sandbox_deps=no;; *) return 1;; esac; took=1; }

APPARMOR_USERNS=/proc/sys/kernel/apparmor_restrict_unprivileged_userns  # 1 (Ubuntu 23.10+): a user namespace needs an AppArmor profile

sandbox_runs() {  # Claude Code's Bash sandbox can run here: on Linux socat is on PATH and bwrap creates a sandbox
  local bw
  bw="$(command -v bwrap)" && command -v socat >/dev/null 2>&1 \
    && "$bw" --ro-bind / / --dev /dev --unshare-all --die-with-parent true >/dev/null 2>&1
}

sandbox_plan() {  # what Claude Code's Bash sandbox needs here: sb_ok=1 when it runs (macOS has it built in); else sb_need
  # names what it lacks, and sb_cmds holds the root commands that set it up (the sandbox question offers them), or
  # sb_why says why there are none
  sb_ok=0 sb_need="" sb_why="" sb_pm="" sb_cmds=()
  if [ "$(uname -s)" != Linux ] || sandbox_runs; then sb_ok=1; return 0; fi
  local pkgs=() bw sudo="" f profile=0
  command -v bwrap >/dev/null 2>&1 || pkgs+=(bubblewrap)
  command -v socat >/dev/null 2>&1 || pkgs+=(socat)
  bw="$(command -v bwrap || echo /usr/bin/bwrap)"
  if [ "$(cat "$APPARMOR_USERNS" 2>/dev/null)" = 1 ]; then
    profile=1
    for f in /etc/apparmor.d/*; do
      if [ -f "$f" ] && grep -qF "$bw" "$f" && grep -q userns "$f"; then profile=0; break; fi
    done
  fi
  [ "${#pkgs[@]}" = 0 ] || sb_need="${pkgs[*]}"
  sb_need="${sb_need/ / and }"
  [ "$profile" = 0 ] || sb_need="${sb_need:+$sb_need, and }an AppArmor profile that lets bwrap create user namespaces (/etc/apparmor.d/bwrap)"
  if [ -z "$sb_need" ]; then
    sb_need="user namespaces for bwrap"
    sb_why="bwrap is installed but can't create a sandbox here (user namespaces may be turned off, as in some containers)"
    return 0
  fi
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || { sb_why="setting up $sb_need needs root: ask an administrator"; return 0; }
    sudo="sudo "
  fi
  if [ "${#pkgs[@]}" -gt 0 ]; then
    for sb_pm in apt-get dnf pacman zypper apk ""; do [ -z "$sb_pm" ] || ! command -v "$sb_pm" >/dev/null 2>&1 || break; done
    case "$sb_pm" in
      apt-get | dnf) sb_cmds+=("${sudo}$sb_pm install -y ${pkgs[*]}");;
      pacman) sb_cmds+=("${sudo}pacman -S --needed --noconfirm ${pkgs[*]}");;
      zypper) sb_cmds+=("${sudo}zypper --non-interactive install ${pkgs[*]}");;
      apk) sb_cmds+=("${sudo}apk add ${pkgs[*]}");;
      *) sb_why="install ${pkgs[*]} with this system's package manager"; return 0;;
    esac
  fi
  if [ "$profile" = 1 ]; then
    sb_cmds+=("printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap $bw flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n' | ${sudo}tee /etc/apparmor.d/bwrap >/dev/null"
              "${sudo}apparmor_parser -r /etc/apparmor.d/bwrap")
  fi
}
SANDBOX_WHY="thimble's agents run their shell commands in Claude Code's sandbox, so they can read only the folder you open with thimble and write only their workspace."
sandbox_later() {  # what a sandbox that can't run means, and how to set it up later, for the list at the end
  if [ "${#sb_cmds[@]}" -gt 0 ]; then
    todo "set up Claude Code's sandbox, without which thimble's agents won't start: bash $(tilde "$dir")/scripts/install.sh --sandbox-deps"
  else
    todo "make Claude Code's sandbox run ($sb_why); thimble's agents won't start until it does, and \`thimble doctor\` shows when it does"
  fi
}
sandbox_pending() { [ "${#sb_cmds[@]}" -gt 0 ] && [ -z "$sandbox_deps" ]; }
sandbox_found() {
  if [ "$sb_ok" = 1 ]; then
    if [ "$(uname -s)" = Linux ]; then found ok "Claude Code's sandbox runs here"; else found ok "Claude Code's sandbox, built into macOS"; fi
  elif [ "${#sb_cmds[@]}" = 0 ]; then found warn "Claude Code's sandbox can't run here: $sb_why. thimble's agents won't start until it does"
  elif [ "$sandbox_deps" = yes ]; then found warn "Claude Code's sandbox needs $sb_need, which install.sh installs with sudo (--sandbox-deps)"
  elif [ "$sandbox_deps" = no ]; then found warn "Claude Code's sandbox needs $sb_need, left out (--no-sandbox-deps): thimble's agents won't start until it runs"
  else found warn "Claude Code's sandbox needs $sb_need: a question below"; fi
}
sandbox_title()   { echo "Install what Claude Code's sandbox needs?"; }
sandbox_text() {
  echo "$SANDBOX_WHY Here it needs $sb_need, which these commands install:"
  printf '  %s\n' "${sb_cmds[@]}"
  echo "With a no, thimble's agents won't start until the sandbox works."
}
sandbox_prompt()  { echo "Install them now?"; }
sandbox_default() { echo y; }
sandbox_choices() { echo "yes: --sandbox-deps"; echo "no: --no-sandbox-deps"; }
sandbox_need()    { echo "what Claude Code's sandbox needs: --sandbox-deps or --no-sandbox-deps"; }
sandbox_answer()  { if [ "$1" = y ]; then sandbox_deps=yes; else sandbox_deps=no; fi; }
sandbox_phase()   { echo first; }
sandbox_step() {  # right after the questions, so that sudo asks for its password while the user is at the terminal:
  # sandbox_plan's root commands on a yes, then whether the sandbox runs
  local c upd
  if [ "$sb_ok" = 1 ]; then say "Claude Code's Bash sandbox runs here: nothing to install"; return 0; fi
  if [ "${#sb_cmds[@]}" = 0 ]; then
    warn "Claude Code's sandbox can't run here: $sb_why"
    sandbox_later; return 0
  fi
  if [ "$sandbox_deps" != yes ]; then
    if [ "$dry" = 1 ] && [ -z "$sandbox_deps" ]; then say "(the answer to the sandbox question, above)"; return 0; fi
    warn "Claude Code's sandbox lacks $sb_need, left out as you chose: thimble's agents won't start until the sandbox works"
    sandbox_later; return 0
  fi
  if [ "$dry" = 0 ] && [ "$tty" = 0 ] && [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then
    warn "Claude Code's sandbox lacks $sb_need, and sudo needs your password, which install.sh can't ask for without a terminal. Run these in a terminal, then \`thimble doctor\`:"
    printf '    %s\n' "${sb_cmds[@]}" | while IFS= read -r l; do show "$l"; done
    sandbox_later; return 0
  fi
  [ "$dry" = 1 ] || show "… installing $sb_need with sudo, which may ask for your password"
  for c in "${sb_cmds[@]}"; do
    say "+ $c"
    [ "$dry" = 0 ] || continue
    _run "(running it)" bash -c "$c" && continue
    if [ "$sb_pm" = apt-get ] && [ "$c" = "${sb_cmds[0]}" ]; then  # the package lists may predate the packages
      upd="${c%%apt-get install*}apt-get update"
      say "+ $upd"
      if _run "(running it)" bash -c "$upd" && say "+ $c" && _run "(running it)" bash -c "$c"; then continue; fi
    fi
    tail_out
    say "(that failed, above)"
    break
  done
  [ "$dry" = 0 ] || return 0
  if sandbox_runs; then ok "Claude Code's sandbox runs now"
  else warn "Claude Code's sandbox still doesn't run (above)"; sandbox_later; fi
}

# -------------------------------------------------------------- the `thimble` command and the plugin
write_pointer() {  # $THIMBLE_HOME/app-dir: how the plugin copy in Claude Code's plugin cache finds this tree (plugin/bin/thimble-app-dir)
  run mkdir -p "$home"
  run chmod 700 "$home"
  say "+ printf '%s\\n' $dir > $home/app-dir"
  [ "$dry" = 1 ] || printf '%s\n' "$dir" > "$home/app-dir"
}

link_cli() {  # ~/.local/bin/thimble → <tree>/plugin/bin/thimble, so `thimble` is a command once that folder is on PATH (finish
  # says whether it is). What cli_plan found there decides: a link into another install stays unless a yes switched it,
  # and anything else that is not a link into a thimble tree (another program) is left alone
  local target="$dir/plugin/bin/thimble"
  cli_linked=0
  case "$cli_state" in
    foreign)
      warn "$(tilde "$cli_link") is another program, left alone: thimble's command is $(tilde "$target")"
      return 0;;
    other)
      if [ "$cli_switch" != yes ]; then warn "$(cli_switch_line)"; return 0; fi;;
    gone) say "$cli_link was a link into $cli_other, which is gone; it now runs this install";;
  esac
  # the link is a convenience: when ~/.local/bin cannot be written the install still succeeds, and the command stays in the tree
  if ! { run mkdir -p "$bin_dir" && run ln -sfn "$target" "$cli_link"; }; then
    warn "could not create $(tilde "$cli_link"): thimble's command is $(tilde "$target")"
    return 0
  fi
  cli_linked=1
  ok "The thimble command: $(tilde "$cli_link")"
}

marketplace_name() {  # mp_name: the name Claude Code registers the tree under — --marketplace-name, except in a checkout
  # installed in place, whose tracked .claude-plugin/marketplace.json keeps its own; mp_file_name: the name in that file
  mp_file_name="$(json_get "$src/.claude-plugin/marketplace.json" name)"
  if [ -n "$mp_name" ] && [ "$mp_name" != "$mp_file_name" ] && [ "$in_place" = 1 ] && [ "$checkout" = 1 ]; then
    say "--marketplace-name $mp_name ignored: $src/.claude-plugin/marketplace.json is a tracked file of this checkout; its name \"$mp_file_name\" is used"
    mp_name=""
  fi
  mp_name="${mp_name:-$mp_file_name}"
}

cli_plan() {  # what ~/.local/bin/thimble is now (cli_state): new (nothing there), ours (a link to this install's command),
  # gone (a link into a thimble tree that is no longer there), other (a link into another thimble install, cli_other) or
  # foreign (anything else). It is replaced when new, ours or gone, and when other only on a yes asked on a terminal
  cli_link="$bin_dir/thimble" cli_other="" cli_switch=""
  local target="$dir/plugin/bin/thimble" existing=""
  [ ! -L "$cli_link" ] || existing="$(readlink "$cli_link")"
  if [ ! -e "$cli_link" ] && [ ! -L "$cli_link" ]; then cli_state=new
  elif [ -z "$existing" ]; then cli_state=foreign
  elif [ "$existing" = "$target" ] || [ "$cli_link" -ef "$target" ]; then cli_state=ours
  else
    case "$existing" in
      */plugin/bin/thimble)
        case "$existing" in /*) cli_other="${existing%/plugin/bin/thimble}";; *) cli_other="$bin_dir/${existing%/plugin/bin/thimble}";; esac
        if [ -e "$cli_link" ]; then cli_state=other; else cli_state=gone; fi;;
      *) cli_state=foreign;;
    esac
  fi
}

cli_switch_line() {  # the line saying ~/.local/bin/thimble runs another install, with the command that would switch it
  printf '%s\n' "$(tilde "$cli_link") runs the thimble install in $cli_other, so it is left as it is. To make \`thimble\` run this install: ln -sfn $(printf '%q' "$dir/plugin/bin/thimble") $(printf '%q' "$cli_link")"
}

register_plugin() {  # thimble in every Claude Code session (scripts/plugin.sh): only --plugin, --no-plugin or an earlier
  # yes changes anything; without them Claude Code's plugins are left as they are
  local answer="${plugin:-$plugin_prev}" mp_file="$dir/.claude-plugin/marketplace.json"
  if [ "$mp_name" != "$mp_file_name" ]; then
    say "+ set .name = \"$mp_name\" in $mp_file"
    [ "$dry" = 1 ] || python3 -I -c 'import json,sys; p,n=sys.argv[1:]; d=json.load(open(p)); d["name"]=n; json.dump(d, open(p,"w"), indent=2); open(p,"a").write("\n")' "$mp_file" "$mp_name"
  fi
  [ -z "$plugin" ] || [ "$plugin" = "$plugin_prev" ] || say "--$( [ "$plugin" = yes ] || echo 'no-' )plugin: changing thimble's place in every Claude Code session"
  plugin_apply "$answer" || todo "thimble is not in every Claude Code session as asked: once the above is fixed, run install.sh again with --plugin"
}

# ---------------------------------------------------------------------------- the opening screen
found() { local m="$1"; shift; local sym="✓" col="$c_ok"; [ "$m" = ok ] || { sym="!"; col="$c_warn"; }
  clear_busy; printf '%s\n' "$*" | folded 4 | sed "1s/^    /  $col$sym$c_off /"; printf '  %s %s\n' "$sym" "$*" >&4; }
row() {  # row WHAT WHERE [SIZE]: a line of Installs, WHERE (SIZE) folded under itself on a terminal
  local head rest first l
  head="$(printf '  %-21s ' "$1")" rest="$2"
  [ -z "${3:-}" ] || rest="$rest ($3)"
  clear_busy
  if [ "$wrap" = 1 ]; then
    printf '%s\n' "$rest" | fold -s -w $((cols - ${#head})) | sed 's/ *$//' | {
      IFS= read -r first; printf '%s%s\n' "$head" "$first"
      while IFS= read -r l; do printf '%*s%s\n' "${#head}" '' "$l"; done; }
  else printf '%s%s\n' "$head" "$rest"; fi
  printf '%s%s\n' "$head" "$rest" >&4
}
size_of() { du -sk "$1" 2>/dev/null | awk '{ printf "about %d MB", ($1 + 1023) / 1024 }'; }
PY_SIZE="about 650 MB"           # backend/.venv from uv.lock, measured
NODE_SIZE="about 300 MB"         # a checkout's frontend/node_modules (npm ci), measured
NODE_RUNTIME_SIZE="about 70 MB"  # a release's frontend/runtime packages, measured

plan() {  # what each question, the plugin and the link find, before the opening screen
  local q
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do "${q}_plan"; done
  plugin_prev="" plugin_reg="" plugin_kept="" plugin_switch="" other_reg="" other_from="" mod_in="" plugin_known=1
  cli_state="" cli_other="" cli_switch=""
  [ "$deps_only" = 1 ] || { plugin_record; cli_plan; }
}

opening() {  # the one screen before the questions: what install.sh found, what it installs where, what it changes in
  # Claude Code's setup, and how many questions remain
  local q n=0 venv="$dir/backend/.venv" fe="$dir/frontend/node_modules" what
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if "${q}_pending"; then n=$((n + 1)); fi; done
  if [ "$checkout" = 1 ]; then what="Dev install: this checkout, in place"; else what="Global install"; fi
  heading "thimble $version installer · $what$( [ "$dry" = 1 ] && echo ' · dry run, nothing is changed')"
  show ""
  heading_q "Found"
  found "$found_claude" "$found_claude_text"
  found "$found_py" "$found_py_text"
  found "$found_node" "$found_node_text"
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if declare -F "${q}_found" >/dev/null; then "${q}_found"; fi; done
  show ""
  heading_q "Installs"
  if [ "$in_place" = 1 ]; then row "thimble $version" "$(tilde "$dir")" "in place"
  else row "thimble $version" "$(tilde "$dir")" "$(size_of "$src")"; fi
  if [ -n "$byo" ]; then row "Python packages" "your environment $(tilde "$byo_prefix")" "nothing installed into it"
  elif [ -e "$venv" ]; then row "Python packages" "$(tilde "$venv")" "there already; updated if needed"
  else row "Python packages" "$(tilde "$venv")" "$PY_SIZE"; fi
  if [ "$node_ok" = 1 ]; then
    if [ -e "$fe" ]; then row "Node packages" "$(tilde "$fe")" "there already; updated if needed"
    elif [ "$checkout" = 0 ] && [ "$has_dist" = 1 ]; then row "Node packages" "$(tilde "$fe")" "$NODE_RUNTIME_SIZE"
    else row "Node packages" "$(tilde "$fe")" "$NODE_SIZE"; fi
    if [ "$has_dist" = 0 ]; then row "web interface" "$(tilde "$dir/frontend/dist")" "built here"
    elif [ -n "$stale" ]; then row "web interface" "$(tilde "$dir/frontend/dist")" "rebuilt: its sources changed"; fi
  fi
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if declare -F "${q}_installs" >/dev/null; then "${q}_installs"; fi; done
  if [ "$deps_only" = 0 ]; then
    case "$cli_state" in
      other) row "thimble command" "$(tilde "$cli_link")" "runs another install now, $cli_other; $(asks && echo 'asks before switching it' || echo 'left as it is')";;
      foreign) row "thimble command" "$(tilde "$dir/plugin/bin/thimble")" "$(tilde "$cli_link") is another program, left alone";;
      *) row "thimble command" "$(tilde "$cli_link")";;
    esac
  fi
  row "settings and logs" "$(tilde "$home")"
  if [ "$deps_only" = 0 ]; then
    show ""
    heading_q "Your Claude Code setup"
    plugin_setup
    for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if declare -F "${q}_setup" >/dev/null; then "${q}_setup"; fi; done
    [ -z "$trust_ignored" ] || found ok "$trust_ignored is ignored: thimble's agents no longer need a folder Claude Code trusts"
  fi
  show ""
  if [ "$n" = 0 ]; then show "Questions: none."
  elif [ "$dry" = 1 ]; then show "Questions: $n, listed below."
  else show "Questions: $n, next."; fi
}

plugin_setup() {  # the plugin's line in "Your Claude Code setup"
  local answer="${plugin:-$plugin_prev}"
  if [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    found ok "thimble from another install is in every Claude Code session (thimble@$other_reg, from $(tilde "$other_from")); left as it is$( [ "$answer" = yes ] && asks && echo ', unless you agree below to switch it')"
  elif [ "$plugin" = yes ]; then found ok "thimble is added to every Claude Code session (--plugin)"
  elif [ "$plugin" = no ] && [ -n "$plugin_reg$plugin_kept" ]; then found ok "thimble is taken out of your other Claude Code sessions (--no-plugin)"
  elif [ "$answer" = yes ]; then found ok "thimble stays in every Claude Code session (your earlier choice; thimble plugin off takes it out)"
  else found ok "thimble is not added to your other Claude Code sessions: the thimble command loads it into the sessions it starts"; fi
}

# --------------------------------------------------------------------------------------- questions
asks() { [ "$dry" = 0 ] && [ -t 0 ]; }  # questions are asked on a terminal

yes_no() {  # yes_no DEFAULT: read an answer from the terminal; 0 for yes, DEFAULT (y or n) for an empty one
  local ans; read -r ans || ans=""
  printf '%s\n' "${ans:-(Enter)}" >&4
  case "${ans:-$1}" in y | Y | yes | YES | Yes) return 0;; *) return 1;; esac
}

prompt() {  # prompt TEXT DEFAULT: TEXT with [Y/n] or [y/N], on the terminal, then the answer (yes_no)
  local opts="[y/N]"; [ "$2" = y ] && opts="[Y/n]"
  clear_busy
  printf '%s %s ' "$1" "$opts"; printf '%s %s ' "$1" "$opts" >&4
  yes_no "$2"
}

ask() {  # the questions that remain, before anything is installed (QUESTIONS, each NAME_pending). --dry-run lists them
  # with their flags; on a terminal each is asked; without one install.sh stops while one has no flag. Then, on a
  # terminal only, whether to switch another install's plugin or command to this one
  local q pending=() need=() i=0 n again
  tty=0
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if "${q}_pending"; then pending+=("$q"); fi; done
  n="${#pending[@]}"
  if [ "$dry" = 1 ]; then
    if [ "$n" = 0 ]; then
      showf "Nothing to ask: install with  bash $(tilde "$src")/scripts/install.sh"
    else
      showf "(An agent installing thimble for someone asks them each question below, in its words, and passes the flag of their answer; it answers none itself.)"
      for q in "${pending[@]}"; do
        i=$((i + 1))
        show ""
        show "$i. $("${q}_title")"
        "${q}_text" | folded 3 | while IFS= read -r l; do show "$l"; done
        "${q}_choices" | sed 's/^/   - /' | while IFS= read -r l; do show "$l"; done
      done
      show ""
      showf "Then install with  bash $(tilde "$src")/scripts/install.sh  and one flag per answer."
    fi
    [ "$cli_state" != other ] || showf "Not asked here, only on a terminal: $(cli_switch_line)"
    return 0
  fi
  [ -t 0 ] && tty=1
  if [ "$tty" = 0 ]; then
    [ "$n" -gt 0 ] || return 0
    for q in "${pending[@]}"; do need+=("$("${q}_need")"); done
    again="bash $src/scripts/install.sh --dry-run prints the questions; ask them (an agent asks the person it installs for, and answers none itself), then run install.sh again with a flag for each."
    if [ "$src" != "$dir" ] && earlier_install; then
      again="Ask them, then run \`thimble update\` again with a flag for each, which it passes on to install.sh. An install older than 0.3.0 has a \`thimble update\` that takes no flags: unzip the release and run its scripts/install.sh --dir $dir with the flags."
    fi
    die "there is no terminal to ask on, so each question that remains needs its answer as a flag. Not answered:
$(printf '  %s\n' "${need[@]}")
$again"
  fi
  for q in ${pending[@]+"${pending[@]}"}; do
    i=$((i + 1))
    show ""
    heading_q "Question $i of $n: $("${q}_title")"
    "${q}_text" | folded 2 | while IFS= read -r l; do show "$l"; done
    if prompt "$("${q}_prompt")" "$("${q}_default")"; then "${q}_answer" y; else "${q}_answer" n; fi
  done
  [ "$deps_only" = 0 ] || return 0
  if [ "${plugin:-$plugin_prev}" = yes ] && [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    show ""
    if prompt "$(other_plugin) Switch it to this install?" n; then plugin_switch=yes; fi
  fi
  if [ "$cli_state" = other ]; then
    show ""
    if prompt "$(tilde "$cli_link") runs the thimble install in $cli_other. Make \`thimble\` run this install instead?" n; then cli_switch=yes; fi
  fi
}
heading_q() { clear_busy; printf '%s%s%s\n' "$c_head" "$*" "$c_off"; printf '%s\n' "$*" >&4; }

run_steps() {  # run_steps PHASE: the step of each question that runs then (NAME_phase)
  local q
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if [ "$("${q}_phase")" = "$1" ]; then "${q}_step"; fi; done
}

path_has_local_bin() {  # $HOME/.local/bin (or ~/.local/bin) as a PATH entry, a trailing slash on the entry allowed
  case ":$(printf '%s' "$PATH" | sed 's#/*:#:#g; s#/*$##'):" in *":$bin_dir:"* | *":~/.local/bin:"*) return 0;; esac; return 1
}

doctor_check() {  # thimble doctor, its report in the log; the line names what it found wrong with Claude Code's login
  local auth net rc=0
  busy "Checking the install with thimble doctor"
  run "$dir/plugin/bin/thimble" doctor || rc=$?
  [ "$dry" = 0 ] || return 0
  auth="$(sed -n 's/^  auth: //p' "$tmp/out" | head -n 1)"
  net="$(sed -n 's/^  network: //p' "$tmp/out" | head -n 1)"
  if [ "$rc" != 0 ]; then warn "thimble doctor failed (exit $rc); its output is in $(tilde "$log_file")"
  elif [ "${auth#not logged in}" != "$auth" ]; then
    warn "Checked with thimble doctor: Claude Code is not logged in, and nothing that calls a model runs until it is"
    todo "log in to Claude Code: run claude"
  elif [ -n "$net" ] && [ "${net%answers}" = "$net" ] && [ "${net#not checked}" = "$net" ]; then
    warn "Checked with thimble doctor: the Claude API does not answer from here ($net)"
  else ok "Checked with thimble doctor$( [ "${auth#logged in}" != "$auth" ] && echo ': Claude Code is logged in') (thimble doctor shows its full report)"; fi
}

finish() {  # doctor, then what is left for the user (PATH, THIMBLE_HOME, the todo list) and the one next step
  local cmd rc pid repo
  cmd="$(tilde "$dir/plugin/bin/thimble")"
  doctor_check
  # a server started from another tree keeps running that tree's code until it is restarted
  if [ "$dry" = 0 ] && [ -f "$home/server.json" ]; then
    pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$home/server.json" | head -n 1)"
    repo="$(json_get "$home/server.json" repo)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -n "$repo" ] && [ "$repo" != "$dir" ]; then
      todo "the thimble server (pid $pid) still runs the install in $repo: restart it with  thimble server restart"
    fi
  fi
  case "${SHELL:-}" in */zsh) rc='~/.zshrc';; */bash) rc='~/.bashrc';; *) rc="your shell's startup file";; esac
  if [ "$cli_linked" = 1 ]; then
    if path_has_local_bin; then cmd=thimble
    else todo "put $(tilde "$bin_dir") on your PATH, so that typing thimble works: add this line to $rc and open a new terminal:
  export PATH=\"${bin_dir/#$HOME/\$HOME}:\$PATH\""; fi
  fi
  if [ "$custom_home" = 1 ]; then
    todo "keep THIMBLE_HOME set wherever thimble or Claude Code runs, since it is not the default ~/.thimble: add this line to $rc:
  export THIMBLE_HOME=$(printf '%q' "$home")"
  fi
  [ "$dry" = 0 ] || return 0
  heading "Done: thimble $version is installed in $(tilde "$dir")"
  print_todo
  showf "Next: run $cmd in a folder of transcripts. It starts Claude Code with thimble and prints the dashboard's address."
  showf "Optional: \`thimble cc-mod on\` turns on thimble-cc-mod, a single-agent thimble inside Claude Code, in one folder."
}

print_todo() {  # what is left for the user to do, one item each (todo)
  local t
  [ "${#todo[@]}" -gt 0 ] || return 0
  show "Left for you to do:"
  for t in "${todo[@]}"; do
    clear_busy
    printf '%s\n' "$t" | folded 4 | sed '1s/^    /  - /'
    printf '%s\n' "$t" | sed -e '1s/^/  - /' -e '2,$s/^/    /' >&4
  done
}

main() {
  exec 4>/dev/null
  parse_args "$@"
  init_term
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  : > "$tmp/out"
  keep_log
  # shellcheck source=scripts/plugin.sh
  . "$src/scripts/plugin.sh"
  locate_tree
  marketplace_name
  check_prerequisites
  plan
  opening
  ask
  if [ "$dry" = 1 ] && [ "$verbose" = 0 ]; then exit 0; fi
  [ "$dry" = 1 ] && say "(dry run: every step's commands follow; none of them runs)"
  heading "Installing"
  run_steps first
  copy_tree
  make_venv
  build_ui
  run_steps deps
  if [ "$deps_only" = 1 ]; then heading "--deps-only: done"; [ "$dry" = 1 ] || print_todo; exit 0; fi
  write_pointer
  link_cli
  register_plugin
  run_steps last
  finish
}
main "$@"
