#!/usr/bin/env bash
# scripts/install.sh — install thimble: a git checkout in place, or an unzipped release copied to ~/.thimble/app.
# Steps: prerequisites · what it installs and where, then its three questions · copy the release into --dir · backend/.venv ·
# the frontend's packages and frontend/dist · a browser for screenshots, if wanted · the Bash sandbox's root commands (printed) ·
# the app-dir pointer · `thimble` on PATH (~/.local/bin/thimble → the tree's plugin/bin/thimble) · thimble's plugin in every
# Claude Code session, if wanted · the trust of thimble's workspaces folder, if wanted · doctor · what to do next.
# The questions (the browser, the plugin, the trust) are asked on a terminal before anything is installed, so the rest runs
# unattended. Each is asked once: its answer is kept in $THIMBLE_HOME (config.json's "browser", plugin.json, trust.json), so
# a re-run or `thimble update` does not ask again, and a flag answers it without asking. Without a terminal an unanswered
# question gets no: nothing is downloaded or changed in Claude Code's files, and a system Chrome or Edge is used if found.
# --dry-run prints the questions with the flag for each answer, which is how Claude asks them when it runs the install.
# Re-running it (after `git pull`, over a newer release, or to answer a question again with its flag) skips the steps that
# are done: the same release is not copied again, pinned packages already installed are kept, and the browser is fetched
# only on a yes and only when the build thimble's Playwright needs is missing.
# A checkout gets backend/.venv from uv.lock with uv sync, and npm ci when package-lock.json changed since the packages were
# installed; it rebuilds frontend/dist when it is older than the frontend's sources or the lockfile, so a pulled clone ends
# with the current UI.
# A release installs from the package indexes the machine is set up with: the backend's packages from backend/requirements.txt
# (uv.lock's versions, with their hashes) by uv pip, or by pip where pip is set up with an index and uv is not; with its
# prebuilt frontend/dist, only the frontend packages the server and its scripts load (frontend/runtime, pinned by its own
# lockfile). Where the index lacks a pinned version, the versions pyproject.toml or frontend/runtime/package.json allow are
# installed instead. A file whose hash differs from the pinned one stops the install, from either index.
# Needs: uv (or python3 >= 3.12); node >= 20 for custom views, and to build frontend/dist when it is missing or out of date;
# the claude CLI to register the plugin.
# The marketplace name is thimble-local from a release zip and thimble from a checkout (.claude-plugin/marketplace.json).
#
#   scripts/install.sh [--dir DIR] [--marketplace-name NAME] [--dev] [--python PATH] [--deps-only]
#                      [--browser system|bundled|off] [--plugin | --no-plugin]
#                      [--trust-workspaces | --no-trust-workspaces] [--dry-run]
#   --dir DIR                where the tree lives (default: this checkout; $THIMBLE_HOME/app for a release)
#   --marketplace-name NAME  the name Claude Code registers the tree under (default: the one in marketplace.json)
#   --dev                    also install the backend's test extras (pytest, pytest-asyncio); a git checkout always does
#   --python PATH            use the environment of the python at PATH, a virtual environment you prepared, in place of
#                            creating backend/.venv: install.sh checks that it holds the packages pyproject.toml asks for,
#                            at versions it allows, links backend/.venv to it and installs nothing into it. Later runs
#                            and `thimble update` keep the link and check it again
#   --deps-only              stop after the sandbox step: no pointer, no plugin, no trust, no doctor
#   --browser system         screenshots with the Chrome or Edge installed on this machine (where Playwright's chrome and
#                            msedge channels look); nothing is downloaded
#   --browser bundled        download Playwright's headless Chromium (about 350 MB) into Playwright's cache folder
#   --browser off            no browser: no screenshot checks of cards and views, so no self-repair of graphics and no
#                            view review
#   --plugin                 add thimble to ~/.claude/settings.json and ~/.claude/plugins, so it is available in every
#                            claude session from startup. --no-plugin answers no, and takes back what an earlier yes
#                            added. The `thimble` command works either way
#   --trust-workspaces       trust thimble's workspaces folder by adding it to ~/.claude.json, so the orientation, its
#                            critic and the writers run as background agents in the terminal's agent tray;
#                            --no-trust-workspaces answers no, and takes back what an earlier yes added
#   --dry-run                print what it installs, its questions and every step and command; change nothing
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
  dir="" mp_name="" dev=0 deps_only=0 plugin="" dry=0 trust="" byo="" browser=""
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
  if [ "$node_ok" = 1 ]; then
    if [ -n "$stale" ]; then
      say "node $node_found >= 20 — step 4 installs the frontend's packages and rebuilds frontend/dist, which is older than frontend/$stale"
    else
      say "node $node_found >= 20 — step 4 installs the frontend's packages$( [ "$has_dist" = 1 ] && echo ' (frontend/dist present)' || echo ' and builds frontend/dist' )"
    fi
  elif [ -n "$stale" ]; then
    say "frontend/dist is older than frontend/$stale, and without node >= 20 (found: $node_found) it cannot be rebuilt: the UI stays at that build until Node 20+ is installed and this script runs again"
  elif [ "$has_dist" = 1 ]; then
    say "frontend/dist present; no node >= 20 (found: $node_found), so step 4 installs no frontend packages"
  elif [ "$checkout" = 1 ]; then
    slug="$(json_get "$src/plugin/.claude-plugin/plugin.json" repository | sed -e 's#^https\{0,1\}://github\.com/##' -e 's#\.git$##')"
    die "no frontend/dist and no node >= 20 (found: $node_found). Install Node 20+ (https://nodejs.org) and re-run this script, or install from the release zip, which carries the built UI: gh release download --repo $slug --pattern 'thimble-*.zip' --dir ~/Downloads"
  else
    say "no frontend/dist and no node >= 20 (found: $node_found) — the browser UI needs a build (step 4 says how); the rest installs"
  fi
  have_claude=0
  if command -v claude >/dev/null 2>&1; then have_claude=1; say "claude CLI $(claude --version 2>/dev/null | head -n 1)"; else say "claude CLI not on PATH — the plugin step will print the commands to run"; fi
  say "auth: thimble uses whichever auth path you have configured for claude"
}

copy_tree() {  # a release install: the release's entries replace the install's; .venv, node_modules, workspaces/, data/ and dev/ stay
  step "2/12 the tree at $dir"
  if [ "$in_place" = 1 ]; then say "in place: nothing to copy"; return 0; fi
  if [ -f "$src/RELEASE.json" ] && cmp -s "$src/RELEASE.json" "$dir/RELEASE.json"; then
    say "this release is installed there already (RELEASE.json matches, and it is copied last): nothing to copy"
    dir="$(cd "$dir" && pwd -P)"
    return 0
  fi
  say "copying the release into $dir (kept there if present: backend/.venv, frontend/node_modules, workspaces/, data/, dev/)"
  run mkdir -p "$dir"
  for entry in plugin backend prompts frontend .claude-plugin scripts README.md INSTALL.md docs LICENSE THIRD_PARTY_NOTICES RELEASE.json; do
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
  step "3/12 backend/.venv (the server's Python and dependencies)"
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
    say "backend/uv.lock is missing: resolving fresh (not the pinned versions)"
    run_in "$dir/backend" uv sync --no-dev --no-install-project ${extra[@]+"${extra[@]}"}
  else
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

release_venv() {  # the pinned packages of backend/requirements.txt (uv.lock's, with their hashes: release.sh) from the index
  # uv or pip is set up with (check_prerequisites); where that index lacks a pinned version, the versions pyproject.toml allows
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
  else
    say "the package index lacks a version backend/requirements.txt pins (above), so the versions backend/pyproject.toml allows are installed instead"
    py_ranges all
  fi
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

browser_prev() {  # the browser an earlier install or the user chose: config.json's "browser" in thimble's home, or ""
  local v=""
  [ ! -f "$home/config.json" ] || v="$(json_get "$home/config.json" browser 2>/dev/null)" || v=""
  case "$v" in system | bundled | off) printf '%s\n' "$v";; esac
}

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
  step "5/12 a browser for screenshots"
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
      say "off: no screenshot checks of cards and views. install.sh --browser system or --browser bundled turns them on";;
    *)
      say "not asked ($( [ "$dry" = 1 ] && echo 'dry run' || echo 'no terminal' )), so nothing is downloaded$( [ -n "$sys_path" ] && echo "; thimble uses $sys_name at $sys_path" || echo '; with no Chrome or Edge found there are no screenshot checks' ). install.sh --browser system, bundled or off answers";;
  esac
  if [ -n "$browser" ] && [ "$browser" != "$browser_was" ]; then record_browser "$browser"; fi
}

check_sandbox() {  # Claude Code's Bash sandbox, which keeps the orientation's Bash off the network and from changing the
  # corpus: on Linux bubblewrap and socat, and on Ubuntu 23.10 or later an AppArmor profile that lets bwrap create user
  # namespaces. Installing them needs root, so this prints the commands (the backend's cc_settings.sandbox_setup, the
  # same lines `thimble doctor` prints) and runs none; without them the orientation's Bash asks under the analyst's
  # permission mode.
  step "6/12 the orientation's Bash sandbox"
  local venv="$dir/backend/.venv"
  if [ "$dry" = 1 ]; then say "(checked by the backend's sandbox_lines once backend/.venv exists; prints root commands, runs none)"; return 0; fi
  ( cd "$dir/backend" && "$venv/bin/python" -c 'from app import cli; print("\n".join(l[2:] for l in cli.sandbox_lines()))' ) \
    || say "(the sandbox was not checked; \`thimble doctor\` checks it)"
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

runtime_packages() {  # only the frontend packages the server and its scripts load (frontend/runtime, which release.sh
  # writes: their part of package-lock.json, with each file's hash), from the registry npm is set up with; where it lacks
  # a pinned version, the versions frontend/runtime/package.json allows. npm installs them in frontend/runtime, and they
  # move to frontend/node_modules, where the server and the scripts look. The stamp is written only for the pinned ones,
  # so a later run tries those again
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
    say "the registry lacks a version frontend/runtime/package-lock.json pins (above), so the versions frontend/runtime/package.json allows are installed instead"
    run npm install --prefix "$rt" --no-audit --no-fund --no-package-lock || return 1
    pinned=0
  fi
  say "+ mv $rt/node_modules $fe/node_modules"
  [ "$dry" = 1 ] || { rm -rf "$fe/node_modules"; mv "$rt/node_modules" "$fe/node_modules"; }
  if [ "$pinned" = 1 ]; then
    say "+ cp $rt/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$rt/package-lock.json" "$stamp"
  fi
}

build_ui() {  # with node >= 20 the frontend's packages, which custom views need; a checkout's frontend/dist older than
  # its sources is rebuilt (scripts/rebuild_ui.sh, which swaps the build in under a running server), any other existing
  # frontend/dist is kept, and without one the typecheck and vite build make it
  step "4/12 frontend"
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
  [ "$node_ok" = 1 ] || say "custom views need Node 20+ (https://nodejs.org): install it, then run this script again"
}

write_pointer() {  # $THIMBLE_HOME/app-dir: how the plugin copy in Claude Code's plugin cache finds this tree (plugin/bin/thimble-app-dir)
  step "7/12 $home/app-dir → $dir"
  run mkdir -p "$home"
  run chmod 700 "$home"
  say "+ printf '%s\\n' $dir > $home/app-dir"
  [ "$dry" = 1 ] || printf '%s\n' "$dir" > "$home/app-dir"
}

link_cli() {  # ~/.local/bin/thimble → <tree>/plugin/bin/thimble, so `thimble` is a command once that folder is on PATH (finish
  # says whether it is); a `thimble` there that is not a symlink into a thimble tree (another program) is left alone
  step "8/12 thimble on PATH"
  local bin="$HOME/.local/bin" target="$dir/plugin/bin/thimble" existing=""
  cli_link="$bin/thimble"; cli_linked=0
  if [ -L "$cli_link" ]; then existing="$(readlink "$cli_link")"; fi
  if { [ -e "$cli_link" ] || [ -L "$cli_link" ]; } && [ -z "$existing" ]; then
    say "$cli_link exists and is not a link into a thimble tree; left alone — the command stays at $target"
    return 0
  fi
  case "$existing" in "" | */plugin/bin/thimble) ;; *)
    say "$cli_link is a link to $existing, not into a thimble tree; left alone — the command stays at $target"
    return 0;;
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

plugin_record() {  # the earlier answer to the plugin question: $home/plugin.json holds it and the marketplace install.sh
  # registered thimble under ("" when none). Without the record, a thimble@<marketplace> that Claude Code lists was
  # registered by an install that did not ask, which counts as an earlier yes
  plugin_prev="" plugin_reg=""
  if [ -f "$home/plugin.json" ]; then
    plugin_prev="$(json_get "$home/plugin.json" answer)"; plugin_reg="$(json_get "$home/plugin.json" registered)"
  elif [ "$have_claude" = 1 ]; then
    case "$(claude plugin list --json 2>/dev/null || true)" in *"\"thimble@$mp_name\""*) plugin_prev=yes plugin_reg="$mp_name";; esac
  fi
}

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
    say "  the frontend's packages custom views need: $dir/frontend/node_modules$( [ "$has_dist" = 1 ] || echo ', and the UI built into frontend/dist' )"
  fi
  say "  thimble's settings and state: $home"
  [ "$deps_only" = 1 ] || say "  the \`thimble\` command: a link at ~/.local/bin/thimble"
  say "  and only on a yes to its question:"
  say "  - a browser for screenshots: $( [ -n "$sys_path" ] && echo "$sys_name at $sys_path, nothing downloaded; or " )Playwright's headless Chromium, downloaded into $(pw_cache) (about 350 MB)"
  [ "$deps_only" = 1 ] && return 0
  say "  - thimble's plugin in every Claude Code session: $(cc_path settings.json) and $(cc_path plugins)"
  say "  - Claude Code's trust of thimble's workspaces folder: $cc_json"
}

browser_text() {  # the browser question's explanation
  say "A browser for screenshots. thimble takes screenshots of the cards and views it draws to check them, and repairs graphics that look wrong. Without a browser there are no screenshot checks of cards and views, so no self-repair of graphics and no view review."
}

plugin_text() {  # the plugin question
  say "Add thimble to $(cc_path settings.json) and $(cc_path plugins), so it is available in every claude session from startup? The \`thimble\` command works either way, and \`thimble uninstall\` removes it."
}

ask() {  # the three questions, before anything is installed: the browser, the plugin, the trust. Each is asked on a
  # terminal when neither its flag nor an earlier answer settles it; --dry-run prints them with their flags instead
  local tty=0 dl="Playwright's headless Chromium, downloaded into $(pw_cache) (about 350 MB; not again when it is there already)"
  browser_was="$(browser_prev)"
  [ "$deps_only" = 1 ] || plugin_record
  trust_q=""  # the trust question when claude_changes.install_trust would ask it (python3 runs the file before
  # backend/.venv exists; without python3 the trust step asks it)
  if [ "$deps_only" = 0 ] && [ -z "$trust" ] && command -v python3 >/dev/null 2>&1; then
    trust_q="$(THIMBLE_HOME="$home" python3 -I "$src/backend/app/claude_changes.py" question "$dir" 2>/dev/null)" || trust_q=""
  fi
  if [ "$dry" = 1 ]; then
    step "the questions install.sh asks on a terminal, and the flag that gives each answer"
    if [ -n "$browser" ]; then say "1. the browser: answered by --browser $browser"
    elif [ -n "$browser_was" ]; then say "1. the browser: answered $browser_was earlier ($home/config.json); --browser changes it"
    else
      say "1. $(browser_text)"
      [ -z "$sys_path" ] || say "   - $sys_name at $sys_path, nothing downloaded: --browser system"
      say "   - $dl: --browser bundled"
      say "   - no browser: --browser off"
      [ -n "$sys_path" ] || say "   (no Chrome or Edge was found where Playwright looks for one)"
    fi
    [ "$deps_only" = 0 ] || return 0
    if [ -n "$plugin" ]; then say "2. the plugin: answered by --$( [ "$plugin" = yes ] || echo 'no-' )plugin"
    elif [ -n "$plugin_prev" ]; then say "2. the plugin: answered $plugin_prev earlier; --plugin or --no-plugin changes it"
    elif [ "$have_claude" = 0 ]; then say "2. the plugin: not asked, since there is no claude CLI"
    else say "2. $(plugin_text)"; say "   - yes: --plugin"; say "   - no: --no-plugin"; fi
    if [ -n "$trust" ]; then say "3. the trust: answered by --$( [ "$trust" = --yes ] || echo 'no-' )trust-workspaces"
    elif [ -n "$trust_q" ]; then say "3. $(printf '%s' "$trust_q" | tr '\n' ' ')"; say "   - yes: --trust-workspaces"; say "   - no: --no-trust-workspaces"
    else say "3. the trust: answered earlier, or the folder is trusted already; --trust-workspaces or --no-trust-workspaces changes it"; fi
    return 0
  fi
  [ -t 0 ] && tty=1
  if [ "$tty" = 1 ] && [ -z "$browser" ] && [ -z "$browser_was" ]; then
    printf '\n'; browser_text
    if [ -n "$sys_path" ]; then
      printf 'Use %s at %s? Nothing is downloaded. [Y/n] ' "$sys_name" "$sys_path"
      if yes_no y; then browser=system; fi
    fi
    if [ -z "$browser" ]; then
      printf "%s Playwright's headless Chromium (about 350 MB) into %s? It is not downloaded again when it is there already. [y/N] " \
        "$( [ -n "$sys_path" ] && echo 'Download' || echo 'No Chrome or Edge was found. Download' )" "$(pw_cache)"
      if yes_no n; then browser=bundled; else browser=off; fi
    fi
  fi
  [ "$deps_only" = 0 ] && [ "$tty" = 1 ] || return 0
  if [ -z "$plugin" ] && [ -z "$plugin_prev" ] && [ "$have_claude" = 1 ]; then
    printf '\n%s [y/N] ' "$(plugin_text)"
    if yes_no n; then plugin=yes; else plugin=no; fi
  fi
  if [ -n "$trust_q" ]; then
    printf '\n%s [y/N] ' "$trust_q"
    if yes_no n; then trust=--yes; else trust=--no; fi
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
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ] && [ "$plugin_reg" = "$mp_name" ] && [ "$(plugin_listed)" = "$version" ]; then
    say "thimble@$mp_name $version is registered already: nothing to do"
    return 0
  fi
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ]; then
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
  if [ -n "$plugin_reg" ]; then
    left="$plugin_reg"
    if [ "$have_claude" = 1 ] && run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; then left=""
    else say "(the registration an earlier yes added is still there: claude plugin uninstall thimble@$plugin_reg && claude plugin marketplace remove $plugin_reg takes it back)"; fi
  fi
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
  case ":$(printf '%s' "$PATH" | sed 's#/*:#:#g; s#/*$##'):" in *":$HOME/.local/bin:"* | *":~/.local/bin:"*) return 0;; esac; return 1
}

finish() {  # doctor, then the one next step (and the PATH line the link needs)
  step "11/12 thimble doctor"
  run "$dir/plugin/bin/thimble" doctor || say "(doctor exited non-zero; see above)"
  step "12/12 next"
  local cmd="$dir/plugin/bin/thimble" rc
  if [ "$cli_linked" = 1 ]; then
    if path_has_local_bin; then
      say "thimble on PATH: ~/.local/bin/thimble"
      cmd=thimble
    else
      case "${SHELL:-}" in */zsh) rc='~/.zshrc';; */bash) rc='~/.bashrc';; *) rc="your shell's startup file";; esac
      say "~/.local/bin is not on your PATH, so typing thimble will not work yet. Add this line to $rc and open a new terminal:"
      say '  export PATH="$HOME/.local/bin:$PATH"'
    fi
  fi
  if [ "$custom_home" = 1 ]; then
    case "${SHELL:-}" in */zsh) rc='~/.zshrc';; */bash) rc='~/.bashrc';; *) rc="your shell's startup file";; esac
    say "THIMBLE_HOME is not the default ~/.thimble, so it must stay set wherever thimble or Claude Code runs. Add this line to $rc:"
    say "  export THIMBLE_HOME=$(printf '%q' "$home")"
  fi
  say "next: run $cmd in a folder of transcripts; it starts Claude Code with thimble and prints the dashboard's URL"
  local open=()
  [ -n "$browser$browser_was" ] || open+=("the browser")
  [ -n "$plugin$plugin_prev" ] || [ "$have_claude" = 0 ] || open+=("the plugin")
  [ -n "$trust" ] || [ -z "$trust_q" ] || open+=("the trust")
  if [ "$dry" = 0 ] && [ "${#open[@]}" -gt 0 ]; then
    say "not asked, with no terminal: $(IFS=,; printf '%s' "${open[*]}" | sed 's/,/, /g'). So nothing was downloaded for them or changed in Claude Code's files."
    say "bash $dir/scripts/install.sh --dry-run lists those questions and the flag for each answer; a re-run with the flags skips the steps that are done"
  fi
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
  show_plan
  ask
  copy_tree
  make_venv
  build_ui
  browser_step
  check_sandbox
  if [ "$deps_only" = 1 ]; then say; say "--deps-only: done"; exit 0; fi
  write_pointer
  link_cli
  register_plugin
  trust_workspaces
  finish
}
main "$@"
