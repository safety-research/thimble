#!/usr/bin/env bash
# scripts/install.sh — install thimble: a git checkout in place, or an unzipped release copied to ~/.thimble/app.
# Steps: prerequisites · what it installs and where, then its questions · the agents' Bash sandbox (on Linux its system
# packages, if wanted) · copy the release into --dir · backend/.venv · the frontend's packages and frontend/dist · a
# browser for screenshots · the app-dir pointer · `thimble` on PATH (~/.local/bin/thimble → the tree's plugin/bin/thimble) ·
# thimble's plugin in every Claude Code session, if wanted · the trust of thimble's workspaces folder, if wanted · doctor ·
# what to do next.
# The questions (the browser; on Linux, the sandbox's system packages while it can't run; the plugin; the trust) are asked
# on a terminal before anything is installed, and the sandbox step runs right after them, so only sudo asks for more (its
# password). The browser, plugin and trust answers are kept in $THIMBLE_HOME (config.json's "browser", plugin.json,
# trust.json), so a re-run or `thimble update` does not ask them again. A flag answers a question without asking.
# Without a terminal install.sh refuses to run while a question it would ask has no flag, except the browser question
# when a system Chrome or Edge is found: that browser is then used and nothing is downloaded.
# --dry-run prints the questions with the flag for each answer, which is how Claude asks them when it runs the install.
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
# the pinned versions are listed; --require-pinned stops there instead. A file whose hash differs from the pinned one stops the install, from either index.
# Needs: uv (or python3 >= 3.12); node >= 20 for custom views (a checkout: 20.19+, 22.13+ or 24+, which its frontend tests need), for the sandbox runtime card code and code tickets run in
# (a package of the frontend's), and to build frontend/dist when it is missing or out of date;
# the claude CLI to register the plugin.
# The marketplace name is thimble-local from a release zip and thimble from a checkout (.claude-plugin/marketplace.json).
#
#   scripts/install.sh [--dir DIR] [--marketplace-name NAME] [--dev] [--python PATH] [--deps-only] [--require-pinned]
#                      [--browser bundled|system|off] [--sandbox-deps | --no-sandbox-deps] [--plugin | --no-plugin]
#                      [--trust-workspaces | --no-trust-workspaces] [--dry-run]
#   --dir DIR                where the tree lives (default: this checkout; $THIMBLE_HOME/app for a release)
#   --marketplace-name NAME  the name Claude Code registers the tree under (default: the one in marketplace.json)
#   --dev                    also install the backend's test extras (pytest, pytest-asyncio); a git checkout always does
#   --python PATH            use the environment of the python at PATH, a virtual environment you prepared, in place of
#                            creating backend/.venv: install.sh checks that it holds the packages pyproject.toml asks for,
#                            at versions it allows, links backend/.venv to it and installs nothing into it. Later runs
#                            and `thimble update` keep the link and check it again
#   --deps-only              stop after the browser step: no pointer, no plugin, no trust, no doctor
#   --require-pinned         install only pinned versions: stop where the package index lacks one, and where nothing pins
#                            them (a Dev install without uv or without backend/uv.lock)
#   --browser bundled        download Playwright's headless Chromium into Playwright's cache folder (about 210 MB to
#                            download, 650 MB on disk: the backend's and the frontend's Playwright each pin a build)
#   --browser system         screenshots with the Chrome or Edge installed on this machine (where Playwright's chrome and
#                            msedge channels look); nothing is downloaded
#   --browser off            no browser: no screenshots, so thimble can't check and improve its cards and views
#   --sandbox-deps           on Linux, install with sudo what Claude Code's Bash sandbox lacks, which thimble's agents run
#                            in: bubblewrap and socat from the system's package manager, and on Ubuntu 23.10 or later an
#                            AppArmor profile that lets bwrap create user namespaces (/etc/apparmor.d/bwrap).
#                            --no-sandbox-deps answers no
#   --plugin                 add thimble to ~/.claude/settings.json and ~/.claude/plugins, so it is available in every
#                            claude session from startup. --no-plugin answers no, and takes back what an earlier yes
#                            added. The `thimble` command works either way
#   --trust-workspaces       trust thimble's workspaces folder by adding it to ~/.claude.json. The orientation, its critic
#                            and the writers run as Claude Code background agents, which start only in a trusted folder.
#                            --no-trust-workspaces answers no, and takes back what an earlier yes added
#   --dry-run                print what it installs, its questions and every step and command; change nothing
# THIMBLE_BIN_DIR, when set, is the folder the `thimble` link goes into in place of ~/.local/bin.
set -euo pipefail

usage()  { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say()    { printf '%s\n' "$*"; }
step()   { printf '\n== %s\n' "$*"; }
die()    { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
run()    { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || "$@"; }
run_in() { local d="$1"; shift; printf '+ cd %q &&' "$d"; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || ( cd "$d" && "$@" ); }
json_get() {  # json_get FILE KEY — a top-level string value (python3 when present, else a sed for the flat case)
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2"
  else sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; fi
}

parse_args() {
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  home="${THIMBLE_HOME:-$HOME/.thimble}"
  bin_dir="${THIMBLE_BIN_DIR:-$HOME/.local/bin}"
  dir="" mp_name="" dev=0 deps_only=0 plugin="" dry=0 trust="" byo="" browser="" sandbox_deps="" require_pinned=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2;;
      --browser | --browser=*)
        if [ "$1" = --browser ]; then browser="${2:-}"; shift $(( $# > 1 ? 2 : 1 )); else browser="${1#--browser=}"; shift; fi
        case "$browser" in system | bundled | off) ;; *) die "--browser takes system, bundled or off (got '${browser}')";; esac;;
      --marketplace-name) mp_name="$2"; shift 2;;
      --dev) dev=1; shift;;
      --python) byo="$2"; shift 2;;
      --deps-only) deps_only=1; shift;;
      --require-pinned) require_pinned=1; shift;;
      --sandbox-deps) sandbox_deps=yes; shift;;
      --no-sandbox-deps) sandbox_deps=no; shift;;
      --plugin) plugin=yes; shift;;
      --no-plugin) plugin=no; shift;;
      --trust-workspaces) trust=--yes; shift;;
      --no-trust-workspaces) trust=--no; shift;;
      --dry-run) dry=1; shift;;
      -h|--help) usage; exit 0;;
      *) echo "install.sh: unknown argument $1" >&2; usage >&2; exit 2;;
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
  if [ "$dry" = 1 ]; then say "install.sh --dry-run: printing the steps; nothing is created, installed or registered"; fi
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
  say "python: $byo_prefix/bin/python, $(cd / && "$byo" -I -c 'import platform; print(platform.python_version())'), holds what backend/pyproject.toml asks for; backend/.venv will link to it"
  if [ "$dev" = 1 ] && ! lacking="$(cd / && "$byo_prefix/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" --extra dev 2>&1)"; then
    say "it lacks the test extras, which only the tests need:"; say "$lacking"
  fi
}

check_prerequisites() {  # uv or python >= pyproject's requires-python, or --python's environment; node >= 20 unless frontend/dist is built; the claude CLI
  step "1/12 prerequisites"
  req_py="$(sed -n 's/^requires-python *= *">=\([0-9][0-9.]*\)".*/\1/p' "$src/backend/pyproject.toml")"; req_py="${req_py:-3.12}"
  have_uv=0 py="" pytool=pip
  ! command -v uv >/dev/null 2>&1 || have_uv=1
  for cand in python3 python3.14 python3.13 python3.12; do
    if command -v "$cand" >/dev/null 2>&1 && py_ok "$cand"; then py="$(command -v "$cand")"; break; fi
  done
  if [ "$have_uv" = 1 ] && { uv_index_set || ! pip_index_set; }; then pytool=uv; fi
  local uv_v="" py_v=""
  [ "$have_uv" = 0 ] || uv_v="uv $(uv --version 2>/dev/null | sed 's/^uv //')"
  [ -z "$py" ] || py_v="python $("$py" -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') at $py (>= $req_py)"
  if [ -n "$byo" ]; then
    check_byo
  elif [ "$checkout" = 1 ] && [ "$have_uv" = 1 ]; then
    say "$uv_v — creates backend/.venv from uv.lock and fetches Python $req_py itself if the machine has none"
  elif [ "$have_uv" = 0 ] && [ -z "$py" ]; then
    die "neither uv nor a python >= $req_py was found. Install uv (https://docs.astral.sh/uv/getting-started/installation/) or Python $req_py+"
  elif [ "$checkout" = 1 ]; then
    say "no uv; $py_v — venv + pip, unpinned (uv is preferred: it installs the exact versions in backend/uv.lock — https://docs.astral.sh/uv/getting-started/installation/)"
  elif [ "$pytool" = uv ]; then
    say "$uv_v — installs the backend's pinned packages from the package index uv is set up with, and fetches Python $req_py itself if the machine has none"
  elif [ "$have_uv" = 1 ]; then
    say "pip is set up with a package index and uv is not, so pip installs the backend's pinned packages from it"
  else
    say "no uv; $py_v — venv + pip installs the backend's pinned packages from the package index pip is set up with"
  fi
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
    if [ "$dry" = 1 ]; then say "install.sh stops here: $old_node"; else die "$old_node"; fi
  fi
  if [ "$node_ok" = 1 ]; then
    if [ -n "$stale" ]; then
      say "node $node_found >= 20 — step 5 installs the frontend's packages and rebuilds frontend/dist, which is older than frontend/$stale"
    else
      say "node $node_found >= 20 — step 5 installs the frontend's packages$( [ "$has_dist" = 1 ] && echo ' (frontend/dist present)' || echo ' and builds frontend/dist' )"
    fi
  elif [ -n "$stale" ]; then
    say "frontend/dist is older than frontend/$stale, and without node >= 20 (found: $node_found) it cannot be rebuilt: the UI stays at that build until Node 20+ is installed and this script runs again"
  elif [ "$has_dist" = 1 ]; then
    say "frontend/dist present; no node >= 20 (found: $node_found), so step 5 installs no frontend packages"
  elif [ "$checkout" = 1 ]; then
    slug="$(json_get "$src/plugin/.claude-plugin/plugin.json" repository | sed -e 's#^https\{0,1\}://github\.com/##' -e 's#\.git$##')"
    die "no frontend/dist and no node >= 20 (found: $node_found). Install Node 20+ (https://nodejs.org) and re-run this script, or install from the release zip, which carries the built UI: gh release download --repo $slug --pattern 'thimble-*.zip' --dir ~/Downloads"
  else
    say "no frontend/dist and no node >= 20 (found: $node_found) — the browser UI needs a build (step 5 says how); the rest installs"
  fi
  if [ "$node_ok" != 1 ]; then
    if [ "$(uname -s)" = Darwin ]; then
      say "without node >= 20 card code gets no sandbox: the notebook kernel runs with your user's access"
    else
      say "without node >= 20 card code gets no sandbox runtime: the notebook kernel runs in bubblewrap where that works, else with your user's access"
    fi
    say "without node >= 20 a code ticket's checks run outside the sandbox, so thimble asks you before each code ticket starts"
  fi
  have_claude=0
  if command -v claude >/dev/null 2>&1; then have_claude=1; say "claude CLI $(claude --version 2>/dev/null | head -n 1)"; else say "claude CLI not on PATH — the plugin step will print the commands to run"; fi
  say "auth: thimble uses whichever auth path you have configured for claude"
}

copy_tree() {  # a release install: the release's entries replace the install's; .venv, node_modules, workspaces/, data/ and dev/ stay
  step "3/12 the tree at $dir"
  if [ "$in_place" = 1 ]; then say "in place: nothing to copy"; return 0; fi
  if [ -f "$src/RELEASE.json" ] && cmp -s "$src/RELEASE.json" "$dir/RELEASE.json"; then
    say "this release is installed there already (RELEASE.json matches, and it is copied last): nothing to copy"
    dir="$(cd "$dir" && pwd -P)"
    return 0
  fi
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
}

make_venv() {  # --python's environment linked; a linked one kept and checked; a checkout's from uv.lock (uv sync, else
  # venv + pip from pyproject); a release's from backend/requirements.txt (release_venv)
  step "4/12 backend/.venv (the server's Python and dependencies)"
  local venv="$dir/backend/.venv" lacking
  extra=(); if [ "$dev" = 1 ]; then extra=(--extra dev); fi
  if [ -n "$byo" ] && [ "$venv" -ef "$byo_prefix" ]; then
    say "backend/.venv is $byo_prefix already; used as it is"
  elif [ -n "$byo" ]; then
    run ln -sfn "$byo_prefix" "$venv"
    say "backend/.venv → $byo_prefix: your environment, used as it is; nothing is installed into it"
  elif [ -L "$venv" ]; then
    say "backend/.venv → $(readlink "$venv"): an environment of your own (install.sh --python), used as it is"
    if [ "$dry" = 0 ] && ! lacking="$(cd / && "$venv/bin/python" -I -B "$src/backend/app/env_check.py" "$src/backend/pyproject.toml" 2>&1)"; then
      say "it lacks what this version of the backend needs; the server may not start until these are installed into it:"
      say "$lacking"
    fi
  elif [ "$checkout" = 0 ]; then
    release_venv
  elif [ "$have_uv" = 1 ] && [ -f "$src/backend/uv.lock" ]; then
    run_in "$dir/backend" uv sync --frozen --no-dev --no-install-project ${extra[@]+"${extra[@]}"}
  elif [ "$have_uv" = 1 ]; then
    [ "$require_pinned" = 0 ] || die "backend/uv.lock is missing, so nothing pins the backend's versions, and --require-pinned installs only pinned ones"
    say "backend/uv.lock is missing: resolving fresh (not the pinned versions)"
    run_in "$dir/backend" uv sync --no-dev --no-install-project ${extra[@]+"${extra[@]}"}
  else
    [ "$require_pinned" = 0 ] || die "without uv the backend's pinned versions (backend/uv.lock) can't be installed, and --require-pinned installs only pinned ones; install uv (https://docs.astral.sh/uv/getting-started/installation/)"
    [ -x "$venv/bin/python" ] || run "$py" -I -m venv "$venv"
    say "pip from pyproject.toml (the minimum versions, not the pinned ones in uv.lock)"
    run "$venv/bin/python" -I -m pip install --quiet --upgrade pip
    if [ "$dev" = 1 ]; then run "$venv/bin/python" -I -m pip install --quiet -e "$dir/backend[dev]"; else run "$venv/bin/python" -I -m pip install --quiet -e "$dir/backend"; fi
  fi
}

logged() {  # logged LOG CMD…: run's printing and running, with the command's output also written to LOG
  local log="$1"; shift
  printf '+'; printf ' %q' "$@"; printf '\n'
  [ "$dry" = 1 ] || "$@" 2>&1 | tee "$log"
}

new_venv() {  # new_venv VENV: a release's backend/.venv, made by uv, else by the venv module, with pip in it when pip installs
  local venv="$1" clear=()
  [ ! -e "$venv" ] || clear=(--clear)  # a venv whose python no longer runs
  if [ "$pytool" = pip ] && [ -n "$py" ]; then
    run "$py" -I -m venv ${clear[@]+"${clear[@]}"} "$venv"
  else
    run uv venv --quiet ${clear[@]+"${clear[@]}"} --python ">=$req_py" "$venv"
    [ "$pytool" = uv ] || run "$venv/bin/python" -I -m ensurepip --quiet
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
  py_install "$tmp/py.log" "$@" || die "the backend's packages could not be installed (above)"
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
  if [ "$dev" = 0 ] && [ -f "$req" ] && cmp -s "$req" "$stamp" && (cd / && "$venv/bin/python" -I -c '') 2>/dev/null; then
    say "backend/.venv holds the packages backend/requirements.txt pins, installed by an earlier run"
    return 0
  fi
  if ! { [ -x "$venv/bin/python" ] && (cd / && "$venv/bin/python" -I -c '') 2>/dev/null; }; then new_venv "$venv"
  elif [ "$pytool" = pip ] && ! (cd / && "$venv/bin/python" -I -c 'import pip') 2>/dev/null; then
    run "$venv/bin/python" -I -m ensurepip --quiet  # a venv an earlier install made with uv, which holds no pip
  fi
  if [ ! -f "$req" ]; then
    [ "$require_pinned" = 0 ] || die "no backend/requirements.txt, so nothing pins the backend's versions, and --require-pinned installs only pinned ones"
    say "no backend/requirements.txt, so nothing pins the versions: those backend/pyproject.toml allows"
    py_ranges all
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
  elif grep -qE 'Hash mismatch|DO NOT MATCH THE HASHES' "$tmp/py.log"; then
    die "the package index served a file whose hash is not the one backend/requirements.txt pins (above), so nothing more is installed from it"
  elif [ "$require_pinned" = 1 ]; then
    die "the package index lacks a version backend/requirements.txt pins (above), and --require-pinned installs only pinned versions"
  else
    say "the package index lacks a version backend/requirements.txt pins (above)"
    if [ "$pytool" != uv ] || ! prefer_pins "$req"; then
      say "so install.sh installs the newest versions backend/pyproject.toml allows that the index has"
      py_ranges all
    fi
    py_differs "$req"
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

system_browser() {  # sys_channel, sys_name, sys_path: the Chrome or Edge that Playwright's chrome and msedge channels
  # launch, found where those channels look; all empty when neither is there
  local e c n p entries=()
  sys_channel="" sys_name="" sys_path=""
  case "$(uname -s)" in
    Darwin) entries=("chrome|Google Chrome|/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                     "msedge|Microsoft Edge|/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");;
    Linux) entries=("chrome|Google Chrome|/opt/google/chrome/chrome" "msedge|Microsoft Edge|/opt/microsoft/msedge/msedge");;
  esac
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
  "$py" -I - "$home/config.json" "$1" <<'PY' || say "(the answer was not recorded, so a later run asks again)"
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
  # the headless Chromium), since a bare Linux server may lack the system libraries a downloaded one links
  local venv="$dir/backend/.venv" why
  [ "$dry" = 1 ] && return 0
  "$venv/bin/python" -I -c 'import playwright' 2>/dev/null || return 0
  why="$("$venv/bin/python" -I - "${1:-}" 2>&1 <<'PY'
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
  if [ -z "$why" ]; then
    say "it starts"
  elif printf '%s' "$why" | grep -qiE 'missing dependencies|install-deps'; then
    say "it was fetched, but this machine lacks the system libraries it needs; there are no screenshots until you run:"
    say "  sudo $venv/bin/python -m playwright install-deps chromium-headless-shell"
  elif [ -n "${1:-}" ]; then
    say "it did not start under automation ($why), which a policy on this machine can block; there are no screenshots until that is fixed, or until install.sh --browser bundled downloads Playwright's headless Chromium"
  else
    say "it did not start ($why); there are no screenshots until that is fixed"
  fi
}

fetch_bundled() {  # the headless Chromium each of thimble's Playwrights launches: the backend's (the card harness,
  # backend/app/render.py) and the frontend's (a view's checks and the screenshots, scripts/view_shot.mjs and ui_shot.mjs),
  # which pin different builds; one already in Playwright's cache is not fetched again
  local venv="$dir/backend/.venv" fe="$dir/frontend" loc what pw
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
    elif ! run "${pw[@]}" install chromium-headless-shell; then
      say "(the download failed; the $what has no browser until this script runs again)"
    fi
  done
}

browser_step() {  # the answer to the browser question (ask): the system Chrome or Edge, nothing downloaded; Playwright's
  # headless Chromium, downloaded only on that answer; or none. A new answer is recorded in config.json
  step "6/12 a browser for screenshots"
  local choice="${browser:-$browser_was}"
  case "$choice" in
    system)
      if [ -n "$sys_path" ]; then
        say "$sys_name at $sys_path (Playwright's $sys_channel channel): nothing is downloaded"
        launch_check "$sys_channel"
      else
        say "no Chrome or Edge where Playwright looks for one, so there are no screenshots until one is installed there or install.sh --browser bundled runs"
      fi;;
    bundled)
      say "Playwright's headless Chromium, in $(pw_cache)"
      fetch_bundled
      launch_check;;
    off)
      say "off: no screenshots, so thimble can't check and improve its cards and views. install.sh --browser bundled or --browser system turns them on";;
    *)
      if [ "$dry" = 1 ]; then
        say "(the answer to the browser question, above)"
      else
        say "not asked (no terminal), so nothing is downloaded: thimble uses $sys_name at $sys_path. For the best experience, install.sh --browser bundled downloads Playwright's headless Chromium"
        launch_check "$sys_channel"
      fi;;
  esac
  if [ -n "$browser" ] && [ "$browser" != "$browser_was" ]; then record_browser "$browser"; fi
}

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

sandbox_text() {  # the sandbox question
  say "thimble's agents run their Bash only in Claude Code's sandbox, which on Linux needs $sb_need. install.sh can install them now by running:"
  printf '  %s\n' "${sb_cmds[@]}"
  say "With a no, thimble's agents won't run until the sandbox works. \`thimble uninstall\` leaves these installed."
}

sandbox_later() {  # what a sandbox that can't run means, and how to set it up later
  if [ "${#sb_cmds[@]}" -gt 0 ]; then
    say "thimble's agents won't run until the sandbox works. To set it up later, run: bash $dir/scripts/install.sh --sandbox-deps"
  else
    say "thimble's agents won't run until the sandbox works; \`thimble doctor\` shows when it does."
  fi
}

sandbox_step() {  # the sandbox question's answer, right after the questions so that sudo asks for its password while the
  # user is at the terminal: sandbox_plan's root commands on a yes, then whether the sandbox runs
  step "2/12 the agents' Bash sandbox"
  local c upd
  if [ "$sb_ok" = 1 ]; then
    say "Claude Code's Bash sandbox $( [ "$(uname -s)" = Linux ] && echo 'runs here' || echo 'is built into macOS' ): nothing to install"
    return 0
  fi
  if [ "${#sb_cmds[@]}" = 0 ]; then say "Claude Code's Bash sandbox can't run here: $sb_why."; sandbox_later; return 0; fi
  if [ "$sandbox_deps" != yes ]; then
    if [ "$dry" = 1 ] && [ -z "$sandbox_deps" ]; then say "(the answer to the sandbox question, above)"; return 0; fi
    say "Claude Code's Bash sandbox lacks $sb_need, and you answered no to installing it."
    sandbox_later
    return 0
  fi
  if [ "$dry" = 0 ] && [ "$tty" = 0 ] && [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then
    say "sudo needs your password, which install.sh can't ask for without a terminal. Run these in a terminal, then \`thimble doctor\`:"
    printf '  %s\n' "${sb_cmds[@]}"
    sandbox_later
    return 0
  fi
  for c in "${sb_cmds[@]}"; do
    say "+ $c"
    [ "$dry" = 0 ] || continue
    bash -c "$c" && continue
    if [ "$sb_pm" = apt-get ] && [ "$c" = "${sb_cmds[0]}" ]; then  # the package lists may predate the packages
      upd="${c%%apt-get install*}apt-get update"
      say "+ $upd"
      if bash -c "$upd" && say "+ $c" && bash -c "$c"; then continue; fi
    fi
    say "(that failed, above)"
    break
  done
  [ "$dry" = 0 ] || return 0
  if sandbox_runs; then say "Claude Code's Bash sandbox runs now"; else say "Claude Code's Bash sandbox still doesn't run."; sandbox_later; fi
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
  # failed; a file whose hash is not the pinned one stops the install (npm_integrity).
  local fe="$dir/frontend" stamp="$dir/frontend/node_modules/.thimble-package-lock.json"
  if [ -L "$fe/node_modules" ]; then
    say "frontend/node_modules is a symlink → $(readlink "$fe/node_modules"); left alone"
  elif [ "$checkout" = 0 ] && [ "$has_dist" = 1 ] && [ -f "$src/frontend/runtime/package-lock.json" ]; then
    runtime_packages || return 1
  elif [ -f "$stamp" ] && cmp -s "$fe/package-lock.json" "$stamp"; then
    say "frontend/node_modules matches package-lock.json"
  elif [ "$checkout" = 1 ] && [ ! -f "$stamp" ] && [ -f "$fe/node_modules/.package-lock.json" ] \
       && [ ! "$fe/package-lock.json" -nt "$fe/node_modules/.package-lock.json" ]; then
    say "frontend/node_modules present, installed after the last change to package-lock.json: kept"
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
  else
    logged "$tmp/npm.log" npm ci --prefix "$fe" --no-audit --no-fund || { npm_integrity package-lock.json; return 1; }
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
  fi
}

npm_integrity() {  # npm_integrity LOCKFILE: stop when npm's failure (in $tmp/npm.log) was a file whose hash is not the one
  # LOCKFILE pins
  if grep -q EINTEGRITY "$tmp/npm.log" 2>/dev/null; then
    die "the npm registry served a file whose hash is not the one frontend/$1 pins (above), so nothing more is installed from it"
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
    return 0
  fi
  say "the frontend's packages the server loads (frontend/runtime/package.json); the UI is built already"
  if logged "$tmp/npm.log" npm ci --prefix "$rt" --no-audit --no-fund; then
    pinned=1
  else
    npm_integrity runtime/package-lock.json
    [ "$require_pinned" = 0 ] || die "the npm registry lacks a version frontend/runtime/package-lock.json pins (above), and --require-pinned installs only pinned versions"
    say "the registry lacks a version frontend/runtime/package-lock.json pins (above), so install.sh installs the newest versions frontend/runtime/package.json allows that the registry has"
    run npm install --prefix "$rt" --no-audit --no-fund --no-package-lock || return 1
    pinned=0
  fi
  say "+ mv $rt/node_modules $fe/node_modules"
  [ "$dry" = 1 ] || { rm -rf "$fe/node_modules"; mv "$rt/node_modules" "$fe/node_modules"; }
  if [ "$pinned" = 1 ]; then
    say "+ cp $rt/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$rt/package-lock.json" "$stamp"
  else
    npm_differs
  fi
}

build_ui() {  # with node >= 20 the frontend's packages, which custom views need; a checkout's frontend/dist older than
  # its sources is rebuilt (scripts/rebuild_ui.sh, which swaps the build in under a running server), any other existing
  # frontend/dist is kept, and without one the typecheck and vite build make it
  step "5/12 frontend"
  if [ "$node_ok" = 1 ] && ! install_packages; then
    [ "$has_dist" = 1 ] || die "npm ci failed in $dir/frontend (above), so the UI cannot be built; fix that and run this script again"
    say "(npm failed, above: custom views need the frontend's packages, so run this script again)"
    stale=""
  fi
  if [ -n "$stale" ] && [ "$node_ok" = 1 ]; then
    say "rebuilding frontend/dist, which is older than frontend/$stale"
    run bash "$dir/scripts/rebuild_ui.sh" --frontend "$dir/frontend" \
      || say "(the rebuild failed, above: frontend/dist stays at the earlier build, older than the sources; fix the build and run this script again)"
  elif [ "$has_dist" = 1 ]; then
    say "built UI at frontend/dist — the server serves it at its own port when THIMBLE_DEV is off (to rebuild after a source change: npx vite build in frontend/)"
  elif [ "$node_ok" = 1 ]; then
    say "building frontend/dist (the server serves it at its own port when THIMBLE_DEV is off)"
    run_in "$dir/frontend" npx tsc --noEmit -p tsconfig.app.json
    run_in "$dir/frontend" npx vite build
  else
    say "the browser UI needs a build: install Node 20+ (https://nodejs.org) and re-run this script, or install from a release zip that carries frontend/dist. The MCP tools work without it"
  fi
  [ "$node_ok" = 1 ] || say "custom views and the sandbox card code and code tickets run in need Node 20+ (https://nodejs.org): install it, then run this script again"
}

write_pointer() {  # $THIMBLE_HOME/app-dir: how the plugin copy in Claude Code's plugin cache finds this tree (plugin/bin/thimble-app-dir)
  step "7/12 $home/app-dir → $dir"
  run mkdir -p "$home"
  run chmod 700 "$home"
  say "+ printf '%s\\n' $dir > $home/app-dir"
  [ "$dry" = 1 ] || printf '%s\n' "$dir" > "$home/app-dir"
}

link_cli() {  # ~/.local/bin/thimble → <tree>/plugin/bin/thimble, so `thimble` is a command once that folder is on PATH (finish
  # says whether it is). What cli_plan found there decides: a link into another install stays unless a yes switched it,
  # and anything else that is not a link into a thimble tree (another program) is left alone
  step "8/12 thimble on PATH"
  local bin="$bin_dir" target="$dir/plugin/bin/thimble"
  cli_linked=0
  case "$cli_state" in
    foreign)
      say "$cli_link exists and is not a link into a thimble tree; left alone — the command stays at $target"
      return 0;;
    other)
      if [ "$cli_switch" != yes ]; then cli_switch_line; return 0; fi;;
    gone) say "$cli_link was a link into $cli_other, which is gone; it now runs this install";;
  esac
  # the link is a convenience: when ~/.local/bin cannot be written the install still succeeds, and the command stays in the tree
  { run mkdir -p "$bin" && run ln -sfn "$target" "$cli_link"; } || { say "could not create $cli_link; the command stays at $target"; return 0; }
  cli_linked=1
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

plugin_regs() {  # the thimble plugins Claude Code lists, a line each: ours or other, the marketplace, and the folder that
  # marketplace was added from (else what its source is). Only a marketplace added from this install's folder is ours.
  # Fails when the lists can't be read
  [ "$have_claude" = 1 ] && command -v python3 >/dev/null 2>&1 || return 1
  claude plugin list --json > "$tmp/plugins.json" 2>/dev/null || return 1
  claude plugin marketplace list --json > "$tmp/markets.json" 2>/dev/null || return 1
  python3 -I - "$tmp/plugins.json" "$tmp/markets.json" "$dir" <<'PY'
import json, os, sys


def rows(path):
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit(1)
    return [r for r in data if isinstance(r, dict)]


plugins, markets = rows(sys.argv[1]), rows(sys.argv[2])
where = {}
for m in markets:
    src = m.get("source")
    kind, path = (src.get("source"), src.get("path")) if isinstance(src, dict) else (src, m.get("path"))
    if kind == "directory" and isinstance(path, str) and path:
        where[m.get("name")] = os.path.realpath(path)
    else:
        where[m.get("name")] = " ".join(str(v) for v in (kind, m.get("repo") or m.get("url")) if v) or "an unknown source"
mine = os.path.realpath(sys.argv[3])
for p in plugins:
    name, _, market = str(p.get("id", "")).partition("@")
    if name == "thimble" and market:
        w = where.get(market, "a marketplace Claude Code does not list")
        print("ours" if w == mine else "other", market, w, sep="\t")
PY
}

plugin_record() {  # the earlier answer to the plugin question ($home/plugin.json) and the thimble plugins Claude Code has:
  # plugin_reg, the marketplace of the one added from this install's folder, the only registration install.sh changes
  # unasked; other_reg and other_from, one added from anywhere else, which is another install's. Without the record,
  # this install's own registration counts as an earlier yes. When Claude Code's lists can't be read, plugin_kept is the
  # registration the record names, which is then left as it is
  plugin_prev="" plugin_reg="" plugin_kept="" plugin_switch="" other_reg="" other_from=""
  local regs kind m w
  [ ! -f "$home/plugin.json" ] || plugin_prev="$(json_get "$home/plugin.json" answer)"
  if regs="$(plugin_regs)"; then
    while IFS=$'\t' read -r kind m w; do
      if [ "$kind" = ours ]; then plugin_reg="$m"
      elif [ "$kind" = other ] && [ -z "$other_reg" ]; then other_reg="$m" other_from="$w"; fi
    done <<< "$regs"
    [ -f "$home/plugin.json" ] || [ -z "$plugin_reg" ] || plugin_prev=yes
  elif [ -f "$home/plugin.json" ]; then
    plugin_kept="$(json_get "$home/plugin.json" registered)"
  fi
}

other_plugin() {  # the line naming another install's thimble plugin
  printf '%s\n' "Claude Code's thimble plugin is another install's: thimble@$other_reg, from $other_from."
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
  printf '%s\n' "$cli_link runs the thimble install in $cli_other, so it is left as it is. To make \`thimble\` run this install: ln -sfn $(printf '%q' "$dir/plugin/bin/thimble") $(printf '%q' "$cli_link")"
}

asks() { [ "$dry" = 0 ] && [ -t 0 ]; }  # questions are asked on a terminal

yes_no() {  # yes_no DEFAULT: read an answer from the terminal; 0 for yes, DEFAULT (y or n) for an empty one
  local ans; read -r ans || ans=""
  case "${ans:-$1}" in y | Y | yes | YES | Yes) return 0;; *) return 1;; esac
}

cc_path() {  # cc_path NAME: NAME in Claude Code's config folder, as ~/.claude/NAME when that is the folder
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then printf '%s\n' "${CLAUDE_CONFIG_DIR%/}/$1"; else printf '%s\n' "~/.claude/$1"; fi
}

show_plan() {  # what the install puts where, before its questions
  local cc_json="~/.claude.json"
  [ -z "${CLAUDE_CONFIG_DIR:-}" ] || cc_json="${CLAUDE_CONFIG_DIR%/}/.claude.json"
  step "what install.sh installs, and where"
  if [ "$in_place" = 1 ]; then say "  thimble $version, in place at $dir"; else say "  thimble $version, copied into $dir"; fi
  if [ -n "$byo" ]; then say "  the server's Python: your environment $byo_prefix, linked as backend/.venv; nothing is installed into it"
  elif [ "$checkout" = 1 ] && [ "$have_uv" = 1 ]; then say "  the server's Python packages: $dir/backend/.venv, from backend/uv.lock"
  else say "  the server's Python packages: $dir/backend/.venv, from the package index $pytool is set up with"; fi
  if [ "$node_ok" = 1 ]; then
    say "  the frontend's packages custom views and the sandbox for card code and code tickets (Anthropic's sandbox runtime) need: $dir/frontend/node_modules$( [ "$has_dist" = 1 ] || echo ', and the UI built into frontend/dist' )"
  fi
  say "  thimble's settings and state: $home"
  if [ "$cli_state" = other ]; then
    say "  the \`thimble\` command: ~/.local/bin/thimble runs another install ($cli_other); $(asks && echo 'install.sh asks before switching it' || echo 'it stays as it is')"
  elif [ "$deps_only" = 0 ]; then say "  the \`thimble\` command: a link at ~/.local/bin/thimble"; fi
  local chosen="${browser:-$browser_was}" asked=()
  case "$chosen" in
    system) [ -z "$sys_path" ] || say "  a browser for screenshots: $sys_name at $sys_path, nothing downloaded";;
    bundled) say "  a browser for screenshots: Playwright's headless Chromium, downloaded into $(pw_cache) ($BUNDLED_SIZE)";;
    off) ;;
    *) asked+=("a browser for screenshots: Playwright's headless Chromium, downloaded into $(pw_cache) ($BUNDLED_SIZE)");;
  esac
  if [ "${#sb_cmds[@]}" -gt 0 ]; then
    if [ "$sandbox_deps" = yes ]; then say "  the sandbox's system packages: $sb_need"
    elif [ -z "$sandbox_deps" ]; then asked+=("the sandbox's system packages: $sb_need"); fi
  fi
  if [ "$deps_only" = 0 ]; then
    if [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
      say "  $(other_plugin) $( [ "${plugin:-$plugin_prev}" != no ] && asks && echo 'On a yes install.sh asks before switching it to this install.' || echo 'It stays as it is.')"
    fi
    if [ "${plugin:-$plugin_prev}" = yes ] && [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then :
    elif [ "${plugin:-$plugin_prev}" = yes ]; then say "  thimble's plugin in every Claude Code session: $(cc_path settings.json) and $(cc_path plugins)"
    elif [ -z "$plugin$plugin_prev" ] && [ "$have_claude" = 1 ]; then asked+=("thimble's plugin in every Claude Code session: $(cc_path settings.json) and $(cc_path plugins)"); fi
    if [ "$trust" = --yes ]; then say "  Claude Code's trust of thimble's workspaces folder: $cc_json"
    elif [ -z "$trust" ] && [ -n "$trust_q" ]; then asked+=("Claude Code's trust of thimble's workspaces folder: $cc_json"); fi
  fi
  local a skipped=()
  if [ "${#asked[@]}" -gt 0 ]; then
    say "  and only on a yes to its question:"
    for a in "${asked[@]}"; do say "  - $a"; done
  fi
  [ -n "$browser" ] || [ -z "$browser_skip" ] || skipped+=("the browser: $browser_skip")
  if [ "$deps_only" = 0 ]; then
    [ -n "$plugin" ] || [ -z "$plugin_skip" ] || skipped+=("the plugin: $plugin_skip")
    [ -z "$trust_skip" ] || skipped+=("the trust: $trust_skip")
  fi
  [ "${#skipped[@]}" -gt 0 ] || return 0
  say "  questions install.sh does not ask this time:"
  for a in "${skipped[@]}"; do say "  - $a"; done
}

browser_text() {  # the browser question's explanation, after probe_browser
  say "A browser for screenshots. thimble takes screenshots of the cards and views it draws, to check and improve them. For the best experience, install Playwright's headless Chromium ($BUNDLED_SIZE, in $(pw_cache); not downloaded again when it is there already)."
  if [ -z "$sys_path" ]; then
    say "No Chrome or Edge was found, so without it thimble can't take screenshots, and can't check and improve its cards and views."
  elif [ "$sys_starts" = 1 ]; then
    say "With a no, thimble falls back to $sys_name at $sys_path, which starts under automation here."
  else
    say "With a no, thimble falls back to $sys_name at $sys_path, but it did not start under automation here, which a policy on this machine can block, so the download is recommended."
  fi
}

plugin_text() {  # the plugin question
  say "Add thimble to $(cc_path settings.json) and $(cc_path plugins), so it is available in every claude session from startup? The \`thimble\` command works either way, and \`thimble uninstall\` removes it."
}

earlier_answers() {  # what settles each question before it is asked: the browser and plugin answers of an earlier
  # install, and the trust question when one is due; for each question that is not asked, why, naming the folder
  # (browser_skip, plugin_skip, trust_skip)
  browser_was="$(browser_prev)" browser_skip="" plugin_prev="" plugin_reg="" plugin_skip="" trust_skip=""
  plugin_kept="" plugin_switch="" other_reg="" other_from="" cli_state="" cli_other="" cli_switch=""
  if [ -n "$browser_was" ]; then
    if [ -f "$home/config.json" ] && [ "$(json_get "$home/config.json" browser 2>/dev/null)" = "$browser_was" ]; then
      browser_skip="answered $browser_was at your earlier install ($home/config.json); --browser changes it"
    else
      browser_skip="bundled, since your earlier install in $dir downloaded Playwright's headless Chromium; --browser changes it"
    fi
  fi
  [ "$deps_only" = 1 ] || { plugin_record; cli_plan; }
  if [ -n "$plugin_prev" ]; then
    local other=--no-plugin
    [ "$plugin_prev" = yes ] || other=--plugin
    if [ -f "$home/plugin.json" ]; then plugin_skip="answered $plugin_prev at your earlier install ($home/plugin.json); $other changes it"
    else plugin_skip="yes, since Claude Code has thimble@$plugin_reg registered from $dir already ($(cc_path plugins)); --no-plugin changes it"; fi
  fi
  trust_q=""  # the trust question when claude_changes.install_trust would ask it (python3 runs the file before
  # backend/.venv exists; without python3 the trust step asks it)
  if [ "$deps_only" = 0 ] && [ -z "$trust" ] && command -v python3 >/dev/null 2>&1; then
    trust_q="$(THIMBLE_HOME="$home" python3 -I "$src/backend/app/claude_changes.py" question "$dir" 2>/dev/null)" || trust_q=""
    [ -n "$trust_q" ] || trust_skip="$(THIMBLE_HOME="$home" python3 -I "$src/backend/app/claude_changes.py" skipped "$dir" 2>/dev/null)" || trust_skip=""
  fi
}

item() {  # item N TEXT: TEXT as the dry run's question N, its later lines indented under the first
  printf '%s\n' "$2" | sed -e "1s/^/$1. /" -e '2,$s/^/   /'
}

ask() {  # the questions, before anything is installed: the browser, the sandbox's system packages, the plugin, the
  # trust. Each is asked on a terminal when neither its flag nor an earlier answer settles it (earlier_answers);
  # --dry-run prints them with their flags instead, and without a terminal install.sh stops while one is unanswered
  local need=()
  tty=0
  if [ "$dry" = 1 ]; then
    step "the questions install.sh asks on a terminal, and the flag that gives each answer"
    if [ -n "$browser" ]; then say "1. the browser: answered by --browser $browser"
    elif [ -n "$browser_was" ]; then say "1. the browser: $browser_skip"
    else
      probe_browser
      item 1 "$(browser_text)"
      say "   - yes, download it: --browser bundled"
      [ -z "$sys_path" ] || say "   - no, use $sys_name: --browser system"
      say "   - no browser: --browser off"
    fi
    if [ "${#sb_cmds[@]}" = 0 ]; then say "2. the sandbox's system packages: not asked, since $( [ "$sb_ok" = 1 ] && echo 'the sandbox runs here' || echo "$sb_why" )"
    elif [ -n "$sandbox_deps" ]; then say "2. the sandbox's system packages: answered by --$( [ "$sandbox_deps" = yes ] || echo 'no-' )sandbox-deps"
    else item 2 "$(sandbox_text)"; say "   - yes: --sandbox-deps"; say "   - no: --no-sandbox-deps"; fi
    [ "$deps_only" = 0 ] || return 0
    if [ -n "$plugin" ]; then say "3. the plugin: answered by --$( [ "$plugin" = yes ] || echo 'no-' )plugin"
    elif [ -n "$plugin_prev" ]; then say "3. the plugin: $plugin_skip"
    elif [ "$have_claude" = 0 ]; then say "3. the plugin: not asked, since there is no claude CLI"
    else say "3. $(plugin_text)"; say "   - yes: --plugin"; say "   - no: --no-plugin"; fi
    if [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
      say "   $(other_plugin) It stays as it is unless you agree, on a terminal, to switch it to this install."
    fi
    if [ -n "$trust" ]; then say "4. the trust: answered by --$( [ "$trust" = --yes ] || echo 'no-' )trust-workspaces"
    elif [ -n "$trust_q" ]; then item 4 "$trust_q"; say "   - yes: --trust-workspaces"; say "   - no: --no-trust-workspaces"
    elif [ -n "$trust_skip" ]; then say "4. the trust: $trust_skip"
    else say "4. the trust: asked at the trust step; --trust-workspaces or --no-trust-workspaces answers it"; fi
    [ "$cli_state" != other ] || say "5. the \`thimble\` command: ~/.local/bin/thimble runs the install in $cli_other. It stays as it is unless you agree, on a terminal, to switch it to this install."
    return 0
  fi
  [ -t 0 ] && tty=1
  if [ "$tty" = 0 ]; then
    [ -n "$browser$browser_was$sys_path" ] || need+=("the browser: --browser bundled or --browser off")
    [ "${#sb_cmds[@]}" = 0 ] || [ -n "$sandbox_deps" ] || need+=("the sandbox's system packages: --sandbox-deps or --no-sandbox-deps")
    if [ "$deps_only" = 0 ]; then
      [ -n "$plugin$plugin_prev" ] || [ "$have_claude" = 0 ] || need+=("the plugin: --plugin or --no-plugin")
      if [ -z "$trust" ] && { [ -n "$trust_q" ] || ! command -v python3 >/dev/null 2>&1; }; then
        need+=("the trust: --trust-workspaces or --no-trust-workspaces")
      fi
    fi
    local again="bash $src/scripts/install.sh --dry-run prints the questions; then run install.sh again with a flag for each."
    if [ "$src" != "$dir" ] && earlier_install; then
      again="Ask them, then run \`thimble update\` again with a flag for each, which it passes on to install.sh. An install older than 0.3.0 has a \`thimble update\` that takes no flags: unzip the release and run its scripts/install.sh --dir $dir with the flags."
    fi
    [ "${#need[@]}" = 0 ] || die "there is no terminal to ask on, so each question needs its answer as a flag. Not answered:
$(printf '  %s\n' "${need[@]}")
$again"
    return 0
  fi
  if [ -z "$browser" ] && [ -z "$browser_was" ]; then
    probe_browser
    printf '\n'; browser_text
    printf "Download Playwright's headless Chromium? [Y/n] "
    if yes_no y; then browser=bundled; elif [ -n "$sys_path" ]; then browser=system; else browser=off; fi
  fi
  if [ "${#sb_cmds[@]}" -gt 0 ] && [ -z "$sandbox_deps" ]; then
    printf '\n'; sandbox_text
    printf 'Install them now? [Y/n] '
    if yes_no y; then sandbox_deps=yes; else sandbox_deps=no; fi
  fi
  [ "$deps_only" = 0 ] || return 0
  if [ -z "$plugin" ] && [ -z "$plugin_prev" ] && [ "$have_claude" = 1 ]; then
    printf '\n%s [y/N] ' "$(plugin_text)"
    if yes_no n; then plugin=yes; else plugin=no; fi
  fi
  if [ "${plugin:-$plugin_prev}" = yes ] && [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    printf '\n%s Switch it to this install? [y/N] ' "$(other_plugin)"
    if yes_no n; then plugin_switch=yes; fi
  fi
  if [ -n "$trust_q" ]; then
    printf '\n%s [y/N] ' "$trust_q"
    if yes_no n; then trust=--yes; else trust=--no; fi
  fi
  if [ "$cli_state" = other ]; then
    printf '\n~/.local/bin/thimble runs the thimble install in %s. Make `thimble` run this install instead? [y/N] ' "$cli_other"
    if yes_no n; then cli_switch=yes; fi
  fi
}

register_plugin() {  # the plugin question's answer: yes registers the tree as a marketplace and installs thimble from it at
  # user scope, then updates both so a re-run refreshes Claude Code's cached copy; no takes back what an earlier yes
  # registered. $home/plugin.json keeps the answer and what is registered, for later runs and `thimble uninstall`
  step "9/12 thimble's plugin in every Claude Code session"
  local mp_file="$dir/.claude-plugin/marketplace.json" answer="$plugin" left="" why='no terminal'
  if [ "$mp_name" != "$mp_file_name" ]; then
    say "+ set .name = \"$mp_name\" in $mp_file"
    [ "$dry" = 1 ] || python3 -I -c 'import json,sys; p,n=sys.argv[1:]; d=json.load(open(p)); d["name"]=n; json.dump(d, open(p,"w"), indent=2); open(p,"a").write("\n")' "$mp_file" "$mp_name"
  fi
  if [ -z "$answer" ] && [ -n "$plugin_prev" ]; then
    answer="$plugin_prev"
    if [ -f "$home/plugin.json" ]; then say "answered $answer at an earlier install; install.sh --plugin or --no-plugin changes it"
    else say "registered by an earlier install; kept (install.sh --no-plugin takes it back)"; fi
  fi
  if [ -n "$other_reg" ] && [ "$plugin_switch" != yes ]; then
    say "$(other_plugin) It is left as it is."
    if [ "$answer" = yes ] && [ -z "$plugin_reg" ]; then
      say "So this install's plugin is not added beside it. To switch to this install, run claude plugin uninstall thimble@$other_reg && claude plugin marketplace remove $other_reg, then this install.sh again"
      plugin_write yes ""
      return 0
    fi
  fi
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ] && [ "$plugin_reg" = "$mp_name" ] && [ "$(plugin_listed)" = "$version" ]; then
    say "thimble@$mp_name $version is registered already: nothing to do"
    return 0
  fi
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ]; then
    if [ -n "$plugin_reg" ] && [ "$plugin_reg" != "$mp_name" ]; then  # this folder, registered under another name
      { run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; } \
        || say "(thimble@$plugin_reg, which an earlier install registered, is still there: claude plugin uninstall thimble@$plugin_reg && claude plugin marketplace remove $plugin_reg takes it back)"
    fi
    if [ "$plugin_switch" = yes ] && ! { run claude plugin uninstall "thimble@$other_reg" && run claude plugin marketplace remove "$other_reg"; }; then
      say "(thimble@$other_reg, from $other_from, could not be taken out, so this install's plugin is not added beside it)"
      plugin_write yes ""
      return 0
    fi
    run claude plugin marketplace add "$dir" || die "could not register $dir as marketplace \"$mp_name\". A marketplace of that name may point elsewhere: \`claude plugin marketplace list\`, then \`claude plugin marketplace remove $mp_name\` or re-run with --marketplace-name <other>"
    run claude plugin marketplace update "$mp_name" || say "(marketplace update failed; continuing)"
    run claude plugin install --scope user "thimble@$mp_name" || die "claude plugin install thimble@$mp_name failed"
    run claude plugin update --scope user "thimble@$mp_name" || say "(plugin update failed; the installed copy stays as it is)"
    plugin_write yes "$mp_name"
    say "thimble's plugin loads in every Claude Code session, and /thimble works in any"
    return 0
  fi
  if [ "$answer" = yes ]; then
    say "no claude CLI, so nothing is registered. Once it is installed, run:"
    say "  claude plugin marketplace add $dir"
    say "  claude plugin install --scope user thimble@$mp_name"
    return 0
  fi
  if [ "$answer" != no ]; then
    [ "$have_claude" = 1 ] || why='no claude CLI'; [ "$dry" = 0 ] || why='dry run'
    say "not asked ($why), so not registered: the \`thimble\` command loads the plugin for its own sessions. install.sh --plugin adds it to every session, --no-plugin records a no"
    return 0
  fi
  left="${plugin_reg:-$plugin_kept}"
  if [ -n "$plugin_reg" ] && run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; then left=""; fi
  [ -z "$left" ] || say "(the registration an earlier yes added is still there: claude plugin uninstall thimble@$left && claude plugin marketplace remove $left takes it back)"
  plugin_write no "$left"
  say "not registered: the \`thimble\` command loads the plugin for its own sessions. install.sh --plugin adds it to every session"
}

plugin_listed() {  # the version of thimble@$mp_name that Claude Code lists, or nothing
  command -v python3 >/dev/null 2>&1 || return 0
  claude plugin list --json 2>/dev/null | python3 -I -c 'import json, sys
try:
    rows = json.load(sys.stdin)
except ValueError:
    rows = []
print(next((r.get("version") or "" for r in rows if isinstance(r, dict) and r.get("id") == sys.argv[1]), ""))' "thimble@$mp_name" || true
}

plugin_write() {  # plugin_write ANSWER REGISTERED: $home/plugin.json
  say "+ record in $home/plugin.json: answer $1${2:+, registered thimble@$2}"
  [ "$dry" = 1 ] || printf '{"answer": "%s", "registered": "%s"}\n' "$1" "$2" > "$home/plugin.json"
}

trust_workspaces() {  # the one entry thimble writes into Claude Code's global config, asked once (backend/app/claude_changes.py)
  step "10/12 Claude Code's trust of thimble's workspaces folder"
  if [ "$dry" = 1 ]; then say "(the answer to the trust question, above: --trust-workspaces adds the entry, --no-trust-workspaces takes back one an earlier yes added)"; return 0; fi
  THIMBLE_HOME="$home" "$dir/backend/.venv/bin/python" -I "$dir/backend/app/claude_changes.py" trust "$dir" $trust \
    || say "(the trust step failed; \`bash $dir/scripts/install.sh --trust-workspaces\` runs it again)"
}

path_has_local_bin() {  # $HOME/.local/bin (or ~/.local/bin) as a PATH entry, a trailing slash on the entry allowed
  case ":$(printf '%s' "$PATH" | sed 's#/*:#:#g; s#/*$##'):" in *":$bin_dir:"* | *":~/.local/bin:"*) return 0;; esac; return 1
}

finish() {  # doctor, then the one next step (and the PATH line the link needs)
  step "11/12 thimble doctor"
  run "$dir/plugin/bin/thimble" doctor || say "(doctor exited non-zero; see above)"
  step "12/12 next"
  local cmd="$dir/plugin/bin/thimble" rc pid repo
  # a server started from another tree keeps running that tree's code until it is restarted
  if [ "$dry" = 0 ] && [ -f "$home/server.json" ]; then
    pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$home/server.json" | head -n 1)"
    repo="$(json_get "$home/server.json" repo)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -n "$repo" ] && [ "$repo" != "$dir" ]; then
      say "the thimble server (pid $pid) is running the install in $repo: restart it with: thimble server restart"
    fi
  fi
  if [ "$cli_linked" = 1 ]; then
    local shown_bin="${bin_dir/#$HOME/\~}"
    if path_has_local_bin; then
      say "thimble on PATH: $shown_bin/thimble"
      cmd=thimble
    else
      case "${SHELL:-}" in */zsh) rc='~/.zshrc';; */bash) rc='~/.bashrc';; *) rc="your shell's startup file";; esac
      say "$shown_bin is not on your PATH, so typing thimble will not work yet. Add this line to $rc and open a new terminal:"
      say "  export PATH=\"${bin_dir/#$HOME/\$HOME}:\$PATH\""
    fi
  fi
  if [ "$custom_home" = 1 ]; then
    case "${SHELL:-}" in */zsh) rc='~/.zshrc';; */bash) rc='~/.bashrc';; *) rc="your shell's startup file";; esac
    say "THIMBLE_HOME is not the default ~/.thimble, so it must stay set wherever thimble or Claude Code runs. Add this line to $rc:"
    say "  export THIMBLE_HOME=$(printf '%q' "$home")"
  fi
  say "next: run $cmd in a folder of transcripts; it starts Claude Code with thimble and prints the dashboard's URL"
  say "thimble-cc-mod, a single-agent thimble inside Claude Code, is included: turn it on in a folder with $cmd cc-mod on"
}

keep_log() {  # the run's output also goes to $home/install.log (the last run only), which `thimble feedback` carries
  [ "$dry" = 1 ] && return 0
  { mkdir -p "$home" && chmod 700 "$home" && (umask 077 && : > "$home/install.log"); } 2>/dev/null || return 0
  exec > >(tee -a "$home/install.log") 2> >(tee -a "$home/install.log" >&2)
}

main() {
  parse_args "$@"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  keep_log
  locate_tree
  marketplace_name
  check_prerequisites
  system_browser
  sandbox_plan
  earlier_answers
  show_plan
  ask
  sandbox_step
  copy_tree
  make_venv
  build_ui
  browser_step
  if [ "$deps_only" = 1 ]; then say; say "--deps-only: done"; exit 0; fi
  write_pointer
  link_cli
  register_plugin
  trust_workspaces
  finish
}
main "$@"
