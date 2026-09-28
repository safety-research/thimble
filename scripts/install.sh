#!/usr/bin/env bash
# scripts/install.sh — install thimble: a git checkout in place, or an unzipped release copied to ~/.thimble/app.
# Steps: prerequisites · copy the release into --dir · backend/.venv · the card harness's browser · the Bash sandbox's root commands (printed) · the frontend's packages and frontend/dist · the app-dir pointer ·
# the Claude Code plugin · `thimble` on PATH (~/.local/bin/thimble → the tree's plugin/bin/thimble) · doctor · what to do next. Re-running it (after `git pull`, or over a newer release) is safe.
# In a checkout it runs npm ci when package-lock.json changed since the packages were installed, and rebuilds frontend/dist when it is older than the
# frontend's sources or the lockfile, so a pulled clone ends with the current UI; a release's prebuilt frontend/dist is kept as it is.
# Needs: uv (or python3 >= 3.12); node >= 20 for custom views, and to build frontend/dist when it is missing or out of date; the claude CLI to register the plugin.
# The marketplace name is thimble-local from a release zip and thimble from a checkout (.claude-plugin/marketplace.json).
#
#   scripts/install.sh [--dir DIR] [--marketplace-name NAME] [--dev] [--deps-only] [--no-plugin] [--dry-run]
#   --dir DIR                where the tree lives (default: this checkout; $THIMBLE_HOME/app for a release)
#   --marketplace-name NAME  the name Claude Code registers the tree under (default: the one in marketplace.json)
#   --dev                    also install the backend's test extras (pytest, pytest-asyncio)
#   --deps-only              stop after the frontend step: no pointer, no plugin, no doctor
#   --no-plugin              print the two `claude plugin` commands instead of running them
#   --dry-run                print every step and command; change nothing
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
  dir="" mp_name="" dev=0 deps_only=0 no_plugin=0 dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2;;
      --marketplace-name) mp_name="$2"; shift 2;;
      --dev) dev=1; shift;;
      --deps-only) deps_only=1; shift;;
      --no-plugin) no_plugin=1; shift;;
      --dry-run) dry=1; shift;;
      -h|--help) usage; exit 0;;
      *) echo "install.sh: unknown argument $1" >&2; usage >&2; exit 2;;
    esac
  done
}

locate_tree() {  # checkout or release, in place or copied, and the version
  [ -f "$src/backend/pyproject.toml" ] && [ -d "$src/plugin/bin" ] || die "$src is not a thimble tree (no backend/pyproject.toml + plugin/bin)"
  checkout=0; [ -e "$src/.git" ] && checkout=1
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

check_prerequisites() {  # uv or python >= pyproject's requires-python; node >= 20 unless frontend/dist is built; the claude CLI
  step "1/11 prerequisites"
  req_py="$(sed -n 's/^requires-python *= *">=\([0-9][0-9.]*\)".*/\1/p' "$src/backend/pyproject.toml")"; req_py="${req_py:-3.12}"
  have_uv=0 py=""
  if command -v uv >/dev/null 2>&1; then
    have_uv=1
    say "uv $(uv --version 2>/dev/null | sed 's/^uv //') — creates backend/.venv from uv.lock and fetches Python $req_py itself if the machine has none"
  else
    for cand in python3 python3.14 python3.13 python3.12; do
      command -v "$cand" >/dev/null 2>&1 || continue
      if "$cand" -I -c "import sys; sys.exit(0 if sys.version_info >= tuple(int(x) for x in '$req_py'.split('.')) else 1)" 2>/dev/null; then
        py="$(command -v "$cand")"; break
      fi
    done
    [ -n "$py" ] || die "neither uv nor a python >= $req_py was found. Install uv (https://docs.astral.sh/uv/getting-started/installation/) or Python $req_py+"
    say "no uv; python $($py -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') at $py (>= $req_py) — venv + pip, unpinned (uv is preferred: it installs the exact versions in backend/uv.lock — https://docs.astral.sh/uv/getting-started/installation/)"
  fi
  has_dist=0; [ -f "$src/frontend/dist/index.html" ] && has_dist=1
  stale=""; if [ "$has_dist" = 1 ] && [ "$checkout" = 1 ] && [ "$in_place" = 1 ]; then stale="$(dist_stale "$src/frontend")"; fi
  node_found="$(command -v node >/dev/null 2>&1 && node -v || echo none)"
  major="$(printf '%s' "$node_found" | sed -n 's/^v\([0-9]*\).*/\1/p')"
  node_ok=0; [ "${major:-0}" -ge 20 ] && node_ok=1
  if [ "$node_ok" = 1 ]; then
    if [ -n "$stale" ]; then
      say "node $node_found >= 20 — step 6 installs the frontend's packages and rebuilds frontend/dist, which is older than frontend/$stale"
    else
      say "node $node_found >= 20 — step 6 installs the frontend's packages$( [ "$has_dist" = 1 ] && echo ' (frontend/dist present)' || echo ' and builds frontend/dist' )"
    fi
  elif [ -n "$stale" ]; then
    say "frontend/dist is older than frontend/$stale, and without node >= 20 (found: $node_found) it cannot be rebuilt: the UI stays at that build until Node 20+ is installed and this script runs again"
  elif [ "$has_dist" = 1 ]; then
    say "frontend/dist present; no node >= 20 (found: $node_found), so step 6 installs no frontend packages"
  elif [ "$checkout" = 1 ]; then
    slug="$(json_get "$src/plugin/.claude-plugin/plugin.json" repository | sed -e 's#^https\{0,1\}://github\.com/##' -e 's#\.git$##')"
    die "no frontend/dist and no node >= 20 (found: $node_found). Install Node 20+ (https://nodejs.org) and re-run this script, or install from the release zip, which carries the built UI: gh release download --repo $slug --pattern 'thimble-*.zip' --dir ~/Downloads"
  else
    say "no frontend/dist and no node >= 20 (found: $node_found) — the browser UI needs a build (step 6 says how); the rest installs"
  fi
  have_claude=0
  if command -v claude >/dev/null 2>&1; then have_claude=1; say "claude CLI $(claude --version 2>/dev/null | head -n 1)"; else say "claude CLI not on PATH — the plugin registration step will print the commands to run"; fi
  say "auth: none needed here — thimble runs every model call through your claude, on whichever auth path you have configured for it"
}

copy_tree() {  # a release install: the release's entries replace the install's; .venv, node_modules, workspaces/, data/ and dev/ stay
  step "2/12 the tree at $dir"
  if [ "$in_place" = 1 ]; then say "in place: nothing to copy"; return 0; fi
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

make_venv() {  # uv sync from uv.lock when uv is present, else python -m venv + pip from pyproject; a symlinked venv is left alone
  step "3/11 backend/.venv (the server's Python and dependencies)"
  local venv="$dir/backend/.venv"
  extra=(); if [ "$dev" = 1 ]; then extra=(--extra dev); fi
  if [ -L "$venv" ]; then
    say "$venv is a symlink → $(readlink "$venv"); shared with another checkout, left alone"
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

fetch_browser() {  # the headless Chromium the card harness draws every card in (backend/app/render.py), for the playwright
  # version backend/.venv holds, into Playwright's own cache (no root needed); then one launch, since a bare Linux server
  # may lack the system libraries it links, which only root can add. Without it cards are still checked, from their data
  # and without a picture, and `thimble doctor` names the fix.
  step "4/11 the card harness's browser (headless Chromium)"
  local venv="$dir/backend/.venv" why
  if [ "$dry" != 1 ] && ! "$venv/bin/python" -I -c 'import playwright' 2>/dev/null; then
    say "backend/.venv has no playwright; cards will be checked without a picture of them"
    return 0
  fi
  if ! run "$venv/bin/python" -I -m playwright install chromium-headless-shell; then
    say "(the browser download failed; cards will be checked without a picture of them until this step is run again)"
    return 0
  fi
  [ "$dry" = 1 ] && return 0
  why="$("$venv/bin/python" -I - 2>&1 <<'PY'
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        await (await p.chromium.launch(headless=True)).close()

try:
    asyncio.run(main())
except Exception as e:
    print(str(e).splitlines()[0][:300] if str(e) else type(e).__name__)
PY
)" || true
  if [ -z "$why" ]; then
    say "headless Chromium starts"
  elif printf '%s' "$why" | grep -qiE 'missing dependencies|install-deps'; then
    say "headless Chromium was fetched but this machine lacks the system libraries it needs; cards are checked without a picture until you run:"
    say "  sudo $venv/bin/python -m playwright install-deps chromium-headless-shell"
  else
    say "headless Chromium did not start ($why); cards are checked without a picture of them"
  fi
}

check_sandbox() {  # Claude Code's Bash sandbox, which keeps the orientation's Bash off the network and from changing the
  # corpus: on Linux bubblewrap and socat, and on Ubuntu 23.10 or later an AppArmor profile that lets bwrap create user
  # namespaces. Installing them needs root, so this prints the commands (the backend's cc_settings.sandbox_setup, the
  # same lines `thimble doctor` prints) and runs none; without them the orientation's Bash asks under the analyst's
  # permission mode.
  step "5/11 the orientation's Bash sandbox"
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

install_packages() {  # npm ci from package-lock.json, and again whenever the lockfile differs from the copy the last
  # run left in node_modules (after an update); then the headless Chromium of the frontend's Playwright, which a view's
  # checks (scripts/view_shot.mjs) and the dev agent's screenshots load. A symlinked node_modules is left alone. A
  # checkout's node_modules installed without this script is kept while npm's own record of the install
  # (node_modules/.package-lock.json) is newer than package-lock.json. Returns 1 when npm ci failed.
  local fe="$dir/frontend" stamp="$dir/frontend/node_modules/.thimble-package-lock.json"
  if [ -L "$fe/node_modules" ]; then
    say "frontend/node_modules is a symlink → $(readlink "$fe/node_modules"); left alone"
  elif [ -f "$stamp" ] && cmp -s "$fe/package-lock.json" "$stamp"; then
    say "frontend/node_modules matches package-lock.json"
  elif [ "$checkout" = 1 ] && [ ! -f "$stamp" ] && [ -f "$fe/node_modules/.package-lock.json" ] \
       && [ ! "$fe/package-lock.json" -nt "$fe/node_modules/.package-lock.json" ]; then
    say "frontend/node_modules present, installed after the last change to package-lock.json: kept"
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
  else
    run_in "$fe" npm ci --no-audit --no-fund || return 1
    say "+ cp $fe/package-lock.json $stamp"
    [ "$dry" = 1 ] || cp "$fe/package-lock.json" "$stamp"
  fi
  run_in "$fe" npx playwright install chromium-headless-shell \
    || say "(the frontend's Chromium download failed; a view's checks cannot load its page until this step is run again)"
}

build_ui() {  # with node >= 20 the frontend's packages, which custom views need; a checkout's frontend/dist older than
  # its sources is rebuilt (scripts/rebuild_ui.sh, which swaps the build in under a running server), any other existing
  # frontend/dist is kept, and without one the typecheck and vite build make it
  step "6/11 frontend"
  if [ "$node_ok" = 1 ] && ! install_packages; then
    [ "$has_dist" = 1 ] || die "npm ci failed in $dir/frontend (above), so the UI cannot be built; fix that and run this script again"
    say "(npm ci failed, above: custom views need the frontend's packages, so run this script again)"
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
  step "7/11 $home/app-dir → $dir"
  run mkdir -p "$home"
  run chmod 700 "$home"
  say "+ printf '%s\\n' $dir > $home/app-dir"
  [ "$dry" = 1 ] || printf '%s\n' "$dir" > "$home/app-dir"
}

register_plugin() {  # marketplace add + plugin install, then update both so a re-run refreshes the cached copy
  step "8/11 the Claude Code plugin"
  local mp_file="$dir/.claude-plugin/marketplace.json" file_name
  file_name="$(json_get "$src/.claude-plugin/marketplace.json" name)"
  if [ -n "$mp_name" ] && [ "$mp_name" != "$file_name" ]; then
    if [ "$in_place" = 1 ] && [ "$checkout" = 1 ]; then
      say "--marketplace-name $mp_name ignored: $mp_file is a tracked file of this checkout; its name \"$file_name\" is used"
      mp_name="$file_name"
    else
      say "+ set .name = \"$mp_name\" in $mp_file"
      [ "$dry" = 1 ] || python3 -I -c 'import json,sys; p,n=sys.argv[1:]; d=json.load(open(p)); d["name"]=n; json.dump(d, open(p,"w"), indent=2); open(p,"a").write("\n")' "$mp_file" "$mp_name"
    fi
  fi
  mp_name="${mp_name:-$file_name}"
  if [ "$no_plugin" = 1 ] || [ "$have_claude" = 0 ]; then
    say "not registering ($( [ "$no_plugin" = 1 ] && echo --no-plugin || echo 'no claude CLI' )). When ready, run:"
    say "  claude plugin marketplace add $dir"
    say "  claude plugin install thimble@$mp_name"
    return 0
  fi
  run claude plugin marketplace add "$dir" || die "could not register $dir as marketplace \"$mp_name\". A marketplace of that name may point elsewhere: \`claude plugin marketplace list\`, then \`claude plugin marketplace remove $mp_name\` or re-run with --marketplace-name <other>"
  run claude plugin marketplace update "$mp_name" || say "(marketplace update failed; continuing)"
  run claude plugin install "thimble@$mp_name" || die "claude plugin install thimble@$mp_name failed"
  run claude plugin update "thimble@$mp_name" || say "(plugin update failed; the installed copy stays as it is)"
}

link_cli() {  # ~/.local/bin/thimble → <tree>/plugin/bin/thimble, so `thimble` is a command once that folder is on PATH (finish
  # says whether it is); a `thimble` there that is not a symlink into a thimble tree (another program) is left alone
  step "9/11 thimble on PATH"
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

path_has_local_bin() {  # $HOME/.local/bin (or ~/.local/bin) as a PATH entry, a trailing slash on the entry allowed
  case ":$(printf '%s' "$PATH" | sed 's#/*:#:#g; s#/*$##'):" in *":$HOME/.local/bin:"* | *":~/.local/bin:"*) return 0;; esac; return 1
}

finish() {  # doctor, then the one next step (and the PATH line the link needs)
  step "10/11 thimble doctor"
  run "$dir/plugin/bin/thimble" doctor || say "(doctor exited non-zero; see above)"
  step "11/11 next"
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
}

keep_log() {  # the run's output also goes to $home/install.log (the last run only), which `thimble feedback` carries
  [ "$dry" = 1 ] && return 0
  { mkdir -p "$home" && chmod 700 "$home" && (umask 077 && : > "$home/install.log"); } 2>/dev/null || return 0
  exec > >(tee -a "$home/install.log") 2> >(tee -a "$home/install.log" >&2)
}

main() {
  parse_args "$@"
  keep_log
  locate_tree
  check_prerequisites
  copy_tree
  make_venv
  fetch_browser
  check_sandbox
  build_ui
  if [ "$deps_only" = 1 ]; then say; say "--deps-only: done"; exit 0; fi
  write_pointer
  register_plugin
  link_cli
  finish
}
main "$@"
