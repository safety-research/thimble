#!/usr/bin/env bash
# scripts/install.sh — install thimble: a git clone, which thimble runs from (a Dev install), or an unzipped release,
# copied into ~/.thimble/app (a Global install).
#
#   scripts/install.sh [--dry-run] [--verbose] [--browser bundled|system|off] [--dir DIR] [--dev]
#                      [--python PATH] [--deps-only] [--require-pinned] [--marketplace-name NAME]
#
# It opens with one screen: what it found (Claude Code, Python or uv, Node, a browser, and on Linux whether card code and
# the terminal's views can run in bubblewrap), what it installs where and about how big, what it changes in your Claude
# Code setup, and whether a question remains. It asks it, then prints a line per step, and ends with what to run next.
# A re-run with nothing to do says so in one line, and one that changes something shows only what changed.
# Every command it runs, with its output, goes to $THIMBLE_HOME/install.log (~/.thimble/install.log).
#
# It adds thimble's plugin to Claude Code with Claude Code's own commands: claude plugin marketplace add <the install
# folder>, then claude plugin install --scope user thimble@<marketplace>, so thimble is on in every claude session. A
# re-run updates the plugin when its version or its files changed. It writes no shell startup file: when ~/.local/bin is
# not on PATH, or THIMBLE_HOME is not ~/.thimble, it prints the line a new terminal needs. It installs no system package
# and never runs sudo.
#
# The question, asked only when it remains, and the flag that answers it without asking:
#   --browser bundled|system|off   a browser for screenshots, asked only when no Chrome or Edge that starts under
#                          automation is found where Playwright looks (one that does is used, and nothing is downloaded).
#                          bundled downloads Playwright's headless Chromium (about 210 MB to download, 650 MB on disk);
#                          system uses the Chrome or Edge found anyway; off takes no screenshots
# The answer is kept in $THIMBLE_HOME, so a re-run or `thimble update` doesn't ask it again; its flag changes it. Without a
# terminal install.sh stops while the question remains without its flag, and says so.
#
#   --dry-run              print the opening screen and the question if it remains, with its flags; change nothing.
#                          An agent installing thimble for someone asks exactly that question (CLAUDE.md, Installing).
#                          `thimble update --dry-run` runs it too (scripts/update.sh, which sets THIMBLE_INSTALL_VIA)
#   --verbose              also print each command it runs and its output; with --dry-run, every step's commands
#   --no-plugin            for thimble's own release tests only: add nothing to Claude Code (no marketplace, no
#                          plugin). An install adds the plugin the way claude plugin install does; turn it off with /plugin
#   --dir DIR              where the tree goes (default: this clone itself; $THIMBLE_HOME/app for a release)
#   --dev                  also install the backend's test extras (a checkout always gets them)
#   --python PATH          use the virtual environment of the python at PATH as backend/.venv: install.sh checks that it
#                          holds what backend/pyproject.toml asks for and installs nothing into it
#   --deps-only            stop after the browser: no `thimble` command, plugin or doctor
#   --require-pinned       install only pinned versions: stop where the package index lacks one, and where nothing pins
#                          them (a Dev install without uv or without backend/uv.lock)
#   --marketplace-name N   the name Claude Code registers the tree under (default: .claude-plugin/marketplace.json's)
#   --sandbox-deps, --no-sandbox-deps, --plugin, --modify-path and --no-modify-path are accepted and ignored (0.7's)
# THIMBLE_BIN_DIR, when set, is the folder the `thimble` link goes into in place of ~/.local/bin.
set -euo pipefail
# How it works (not printed by --help).
# Steps: what it finds (check_prerequisites) and plans (plan: the question's plan, the plugin, the link, the lines a new
# terminal needs) · the opening screen · the question · copy the release into --dir, and commit it as the install's git
# baseline (git_baseline), so code tickets run in a release install too · backend/.venv · the frontend's
# packages and frontend/dist · the browser · the app-dir pointer and `thimble` on PATH (~/.local/bin/thimble → the
# tree's plugin/bin/thimble) · the plugin, unless --no-plugin (scripts/plugin.sh) · doctor · what to run next, with the
# line for a shell startup file when a new terminal needs one. Nothing is left in a list for the user: a step that needs
# them says so with a ! line and what fixes it under it.
# Each question is one block of functions named after it, which adds its name to QUESTIONS; the rest of the script
# reaches a question only through those functions, so deleting its block removes it.
# The browser answer is kept in $THIMBLE_HOME (config.json's "browser"). A Chrome or Edge used because it was found and
# started is not recorded: the server picks it too when config.json names no browser (backend/app/userconf.py browser),
# and a later run asks only if it stops working.
# Another install's plugin registration (a marketplace added from another folder, or from GitHub) is never changed:
# install.sh names it and prints the commands that switch it. A ~/.local/bin/thimble linked into another install is
# changed only on a yes, asked on a terminal.
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
# The terminal gets the opening screen, the questions, and a line per step: ✓ when it is done, ! when it needs you,
# with what fixes it on the lines under it (show, ok, warn, note). A step that finds nothing to do says so with same,
# which a quiet re-run (nothing_planned) leaves to the log; changed and warned record whether a step did something or
# needs you, for the last lines. The details (say), each command run (run, run_in)
# and its output go to fd 4, the log ($home/install.log, opened by keep_log; /dev/null in a dry run), and to the
# terminal too with --verbose. A command's output is also kept in $tmp/out, whose tail tail_out shows when the command
# failed. On a terminal, busy shows what a long step is doing until its line replaces it.
verbose=0 dry=0 busy_on=0 log_file="" wrap=0 cols=100 c_ok="" c_warn="" c_head="" c_off=""
quiet=0 quiet_title="" changed=0 warned=0
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
mark()    { # mark ok|same|warn TEXT: TEXT after ✓ or !, folded at the terminal's width with its later lines indented
  local sym="✓" col="$c_ok"
  case "$1" in ok) changed=1;; warn) sym="!"; col="$c_warn"; warned=1;; esac
  clear_busy; title_once
  printf '%s\n' "$2" | folded 2 | sed "1s/^  /$col$sym$c_off /"
  printf '%s %s\n' "$sym" "$2" >&4
}
title_once() {  # a quiet re-run's title, before the first line it shows
  [ -n "$quiet_title" ] || return 0
  local t="$quiet_title"; quiet_title=""
  heading "$t"
}
ok()      { if [ "$dry" = 1 ]; then say "(dry run: would print) ✓ $*"; else mark ok "$*"; fi; }
same()    { if [ "$dry" = 1 ]; then say "(dry run: would print) ✓ $*"; elif [ "$quiet" = 1 ]; then say "✓ $*"; else mark same "$*"; fi; }
warn()    { if [ "$dry" = 1 ]; then say "(dry run: would print) ! $*"; else mark warn "$*"; fi; }
note()    { if [ "$dry" = 1 ]; then say "(dry run: would print)   $*"; else clear_busy; title_once; printf '%s\n' "$*" | folded 2; printf '  %s\n' "$*" >&4; fi; }
say()     { printf '%s\n' "$*" >&4; if [ "$verbose" = 1 ]; then clear_busy; printf '%s\n' "$*"; fi; }
busy()    { say "… $*"; if [ "$verbose" = 0 ] && [ "$wrap" = 1 ] && [ "$dry" = 0 ]; then clear_busy; printf '… %s' "$*"; busy_on=1; fi; }
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
arg_path() { case "$1" in "$HOME"/*) printf '~/%q\n' "${1#"$HOME"/}";; *) printf '%q\n' "$1";; esac; }  # a path as a command's word, ~/… under $HOME
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
  clear_busy; title_once
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
  dir="" mp_name="" dev=0 deps_only=0 plugin="" byo="" require_pinned=0 ignored=()
  local q
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2;;
      --marketplace-name) mp_name="$2"; shift 2;;
      --dev) dev=1; shift;;
      --python) byo="$2"; shift 2;;
      --deps-only) deps_only=1; shift;;
      --require-pinned) require_pinned=1; shift;;
      --no-plugin) plugin=no; shift;;
      # 0.7's sandbox question, plugin question and startup-file lines, gone; opening() names them in one line
      --plugin | --sandbox-deps | --no-sandbox-deps | --modify-path | --no-modify-path)
        case " ${ignored[*]+"${ignored[*]}"} " in *" $1 "*) ;; *) ignored+=("$1");; esac; shift;;
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
  # a release install is a git repository too (git_baseline) and carries RELEASE.json; a clone carries none
  checkout=0; [ -e "$src/.git" ] && [ ! -f "$src/RELEASE.json" ] && checkout=1
  if [ "$checkout" = 1 ]; then dev=1; fi  # a Dev install gets the backend's test extras
  if [ -z "$dir" ]; then if [ "$checkout" = 1 ]; then dir="$src"; else dir="$home/app"; fi; fi
  in_place=0
  if [ -d "$dir" ] && [ "$(cd "$dir" && pwd -P)" = "$src" ]; then in_place=1; dir="$src"; fi  # the resolved spelling, however --dir wrote it
  # copying a release over a clone would mix the release's files into the clone's tracked ones
  if [ "$in_place" = 0 ] && [ -e "$dir/.git" ] && [ ! -f "$dir/RELEASE.json" ]; then
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

# A Mac with Apple silicon gets a native arm64 Python, with packages from wheels alone: an Intel Python (which a shell
# under Rosetta, such as an Intel build of iTerm, finds first) gets no wheel for some of thimble's packages, so pip or uv
# would build them from source, which needs Xcode and its license. uv fetches a native Python where none is installed.
apple_silicon=0 rosetta=0 uv_python="" uv_nobuild=() pip_nobuild=()
mac_arch() {  # apple_silicon=1 on a Mac with Apple silicon, rosetta=1 when this shell runs under Rosetta there; then
  # uv_python, the Python uv makes an environment with, is a native one, and nothing is built from source
  uv_python=">=$req_py"
  [ "$(uname -s)" = Darwin ] || return 0
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then rosetta=1; fi
  if [ "$rosetta" = 1 ] || [ "$(uname -m)" = arm64 ]; then apple_silicon=1; fi
  if [ "$apple_silicon" = 1 ]; then
    uv_python="cpython-$req_py-macos-aarch64-none" uv_nobuild=(--no-build) pip_nobuild=(--only-binary=:all:)
    say "Apple silicon$( [ "$rosetta" = 0 ] || echo ', this shell under Rosetta'): a native arm64 Python ($uv_python for uv), and packages from wheels alone"
  fi
}

py_native() {  # py_native PYTHON: it runs as arm64 here (an Intel Python reports x86_64)
  [ "$(cd / && "$1" -I -c 'import platform; print(platform.machine())' 2>/dev/null)" = arm64 ]
}

wheels_only() {  # the words a failed install of Python packages adds on Apple silicon, where nothing is built from source
  [ "$apple_silicon" = 0 ] || printf '%s' ". On a Mac with Apple silicon install.sh installs prebuilt wheels alone, never a build from source, which needs Xcode"
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
    venv_ours "$dir/backend/.venv" \
      || die "$dir/backend/.venv is an environment install.sh did not make, so it leaves it as it is; to use $byo_prefix in its place, delete it (rm -rf $dir/backend/.venv) and run this again"
    say "backend/.venv is the environment install.sh made: the link to $byo_prefix replaces it"
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
  have_uv=0 py="" pytool=pip intel_py=""
  ! command -v uv >/dev/null 2>&1 || have_uv=1
  mac_arch
  for cand in python3 python3.14 python3.13 python3.12; do
    if command -v "$cand" >/dev/null 2>&1 && py_ok "$cand"; then
      if [ "$apple_silicon" = 1 ] && ! py_native "$cand"; then intel_py="${intel_py:-$(command -v "$cand")}"; continue; fi
      py="$(command -v "$cand")"; break
    fi
  done
  [ -z "$intel_py" ] || say "$intel_py is an Intel Python, which this Mac runs under Rosetta: not used"
  if [ "$have_uv" = 1 ] && { uv_index_set || ! pip_index_set; }; then pytool=uv; fi
  local uv_v="" py_v="" get_py="Python $req_py if this machine lacks it" intel=""
  [ "$have_uv" = 0 ] || uv_v="uv $(uv --version 2>/dev/null | sed -e 's/^uv //' -e 's/ (.*//')"
  [ -z "$py" ] || py_v="Python $("$py" -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  [ "$apple_silicon" = 0 ] || get_py="a native arm64 Python $req_py if this machine lacks one"
  [ -z "$intel_py" ] || intel="; not the Intel Python at $(tilde "$intel_py"), which would need Xcode to build packages"
  found_py=ok
  if [ -n "$byo" ]; then
    check_byo
    found_py_text="Python $byo_v: your environment $(tilde "$byo_prefix"), which holds what thimble needs; nothing is installed into it"
  elif [ "$apple_silicon" = 1 ] && [ "$have_uv" = 0 ] && [ -z "$py" ]; then
    die "this Mac has Apple silicon, and no native arm64 Python $req_py+ was found$( [ -z "$intel_py" ] || echo " ($(tilde "$intel_py") is an Intel build, which would need Xcode to build thimble's packages)"). Install uv (https://docs.astral.sh/uv/getting-started/installation/), which gets a native Python, then run this again"
  elif [ "$checkout" = 1 ] && [ "$have_uv" = 1 ]; then
    found_py_text="$uv_v: installs thimble's Python packages at their tested versions, and $get_py$intel"
  elif [ "$have_uv" = 0 ] && [ -z "$py" ]; then
    die "neither uv nor Python $req_py+ was found. Install uv (https://docs.astral.sh/uv/getting-started/installation/) or Python $req_py+, then run this again"
  elif [ "$checkout" = 1 ]; then
    found_py=warn
    found_py_text="$py_v at $(tilde "$py"), and no uv: thimble's Python packages get the lowest versions it allows, not the tested ones (uv installs those: https://docs.astral.sh/uv/getting-started/installation/)$intel"
  elif [ "$pytool" = uv ]; then
    found_py_text="$uv_v: installs thimble's pinned Python packages, and $get_py$intel"
  elif [ "$have_uv" = 1 ]; then
    found_py_text="${py_v:-Python} with pip, which is set up with a package index (uv is not): pip installs thimble's pinned Python packages from it$intel"
  else
    found_py_text="$py_v at $(tilde "$py"): pip installs thimble's pinned Python packages from the package index it is set up with$intel"
  fi
  say "python: $found_py_text"
  venv_plan
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

copy_tree() {  # a release install: the release's entries replace the install's; .venv, node_modules, workspaces/, data/, dev/ and .git stay
  if [ "$in_place" = 1 ]; then say "the tree: in place, nothing to copy"; return 0; fi
  if [ -f "$src/RELEASE.json" ] && cmp -s "$src/RELEASE.json" "$dir/RELEASE.json"; then
    say "this release is installed there already (RELEASE.json matches, and it is copied last): nothing to copy"
    dir="$(cd "$dir" && pwd -P)"
    same "thimble $version is in $(tilde "$dir") already"
    [ -d "$dir/.git" ] || git_baseline  # an install from before the baselines
    return 0
  fi
  busy "Copying thimble $version to $(tilde "$dir")"
  say "copying the release into $dir (kept there if present: backend/.venv, frontend/node_modules, workspaces/, data/, dev/)"
  run mkdir -p "$dir"
  for entry in plugin extensions backend prompts demos frontend .claude-plugin scripts README.md INSTALL.md docs LICENSE THIRD_PARTY_NOTICES RELEASE.json; do
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
  # 0.8.0's terminal-mode renderer (mods/thimble-term), which the hooks module carries now (plugin/hooks/term)
  if [ -d "$dir/mods" ] && [ ! -e "$src/mods" ]; then say "+ remove $dir/mods (0.8.0's terminal renderer)"; [ "$dry" = 1 ] || rm -rf "$dir/mods"; fi
  if [ -d "$dir" ]; then dir="$(cd "$dir" && pwd -P)"; fi
  ok "Copied thimble $version to $(tilde "$dir")"
  git_baseline
}

BASELINE_REF=refs/thimble/baseline  # the release's own commit in a release install (scripts/update.sh reads it)
git_baseline() {  # a release install as a git repository whose last commit is the release as copied, so a code ticket's
  # change is a commit on top of it and `thimble update` can keep it on a branch (scripts/update.sh). Needs git; the
  # identity is the repository's own config, so nothing of the user's git setup is read or changed
  # RELEASE.json (release.sh writes it into every release) is what tells this repository from a clone later
  [ -f "$dir/RELEASE.json" ] || [ "$dry" = 1 ] || { say "no RELEASE.json in the copy: no git baseline"; return 0; }
  command -v git >/dev/null 2>&1 || { say "git not found: no git baseline, so code tickets do not run in this install"; return 0; }
  say "+ git baseline: commit the tree as \"thimble $version\" (kept out: backend/.venv frontend/node_modules workspaces/ data/ dev/ and Python's caches)"
  [ "$dry" = 1 ] && return 0
  local g=(git -C "$dir" -c commit.gpgsign=false -c core.hooksPath=/dev/null)
  if [ ! -d "$dir/.git" ]; then "${g[@]}" init -q || { warn "git init failed in $(tilde "$dir"): code tickets do not run in this install"; return 0; }; fi
  mkdir -p "$dir/.git/info"
  printf '%s\n' backend/.venv frontend/node_modules workspaces/ data/ dev/ __pycache__/ '*.pyc' > "$dir/.git/info/exclude"
  "${g[@]}" config user.name thimble && "${g[@]}" config user.email thimble@localhost
  if "${g[@]}" add --all . >/dev/null && "${g[@]}" commit -q --allow-empty --no-verify -m "thimble $version" >/dev/null \
      && "${g[@]}" update-ref "$BASELINE_REF" HEAD; then
    ok "git baseline: thimble $version committed in $(tilde "$dir")"
  else
    warn "the git baseline was not committed in $(tilde "$dir"): code tickets may not run in this install"
  fi
}

# backend/.venv that install.sh made holds VENV_MADE, and VENV_PENDING while install.sh installs into it, so a run that
# failed leaves it. A re-run makes such an environment again when it is broken (venv_problem): left unfinished, a Python
# that does not run or is too old, or an Intel one on Apple silicon. An environment install.sh did not make (a manual
# install's, one made by hand in a checkout) is never removed: a broken one stops the install with how to fix it.
VENV_MADE=.thimble-made VENV_PENDING=.thimble-installing
venv_why="" venv_redo=0 venv_fresh=0

venv_ours() { [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$VENV_MADE" ]; }  # venv_ours VENV: install.sh made it

venv_problem() {  # venv_problem VENV: why the environment there is broken, or nothing
  local v="$1"
  if [ -f "$v/$VENV_PENDING" ]; then echo "an earlier run did not finish installing into it"
  elif ! { [ -x "$v/bin/python" ] && (cd / && "$v/bin/python" -I -c '') 2>/dev/null; }; then echo "its Python does not run"
  elif ! py_ok "$v/bin/python"; then echo "its Python is older than the $req_py thimble needs"
  elif [ "$apple_silicon" = 1 ] && ! py_native "$v/bin/python"; then echo "its Python is an Intel build, which needs Xcode to build packages"
  fi
}

venv_plan() {  # before anything changes: venv_why, why backend/.venv is broken, when install.sh made it; one it did not
  # make that is broken stops the install
  local venv="$dir/backend/.venv" stop
  venv_why=""
  [ -z "$byo" ] && [ -d "$venv" ] && [ ! -L "$venv" ] || return 0
  venv_why="$(venv_problem "$venv")"
  [ -n "$venv_why" ] || return 0
  say "backend/.venv is broken: $venv_why"
  venv_ours "$venv" && return 0
  stop="$(tilde "$venv") is broken ($venv_why), and install.sh did not make it, so it leaves it as it is. Move it away or delete it, then run this again"
  venv_why=""
  if [ "$dry" = 1 ]; then show "install.sh stops here: $stop"; else die "$stop"; fi
}

venv_again() {  # a broken environment install.sh made (venv_plan) goes, so the install step makes it again
  [ -n "$venv_why" ] || return 0
  run rm -rf "$dir/backend/.venv"
  venv_redo=1
  ok "$(tilde "$dir/backend/.venv") was broken ($venv_why), so it is made again"
}

venv_mark() {  # venv_mark made|pending|finished: backend/.venv as install.sh's (made, when this run made it), as being
  # installed into (pending, only one install.sh made) or no longer (finished)
  local venv="$dir/backend/.venv"
  [ "$dry" = 0 ] && [ -d "$venv" ] && [ ! -L "$venv" ] || return 0
  case "$1" in
    made) if [ "$venv_fresh" = 1 ]; then : > "$venv/$VENV_MADE"; : > "$venv/$VENV_PENDING"; fi;;
    pending) if venv_ours "$venv"; then : > "$venv/$VENV_PENDING"; fi;;
    finished) rm -f "$venv/$VENV_PENDING";;
  esac
}

make_venv() {  # --python's environment linked; a linked one kept and checked; a checkout's from uv.lock (uv sync, else
  # venv + pip from pyproject); a release's from backend/requirements.txt (release_venv)
  local venv="$dir/backend/.venv" lacking where pyreq=()
  where="$(tilde "$venv")"
  extra=(); if [ "$dev" = 1 ]; then extra=(--extra dev); fi
  busy "Installing thimble's Python packages"
  if [ -z "$byo" ] && [ ! -L "$venv" ]; then
    venv_again
    venv_fresh=0; if [ ! -e "$venv" ] || [ "$venv_redo" = 1 ]; then venv_fresh=1; fi
    venv_mark pending
  fi
  # uv sync makes backend/.venv with the Python it finds, unless a native one is asked for (mac_arch)
  if [ "$apple_silicon" = 1 ] && [ "$venv_fresh" = 1 ]; then pyreq=(--python "$uv_python"); fi
  if [ -n "$byo" ] && [ "$venv" -ef "$byo_prefix" ]; then
    say "backend/.venv is $byo_prefix already; used as it is"
    same "Python packages: your environment $(tilde "$byo_prefix"), used as it is"
  elif [ -n "$byo" ]; then
    local was=""
    if [ -d "$venv" ] && [ ! -L "$venv" ]; then run rm -rf "$venv"; was=", in place of the one install.sh made"; fi
    run ln -sfn "$byo_prefix" "$venv"
    ok "Python packages: your environment $(tilde "$byo_prefix"), linked as $where$was; nothing installed into it"
  elif [ -L "$venv" ]; then
    say "backend/.venv → $(readlink "$venv"): an environment of your own (install.sh --python), used as it is"
    if [ "$dry" = 0 ] && ! lacking="$(cd / && "$venv/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" 2>&1)"; then
      warn "Python packages: your environment $(readlink "$venv") lacks what this version needs, so the server may not start until these are installed into it:"
      note "$lacking"
    else
      same "Python packages: your environment $(readlink "$venv"), used as it is"
    fi
  elif [ "$checkout" = 0 ]; then
    release_venv
    venv_mark finished
  elif [ "$have_uv" = 1 ] && [ -f "$src/backend/uv.lock" ]; then
    run_in "$dir/backend" uv sync --frozen --no-dev --no-install-project ${extra[@]+"${extra[@]}"} \
      ${pyreq[@]+"${pyreq[@]}"} ${uv_nobuild[@]+"${uv_nobuild[@]}"} \
      || { venv_mark made; tail_out; die "uv sync could not install the backend's packages (above)$(wheels_only)"; }
    venv_mark made; venv_mark finished
    # uv says "Checked N packages" (older: "Audited") when it changed nothing, and lists what it installed or removed
    if grep -qE '^(Checked|Audited) [0-9]+ package' "$tmp/out" && ! grep -qE '^ [-+~] |^(Installed|Uninstalled) [0-9]' "$tmp/out"; then
      same "Python packages up to date in $where (the versions backend/uv.lock pins)"
    else
      ok "Python packages installed in $where (the versions backend/uv.lock pins)"
    fi
  elif [ "$have_uv" = 1 ]; then
    [ "$require_pinned" = 0 ] || die "backend/uv.lock is missing, so nothing pins the backend's versions, and --require-pinned installs only pinned ones"
    run_in "$dir/backend" uv sync --no-dev --no-install-project ${extra[@]+"${extra[@]}"} \
      ${pyreq[@]+"${pyreq[@]}"} ${uv_nobuild[@]+"${uv_nobuild[@]}"} \
      || { venv_mark made; tail_out; die "uv sync could not install the backend's packages (above)$(wheels_only)"; }
    venv_mark made; venv_mark finished
    ok "Python packages installed in $where (backend/uv.lock is missing, so at the newest versions allowed, not the tested ones)"
  else
    [ "$require_pinned" = 0 ] || die "without uv the backend's pinned versions (backend/uv.lock) can't be installed, and --require-pinned installs only pinned ones; install uv (https://docs.astral.sh/uv/getting-started/installation/)"
    if [ "$venv_fresh" = 1 ]; then run "$py" -I -m venv "$venv" || { venv_mark made; tail_out; die "python -m venv failed (above)"; }; venv_mark made; fi
    say "pip from pyproject.toml (the minimum versions, not the pinned ones in uv.lock)"
    run "$venv/bin/python" -I -m pip install --quiet --upgrade pip || { tail_out; die "pip could not upgrade itself (above)"; }
    if [ "$dev" = 1 ]; then run "$venv/bin/python" -I -m pip install --quiet ${pip_nobuild[@]+"${pip_nobuild[@]}"} -e "$dir/backend[dev]" || { tail_out; die "pip could not install the backend's packages (above)$(wheels_only)"; }
    else run "$venv/bin/python" -I -m pip install --quiet ${pip_nobuild[@]+"${pip_nobuild[@]}"} -e "$dir/backend" || { tail_out; die "pip could not install the backend's packages (above)$(wheels_only)"; }; fi
    venv_mark finished
    ok "Python packages installed in $where, at the lowest versions allowed (without uv, not the tested ones)"
  fi
}

new_venv() {  # new_venv VENV: a release's backend/.venv, made by uv, else by the venv module, with pip in it when pip
  # installs; marked as install.sh's (venv_mark), also when the command that makes it fails halfway
  local venv="$1" made=0
  if [ "$pytool" = pip ] && [ -n "$py" ]; then
    run "$py" -I -m venv "$venv" && made=1
  else
    run uv venv --quiet --python "$uv_python" "$venv" && made=1
  fi
  venv_mark made
  if [ "$made" = 0 ]; then
    tail_out
    [ "$pytool" != pip ] || [ -z "$py" ] || die "python -m venv failed (above)"
    [ "$apple_silicon" = 0 ] || die "uv could not get a native arm64 Python $req_py (above). In a shell: uv python install $uv_python, then run this again"
    die "uv venv failed (above)"
  fi
  [ "$pytool" = uv ] || [ -n "$py" ] || run "$venv/bin/python" -I -m ensurepip --quiet || { tail_out; die "ensurepip failed (above)"; }
}

py_install() {  # py_install LOG ARGS…: uv pip or pip installs ARGS into backend/.venv; LOG keeps the output
  local log="$1" venv="$dir/backend/.venv"; shift
  if [ "$pytool" = uv ]; then logged "$log" uv pip "$@" --python "$venv/bin/python" ${uv_nobuild[@]+"${uv_nobuild[@]}"}
  else logged "$log" "$venv/bin/python" -I -m pip install --quiet --disable-pip-version-check ${pip_nobuild[@]+"${pip_nobuild[@]}"} "$@"; fi
}

py_ranges() {  # py_ranges WHICH: pyproject's dependencies (all, or dev: the dev extra alone), at the versions it allows
  local req="$tmp/requirements.txt"
  [ "$dry" = 1 ] || "$dir/backend/.venv/bin/python" -I -c 'import sys, tomllib
p = tomllib.load(open(sys.argv[1], "rb"))["project"]
dev = p.get("optional-dependencies", {}).get("dev", []) if sys.argv[3] == "1" else []
print("\n".join(dev if sys.argv[2] == "dev" else p.get("dependencies", []) + dev))' "$src/backend/pyproject.toml" "$1" "$dev" > "$req"
  say "+ the requirements of backend/pyproject.toml$( [ "$1" = dev ] && echo "'s dev extra" ) into $req"
  if [ "$pytool" = uv ]; then set -- install -r "$req"; else set -- -r "$req"; fi
  py_install "$tmp/py.log" "$@" || { tail_out; die "the backend's packages could not be installed (above)$(wheels_only)"; }
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
  if [ "$venv_redo" = 0 ] && [ "$dev" = 0 ] && [ -f "$req" ] && cmp -s "$req" "$stamp" && (cd / && "$venv/bin/python" -I -c '') 2>/dev/null; then
    say "backend/.venv holds the packages backend/requirements.txt pins, installed by an earlier run"
    same "Python packages up to date in $where"
    return 0
  fi
  if [ "$venv_fresh" = 1 ]; then new_venv "$venv"
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
    --quiet --python "$py" ${uv_nobuild[@]+"${uv_nobuild[@]}"} || return 1
  logged "$tmp/py.log" uv pip sync --require-hashes "$out" --python "$py" ${uv_nobuild[@]+"${uv_nobuild[@]}"}
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
    note "Install Node 20+ (https://nodejs.org), then run bash $(tilde "$dir")/scripts/install.sh again."
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
  elif [ "$pkg_note" = "up to date" ] && [ -z "$ui" ]; then
    same "Node packages up to date in $where"
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
browser_unchanged() {  # nothing for its step to do (nothing_planned): the answer stays, and a bundled browser is there
  [ -z "$browser" ] || [ "$browser" = "$browser_was" ] || return 1
  case "${browser:-${browser_was:-$browser_auto}}" in
    bundled) [ "$bundled_there" = 1 ];;
    system) [ -n "$sys_path" ];;
    off) return 0;;
    *) return 1;;
  esac
}
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
  local line=same  # ok for a new answer, which is a change
  [ -z "$browser" ] || [ "$browser" = "$browser_was" ] || line=ok
  case "$choice" in
    system)
      if [ -z "$sys_path" ]; then
        warn "No screenshots: no Chrome or Edge is where Playwright looks for one"
        note "For screenshots, install Chrome, or download Playwright's headless Chromium: $fix"
      else
        busy "Checking that $sys_name starts for screenshots"
        launch_check "$sys_channel"
        if [ -z "$lc" ]; then "$line" "Screenshots use $sys_name ($(tilde "$sys_path"))"
        else
          warn "$sys_name did not start under automation (${lc_why}), which a policy on this machine can block, so there are no screenshots"
          note "For screenshots, download Playwright's headless Chromium: $fix"
        fi
      fi;;
    bundled)
      busy "Downloading Playwright's headless Chromium (about 210 MB)"
      fetch_bundled
      launch_check
      if [ "$fetch_failed" = 1 ]; then
        warn "Playwright's headless Chromium could not be downloaded (above), so there are no screenshots"
        note "For screenshots, run this again when the download works: $fix"
      elif [ "$lc" = nolibs ]; then
        warn "Playwright's headless Chromium is downloaded, but this machine lacks the system libraries it needs, so there are no screenshots"
        note "For screenshots, install those libraries. In a shell, as root: $dir/backend/.venv/bin/python -m playwright install-deps chromium-headless-shell"
      elif [ "$lc" = failed ]; then
        warn "Playwright's headless Chromium did not start ($lc_why), so there are no screenshots"
      elif [ "$fetched" -gt 0 ]; then ok "Screenshots use Playwright's headless Chromium, downloaded to $(tilde "$(pw_cache)")"
      else "$line" "Screenshots use Playwright's headless Chromium, downloaded already ($(tilde "$(pw_cache)"))"; fi;;
    off)
      "$line" "No screenshots, as you chose: thimble can't check how its cards and views look (--browser bundled or --browser system turns them on)";;
    *)
      say "(the answer to the browser question, above)";;
  esac
  if [ -n "$browser" ] && [ "$browser" != "$browser_was" ]; then record_browser "$browser"; fi
}

# ------------------------------------------------------------------------- card code's sandbox (Linux)
# Card code runs in the notebook kernel, in Anthropic's sandbox runtime or in bubblewrap, and the terminal draws views
# only in one of them; on Linux both need bubblewrap to create a sandbox. install.sh installs neither: the opening screen
# says whether it runs, and `thimble doctor --verbose` names the commands that add it.
card_found() {  # its line in the opening screen's Found, on Linux
  local bw why
  [ "$(uname -s)" = Linux ] || return 0
  if ! bw="$(command -v bwrap)"; then why="bubblewrap missing"
  elif ! "$bw" --ro-bind / / --dev /dev --unshare-all --die-with-parent true >/dev/null 2>&1; then
    why="bubblewrap can't create a sandbox here"
  else
    found ok "card code and terminal views sandbox: bubblewrap runs here"
    return 0
  fi
  found ok "card code: runs without a sandbox, and the terminal shows no views ($why); thimble doctor --verbose names the commands that add it"
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
  if [ "$cli_state" = ours ]; then same "The thimble command: $(tilde "$cli_link")"
  else ok "The thimble command: $(tilde "$cli_link")"; fi
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

plugin_step() {  # thimble's plugin in Claude Code (scripts/plugin.sh): added from this install's folder at user scope, or
  # updated when its version or its files changed; another install's is left as it is. --no-plugin leaves Claude Code's
  # plugins alone
  local mp_file="$dir/.claude-plugin/marketplace.json"
  if [ "$plugin" = no ]; then same "Claude Code's plugins left as they are (--no-plugin)"; return 0; fi
  if [ "$mp_name" != "$mp_file_name" ]; then
    say "+ set .name = \"$mp_name\" in $mp_file"
    [ "$dry" = 1 ] || python3 -I -c 'import json,sys; p,n=sys.argv[1:]; d=json.load(open(p)); d["name"]=n; json.dump(d, open(p,"w"), indent=2); open(p,"a").write("\n")' "$mp_file" "$mp_name"
  fi
  plugin_apply || true
}

# ------------------------------------------------------------------------------------- the shell startup files
# A new terminal finds `thimble` once the folder of its link is on PATH, and a THIMBLE_HOME other than ~/.thimble must
# stay set wherever thimble or Claude Code runs. install.sh writes no startup file: at its end it prints the line for
# each, in the syntax of the user's shell ($SHELL, else the login shell the user database names), and the file it goes
# in: zsh ${ZDOTDIR:-~}/.zshrc; bash ~/.bashrc, and the file a login shell reads (the first of ~/.bash_profile,
# ~/.bash_login and ~/.profile; ~/.profile when there is none) unless it sources ~/.bashrc; fish
# ~/.config/fish/conf.d/thimble.fish; sh, dash or ksh ~/.profile. Another shell (csh, tcsh, nu…) gets what to set in
# words. A line is printed only while it is needed (PATH lacks the folder; the home is not the default), only where the
# file lacks it, and only while the `thimble` link runs this install. `claude` and /thimble need neither line.
# Installs before 0.8.0 wrote these lines themselves, each ending with SHELL_MARK and recorded in $home/shell-startup,
# from which `thimble uninstall` still removes exactly those lines (plugin/bin/thimble); such a line counts as present.
SHELL_MARK="# added by thimble's installer"
sh_want="" sh_why="" sh_name="" sh_had_home=0 sh_files=() sh_lines=() sh_add=()

login_shell() {  # the user's login shell: $SHELL, else the user database's entry
  local sh="${SHELL:-}"
  if [ -z "$sh" ] && [ "$(uname -s)" = Darwin ]; then
    sh="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n 's/^UserShell: *//p')"
  elif [ -z "$sh" ]; then
    sh="$( (getent passwd "$(id -un)" || grep "^$(id -un):" /etc/passwd) 2>/dev/null | head -n 1 | cut -d: -f7)"
  fi
  printf '%s\n' "$sh"
}

shell_word() {  # shell_word DIR: DIR as the startup files write it, $HOME/… under the home folder; 1 when its name holds a
  # character that a double-quoted word expands (" $ ` \ !)
  case "$1" in *[\"\$\`\\!]*) return 1;; esac
  case "$1" in "$HOME"/*) printf '$HOME/%s\n' "${1#"$HOME"/}";; *) printf '%s\n' "$1";; esac
}

wants() { case " $sh_want " in *" $1 "*) return 0;; esac; return 1; }  # wants path|home: a new terminal needs that line

shell_plan() {  # the lines a new terminal needs (sh_want: path while PATH lacks the link's folder, home for a home other
  # than ~/.thimble), the startup files of the user's shell (sh_files), those lines in its syntax (sh_lines), and each
  # "FILE<TAB>LINE" where a line is missing (sh_add); sh_why: other (a shell install.sh knows no syntax for) or name (a
  # folder's name a startup file would expand). Nothing is wanted while the `thimble` link would run another program or
  # install (cli_plan, link_cli)
  local sh f login w bin_w home_w
  sh_want="" sh_why="" sh_name="" sh_had_home=0 sh_files=() sh_lines=() sh_add=()
  case "${cli_state:-}" in new | ours | gone) ;; other) [ "$cli_switch" = yes ] || return 0;; *) return 0;; esac
  path_has_local_bin || sh_want="path"
  [ "$custom_home" = 0 ] || sh_want="${sh_want:+$sh_want }home"
  [ -n "$sh_want" ] || return 0
  sh="$(login_shell)"; sh_name="${sh##*/}"
  case "$sh_name" in
    zsh) sh_files=("${ZDOTDIR:-$HOME}/.zshrc");;
    bash) sh_files=("$HOME/.bashrc"); login=""
          for f in .bash_profile .bash_login .profile; do if [ -f "$HOME/$f" ]; then login="$HOME/$f"; break; fi; done
          login="${login:-$HOME/.profile}"
          grep -qE '^[^#]*(^|[[:space:];&|])(\.|source)[[:space:]][^#]*\.bashrc' "$login" 2>/dev/null || sh_files+=("$login");;
    fish) sh_files=("${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/thimble.fish");;
    sh | dash | ksh | ksh93 | mksh | pdksh | oksh | loksh | ash | yash | posh | busybox | "") sh_files=("$HOME/.profile");;
    *) sh_why=other; return 0;;
  esac
  if ! bin_w="$(shell_word "$bin_dir")" || ! home_w="$(shell_word "$home")"; then sh_why=name; return 0; fi
  for w in $sh_want; do
    case "$sh_name:$w" in
      fish:path) sh_lines+=("contains -- \"$bin_w\" \$PATH; or set -gx PATH \"$bin_w\" \$PATH");;
      fish:home) sh_lines+=("set -gx THIMBLE_HOME \"$home_w\"");;
      *:path) sh_lines+=("export PATH=\"$bin_w:\$PATH\"");;
      *:home) sh_lines+=("export THIMBLE_HOME=\"$home_w\"");;
    esac
  done
  for f in "${sh_files[@]}"; do
    for w in "${sh_lines[@]}"; do
      if ! { [ -f "$f" ] && grep -qxF -e "$w" -e "$w  $SHELL_MARK" "$f"; }; then sh_add+=("$f"$'\t'"$w"); fi
    done
  done
  ! wants home || case " ${sh_add[*]+"${sh_add[*]}"} " in *THIMBLE_HOME*) ;; *) sh_had_home=1;; esac
}

shell_files_text() {  # the startup files, "~/.zshrc" or "~/.bashrc and ~/.profile"
  local f out=""
  for f in ${sh_files[@]+"${sh_files[@]}"}; do out="${out:+$out and }$(tilde "$f")"; done
  printf '%s\n' "$out"
}

shell_needs() {  # what a new terminal needs set, in words, where install.sh knows no line for the shell
  ! wants path || show "  $(tilde "$bin_dir") on PATH"
  ! wants home || show "  THIMBLE_HOME=$(arg_path "$home")"
}

shell_advice() {  # after Next: the lines the startup files lack that a new terminal needs for `thimble`, and the command
  # that runs thimble in this terminal (HERE) until then
  local here="$1" line p f lacking groups=() each="" same=1
  [ "$cli_linked" = 1 ] && [ -n "$sh_want" ] || return 0
  if [ "$sh_why" = other ]; then
    showf "To run thimble in a new terminal, set this in the startup file of your shell, $sh_name:"; shell_needs
  elif [ "$sh_why" = name ]; then
    showf "To run thimble in a new terminal, set this in your shell's startup file (a folder's name holds a character a startup file would expand):"; shell_needs
  elif [ "${#sh_add[@]}" = 0 ]; then
    [ "$here" = thimble ] || showf "This terminal started before $(shell_files_text) had $( [ "${#sh_lines[@]}" -gt 1 ] && echo 'those lines' || echo 'that line'), so in it run: $here"
    return 0
  else
    for line in "${sh_lines[@]}"; do  # the files that lack each line
      lacking=""
      for p in "${sh_add[@]}"; do
        [ "${p#*$'\t'}" = "$line" ] || continue
        f="$(tilde "${p%%$'\t'*}")"; lacking="${lacking:+$lacking and }$f"
      done
      [ -n "$lacking" ] || continue
      groups+=("$lacking"$'\t'"$line")
      if [ -z "$each" ]; then each="$lacking"; elif [ "$each" != "$lacking" ]; then same=0; fi
    done
    if [ "${#groups[@]}" = 1 ]; then
      showf "To run thimble in a new terminal, add this to ${groups[0]%%$'\t'*}: ${groups[0]#*$'\t'}"
    elif [ "$same" = 1 ]; then
      showf "To run thimble in a new terminal, add these to $each:"
      for p in "${groups[@]}"; do show "  ${p#*$'\t'}"; done
    else
      for p in "${groups[@]}"; do showf "To run thimble in a new terminal, add this to ${p%%$'\t'*}: ${p#*$'\t'}"; done
    fi
  fi
  [ "$here" = thimble ] || showf "Until then: $here"
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

plan() {  # what the question, the plugin, the link and the startup files find, before the opening screen
  local q
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do "${q}_plan"; done
  plugin_reg="" plugin_on="" plugin_version="" plugin_files="" other_reg="" other_from="" plugin_known=1 plugin_ok=0
  cli_state="" cli_other="" cli_switch=""
  if [ "$deps_only" = 0 ]; then
    [ "$plugin" = no ] || plugin_record
    cli_plan; shell_plan
  fi
}

title() {  # the installer's first line
  local what="Global install"
  if [ "$checkout" = 1 ] && [ "$in_place" = 1 ]; then what="Dev install: thimble runs from this folder"
  elif [ "$checkout" = 1 ]; then what="Dev install"; fi
  printf '%s\n' "thimble $version installer · $what$( [ "$dry" = 1 ] && echo ' · dry run, nothing is changed')"
}

nothing_planned() {  # a re-run with nothing to do, as far as the plan can tell: no question, the tree copied already,
  # the packages installed at the pinned versions, the web interface current, the browser there, the same `thimble`
  # link and app-dir, and this install's plugin in Claude Code unchanged. Its steps then run quietly (quiet): only what
  # changed or needs you is shown, and the last lines say when nothing needed doing
  local q venv="$dir/backend/.venv" fe="$dir/frontend"
  [ "$deps_only" = 0 ] && [ "${#ignored[@]}" = 0 ] || return 1
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do
    if "${q}_pending" || { declare -F "${q}_unchanged" >/dev/null && ! "${q}_unchanged"; }; then return 1; fi
  done
  [ "$in_place" = 1 ] || { [ -f "$src/RELEASE.json" ] && cmp -s "$src/RELEASE.json" "$dir/RELEASE.json" && [ -d "$dir/.git" ]; } || return 1
  [ -z "$venv_why" ] || return 1
  if [ -n "$byo" ]; then [ "$venv" -ef "$byo_prefix" ] || return 1
  elif [ -L "$venv" ]; then :
  elif [ "$checkout" = 0 ]; then
    [ "$dev" = 0 ] && [ -f "$dir/backend/requirements.txt" ] && cmp -s "$dir/backend/requirements.txt" "$venv/.thimble-requirements.txt" || return 1
  else [ "$have_uv" = 1 ] && [ -f "$dir/backend/uv.lock" ] && [ -x "$venv/bin/python" ] || return 1; fi
  [ "$node_ok" = 1 ] && [ "$has_dist" = 1 ] && [ -z "$stale" ] || return 1
  if [ -L "$fe/node_modules" ]; then :
  elif [ "$checkout" = 0 ]; then cmp -s "$fe/runtime/package-lock.json" "$fe/node_modules/.thimble-package-lock.json" || return 1
  else cmp -s "$fe/package-lock.json" "$fe/node_modules/.thimble-package-lock.json" || return 1; fi
  [ "$cli_state" = ours ] && [ -f "$home/app-dir" ] && [ "$(head -n 1 "$home/app-dir")" = "$dir" ] || return 1
  [ "$plugin" = no ] && return 0
  [ "$mp_name" = "$mp_file_name" ] && [ "$plugin_reg" = "$mp_name" ] && [ "$plugin_version" = "$version" ] || return 1
  case "$plugin_files" in inplace | same) return 0;; *) return 1;; esac
}

opening() {  # the one screen before the questions: what install.sh found, what it installs where, what it changes in
  # Claude Code's setup, and how many questions remain
  local q n=0 venv="$dir/backend/.venv" fe="$dir/frontend/node_modules"
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if "${q}_pending"; then n=$((n + 1)); fi; done
  heading "$(title)"
  show ""
  heading_q "Found"
  found "$found_claude" "$found_claude_text"
  found "$found_py" "$found_py_text"
  found "$found_node" "$found_node_text"
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if declare -F "${q}_found" >/dev/null; then "${q}_found"; fi; done
  card_found
  show ""
  heading_q "Installs"
  if [ "$in_place" = 1 ]; then row "thimble $version" "$(tilde "$dir")" "runs from here; nothing is copied"
  else row "thimble $version" "$(tilde "$dir")" "$(size_of "$src")"; fi
  if [ -n "$byo" ]; then row "Python packages" "your environment $(tilde "$byo_prefix")" "nothing installed into it"
  elif [ -n "$venv_why" ]; then row "Python packages" "$(tilde "$venv")" "made again: $venv_why"
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
      *) row "thimble command" "$(tilde "$cli_link")" \
           "$(! wants path || echo "$(tilde "$bin_dir") is not on PATH: the last lines say what to add to your shell's startup file")";;
    esac
  fi
  row "settings and logs" "$(tilde "$home")"
  # where thimble keeps what it makes as you work (config.WORKSPACES_DIR): inside the install, a clone's own folder
  row "your workspaces" "$(tilde "${THIMBLE_WORKSPACES_DIR:-$dir/workspaces}")" "the cards, labels and reports thimble makes"
  if [ "$deps_only" = 0 ]; then
    show ""
    heading_q "Your Claude Code setup"
    plugin_setup
    for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if declare -F "${q}_setup" >/dev/null; then "${q}_setup"; fi; done
  fi
  if [ "${#ignored[@]}" -gt 0 ]; then show ""; ignored_line; fi
  show ""
  if [ "$n" = 0 ]; then show "Questions: none."
  elif [ "$dry" = 1 ]; then show "Questions: $n, listed below."
  else show "Questions: $n, next."; fi
}

plugin_setup() {  # the plugin's line in "Your Claude Code setup"
  local cc
  cc="$(tilde "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"
  if [ "$plugin" = no ]; then found ok "thimble's plugin: left as it is (--no-plugin)"
  elif [ "$have_claude" != 1 ]; then
    found warn "thimble's plugin: not added, since Claude Code is not installed; run install.sh again once it is"
  elif [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    found ok "another install's thimble@$other_reg (from $(tilde "$other_from")) stays; to switch: $(plugin_switch_cmds)"
  elif [ "$plugin_reg" = "$mp_name" ] && [ "$plugin_version" != "$version" ]; then
    found ok "updates thimble's plugin (thimble@$mp_name) from ${plugin_version:-its version} to $version with claude plugin update; on or off as you set it"
  elif [ "$plugin_reg" = "$mp_name" ]; then
    case "$plugin_files" in
      inplace) found ok "thimble's plugin (thimble@$mp_name $version): Claude Code reads it from $(tilde "$dir")/plugin itself, so nothing to update";;
      same) found ok "thimble's plugin (thimble@$mp_name $version): unchanged, nothing to update";;
      differs) found ok "thimble's plugin (thimble@$mp_name $version): its files changed, so it is installed again (claude plugin uninstall, then install), with its options and on or off as you set them";;
      *) found ok "updates thimble's plugin (thimble@$mp_name) when its version changed; on or off as you set it";;
    esac
  else
    found ok "adds thimble's plugin with Claude Code's own commands: claude plugin marketplace add $(arg_path "$dir"), then claude plugin install --scope user thimble@$mp_name (Claude Code writes it to $cc/settings.json and $cc/plugins)"
  fi
}

ignored_line() {  # one line naming the flags of 0.7 that were given, which this version ignores
  local n="${#ignored[@]}" i list=""
  for ((i = 0; i < n; i++)); do
    if [ "$i" = 0 ]; then list="${ignored[i]}"; elif [ "$i" = $((n - 1)) ]; then list="$list and ${ignored[i]}"; else list="$list, ${ignored[i]}"; fi
  done
  found ok "$list $( [ "$n" = 1 ] && echo is || echo are ) ignored: thimble 0.8 always adds its plugin, installs no system package and writes no shell startup file"
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
  # terminal only, whether to switch another install's `thimble` command to this one
  local q pending=() need=() i=0 n again how
  how="bash $(tilde "$src")/scripts/install.sh"
  [ "${THIMBLE_INSTALL_VIA:-}" != update ] || how="thimble update"  # scripts/update.sh runs it: thimble update installs
  tty=0
  for q in ${QUESTIONS[@]+"${QUESTIONS[@]}"}; do if "${q}_pending"; then pending+=("$q"); fi; done
  n="${#pending[@]}"
  if [ "$dry" = 1 ]; then
    if [ "$n" = 0 ] && nothing_planned; then
      showf "Nothing to ask, and nothing to install: thimble $version is in $(tilde "$dir") and up to date."
    elif [ "$n" = 0 ]; then
      showf "Nothing to ask: install with  $how"
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
      showf "Then install with  $how  and one flag per answer."
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
    elif [ "$how" = "thimble update" ]; then
      again="Ask them, then run \`thimble update\` again with a flag for each, which it passes on to install.sh."
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

doctor_check() {  # thimble doctor --verbose, its report in the log; the line names what it found wrong with Claude Code's
  # login
  local auth net rc=0
  busy "Checking the install with thimble doctor"
  run "$dir/plugin/bin/thimble" doctor --verbose || rc=$?
  [ "$dry" = 0 ] || return 0
  auth="$(sed -n 's/^  auth: //p' "$tmp/out" | head -n 1)"
  net="$(sed -n 's/^  network: //p' "$tmp/out" | head -n 1)"
  if [ "$rc" != 0 ]; then warn "thimble doctor failed (exit $rc); its output is in $(tilde "$log_file")"
  elif [ "${auth#not logged in}" != "$auth" ]; then
    warn "Checked with thimble doctor: Claude Code is not logged in, and nothing that calls a model runs until it is"
    note "To log in, in a shell: claude auth login (or /login in a claude session)"
  elif [ -n "$net" ] && [ "${net%answers}" = "$net" ] && [ "${net#not checked}" = "$net" ]; then
    warn "Checked with thimble doctor: the Claude API does not answer from here ($net)"
  else same "Checked with thimble doctor$( [ "${auth#logged in}" != "$auth" ] && echo ': Claude Code is logged in') (thimble doctor shows a checklist; --verbose the details)"; fi
}

next_lines() {  # next_lines NAME: how to start thimble, in the README's words: claude in a folder, where thimble is on,
  # when Claude Code has this install's plugin; else NAME, the `thimble` command, which loads the plugin itself
  if [ "$plugin_ok" != 1 ]; then
    showf "Next: run $1 in a folder with your files. It starts Claude Code with thimble and opens the browser workbench."
  elif [ "$plugin_on" = off ]; then
    showf "Next: run claude in a folder with your files. thimble is off now: /plugin turns it on."
    show "  /thimble browser opens the same session in the browser workbench."
  else
    showf "Next: run claude in a folder with your files. thimble is on in every session."
    show "  /thimble browser opens the same session in the browser workbench."
    show "  /plugin turns thimble on or off."
  fi
}

finish() {  # doctor, a server that runs another tree, then what to run next (next_lines); then the line a new terminal
  # needs for `thimble`, if any, and the command that works in this terminal until then (shell_advice)
  local name here pid repo
  doctor_check
  # a server started from another tree keeps running that tree's code until it is restarted
  if [ "$dry" = 0 ] && [ -f "$home/server.json" ]; then
    pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$home/server.json" | head -n 1)"
    repo="$(json_get "$home/server.json" repo)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -n "$repo" ] && [ "$repo" != "$dir" ]; then
      warn "The thimble server (pid $pid) still runs the install in $repo until it restarts"
      note "To run this install, restart it while no agent is at work. In a shell: thimble server restart"
    fi
  fi
  [ "$dry" = 0 ] || return 0
  shell_plan  # again: a yes may have switched the link to this install since the opening screen
  # `thimble` in a new terminal, once the startup files have the lines shell_advice prints; in this one, the command that
  # works now: the link by its path while PATH lacks its folder, with THIMBLE_HOME while no startup file sets it
  if [ "$cli_linked" = 1 ]; then
    name=thimble
    if path_has_local_bin; then here=thimble; else here="$(arg_path "$cli_link")"; fi
  else
    name="$(arg_path "$dir/plugin/bin/thimble")" here="$name"
  fi
  if [ "$custom_home" = 1 ] && [ "$sh_had_home" = 0 ]; then
    here="THIMBLE_HOME=$(arg_path "$home") $here"
    [ "$cli_linked" = 1 ] || name="$here"
  fi
  if [ "$changed" = 0 ] && [ "$warned" = 0 ]; then
    heading "thimble $version is installed in $(tilde "$dir") and up to date: nothing needed doing."
  elif [ "$changed" = 0 ]; then
    heading "Done: thimble $version in $(tilde "$dir") is unchanged; the ! lines above need you."
  elif [ "$quiet" = 1 ]; then
    heading "Done: thimble $version is installed in $(tilde "$dir"); the rest was up to date."
  else
    heading "Done: thimble $version is installed in $(tilde "$dir")"
  fi
  next_lines "$name"
  shell_advice "$here"
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
  # a re-run with nothing to do skips the opening screen and shows only what changed (nothing_planned)
  if [ "$dry" = 0 ] && [ "$verbose" = 0 ] && nothing_planned; then
    quiet=1 quiet_title="$(title)"
    say "a re-run with nothing to do, as far as the plan can tell: only what changes or needs you is shown"
  else
    opening
    ask
  fi
  if [ "$dry" = 1 ] && [ "$verbose" = 0 ]; then exit 0; fi
  [ "$dry" = 1 ] && say "(dry run: every step's commands follow; none of them runs)"
  [ "$quiet" = 1 ] || heading "Installing"
  run_steps first
  copy_tree
  make_venv
  build_ui
  run_steps deps
  if [ "$deps_only" = 1 ]; then heading "--deps-only: done"; exit 0; fi
  write_pointer
  link_cli
  plugin_step
  run_steps last
  finish
}
main "$@"
