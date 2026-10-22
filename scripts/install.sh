#!/usr/bin/env bash
# install.sh: installs thimble's terminal plugin into Claude Code and its browser workbench from this checkout. Run
# `scripts/install.sh --help` for what it does. It can run again at any time: it installs again what it installed,
# and updates what changed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--no-browser] [--no-plugin] [--local] [--bin-dir DIR]

Installs thimble's two products. It checks Node, Python and uv first, and says what is missing, one line each.
  The terminal plugin: adds the marketplace safety-research/thimble to Claude Code and installs thimble@thimble, then
    the sandbox its cards run in (Anthropic's sandbox runtime, pinned by the plugin, in ~/.thimble/srt); on Linux it
    says which system packages the sandbox lacks, with the one command that installs them (it never runs sudo).
    Without the claude command, it prints the two commands to run.
  The browser workbench, from this checkout: the server (uv sync, with pytest for a fix's tests), the page (npm ci,
    then a build), the sandbox runtime (npm ci in browser/server/sandbox), and a thimble-browser launcher in
    ~/.local/bin. It says how much disk space this takes, about 600 MB.
Running it again is safe, and updates both.

  --no-browser   install the terminal plugin only
  --no-plugin    install the browser workbench only
  --local        use this checkout as the plugin's marketplace, in place of GitHub (to try a branch)
  --bin-dir DIR  put the thimble-browser launcher in DIR
EOF
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
browser="$root/browser"
plugin=1 web=1 local=0
bin_dir="$HOME/.local/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --no-browser) web=0 ;;
    --no-plugin) plugin=0 ;;
    --local) local=1 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "install.sh: --bin-dir needs a folder" >&2; exit 2; }
      bin_dir="$2"; shift ;;
    *) echo "install.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ "$plugin" = 1 ] || [ "$web" = 1 ] || { echo "install.sh: --no-browser and --no-plugin leave nothing to install" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
# quietly CMD...: runs CMD, and shows what it printed only when it fails
quietly() {
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then rm -f "$log"; else cat "$log" >&2; rm -f "$log"; return 1; fi
}
step() { printf '\n== %s\n' "$*"; }

# ver_ge HAVE WANT: whether the version HAVE is WANT or later, comparing up to three dotted numbers
ver_ge() {
  local IFS=.
  local -a h=($1) w=($2)
  local i a b
  for i in 0 1 2; do
    a="${h[$i]:-0}"; b="${w[$i]:-0}"
    a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"
    a=$((10#${a:-0})); b=$((10#${b:-0}))
    [ "$a" -gt "$b" ] && return 0
    [ "$a" -lt "$b" ] && return 1
  done
  return 0
}

# ---- what it needs

macos=0
[ "$(uname -s)" = Darwin ] && macos=1
missing=()
notes=()
if [ "$macos" = 1 ]; then node_fix="brew install node"; uv_fix="brew install uv"
else node_fix="from your system's packages or https://nodejs.org"; uv_fix="curl -LsSf https://astral.sh/uv/install.sh | sh"; fi

node_min=22.12.0
[ "$plugin" = 1 ] && node_min=22.18.0
if ! command -v node >/dev/null 2>&1; then
  missing+=("Node.js ${node_min%.0} or later is not installed: $node_fix")
else
  have="$(node --version 2>/dev/null | sed 's/^v//')"
  ver_ge "$have" "$node_min" || missing+=("Node.js is $have, and thimble needs ${node_min%.0} or later: $node_fix")
fi

if [ "$plugin" = 1 ]; then
  py="${THIMBLE_PYTHON:-python3}"
  # run from / so that no file in the current folder stands in for a module
  pyv="$(cd / && "$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
  if [ -z "$pyv" ]; then
    missing+=("Python 3.10 or later is not installed ($py), which the terminal plugin runs on: install python3")
  elif ! ver_ge "$pyv" 3.10; then
    missing+=("Python is $pyv ($py), and the terminal plugin needs 3.10 or later: install a newer python3, or set THIMBLE_PYTHON")
  fi
  if command -v claude >/dev/null 2>&1; then
    have="$(claude --version 2>/dev/null | awk '{print $1}')"
    ver_ge "$have" 2.1.307 || missing+=("Claude Code is $have, and the terminal plugin needs 2.1.307 or later: claude update")
  fi
fi

if [ "$web" = 1 ]; then
  command -v node >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1 && missing+=("npm is not installed, and the browser workbench needs it to build: install it with Node.js")
  if ! command -v uv >/dev/null 2>&1; then
    missing+=("uv is not installed, and the browser workbench's server needs it: $uv_fix")
  else
    have="$(uv --version 2>/dev/null | awk '{print $2}')"
    ver_ge "$have" 0.8.0 || missing+=("uv is $have, and the browser workbench needs 0.8 or later: uv self update")
  fi
  if [ "$macos" = 0 ] && ! command -v bwrap >/dev/null 2>&1; then
    notes+=("bubblewrap is not installed, so the browser workbench cannot run card code until you install it: sudo apt install bubblewrap, or your system's package")
  fi
fi

if [ ${#missing[@]} -gt 0 ]; then
  say "thimble needs these first:"
  for m in "${missing[@]}"; do say "  - $m"; done
  say "Then run scripts/install.sh again. Nothing was installed."
  exit 1
fi
say "thimble: what the install needs is here."

# ---- the terminal plugin

if [ "$plugin" = 1 ]; then
  step "The terminal plugin"
  source="safety-research/thimble"
  [ "$local" = 1 ] && source="$root"
  if command -v claude >/dev/null 2>&1; then
    claude plugin marketplace add "$source"
    if claude plugin list --json 2>/dev/null | grep -q '"thimble@thimble"'; then
      claude plugin marketplace update thimble
      claude plugin update thimble@thimble
    else
      # each feature's default, from the userConfig of the plugin this installs (the marketplace just added: GitHub's,
      # or this checkout with --local), so a fresh install has no option left unset and none its version lacks
      config=()
      while IFS= read -r kv; do [ -n "$kv" ] && config+=(--config "$kv"); done < <(cd / && "$py" -c '
import json, os, sys
plugins = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "plugins")
try:
    at = json.load(open(os.path.join(plugins, "known_marketplaces.json")))["thimble"]["installLocation"]
    entry = next(p for p in json.load(open(os.path.join(at, ".claude-plugin", "marketplace.json")))["plugins"]
                 if p.get("name") == "thimble")
    manifest = json.load(open(os.path.join(at, entry["source"], ".claude-plugin", "plugin.json")))
except (OSError, ValueError, KeyError, TypeError, StopIteration):
    sys.exit(0)  # no defaults to give: Claude Code installs the plugin with its own
for k, v in (manifest.get("userConfig") or {}).items():
    if "default" in v:
        print(k + "=" + json.dumps(v["default"]))
')
      claude plugin install thimble@thimble ${config[@]+"${config[@]}"}
    fi
    # the sandbox the plugin's cards run in: Anthropic's sandbox runtime, at the version the installed plugin pins, in
    # thimble's home (the plugin's sandbox/setup.mjs, which the plugin also runs at each session start)
    at="$(cd / && "$py" -c '
import json, os
plugins = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "plugins")
try:
    at = json.load(open(os.path.join(plugins, "known_marketplaces.json")))["thimble"]["installLocation"]
    entry = next(p for p in json.load(open(os.path.join(at, ".claude-plugin", "marketplace.json")))["plugins"]
                 if p.get("name") == "thimble")
    print(os.path.normpath(os.path.join(at, entry["source"])))
except (OSError, ValueError, KeyError, TypeError, StopIteration):
    pass
' || true)"
    if [ -n "$at" ] && [ -f "$at/sandbox/setup.mjs" ]; then
      say "The sandbox that cards run in (Anthropic's sandbox runtime)..."
      node "$at/sandbox/setup.mjs" --probe || notes+=("cards do not draw until the sandbox works: do what the line above says; the next card tries again, in a running claude session too")
    fi
    say "The plugin works in a new claude session, in a folder of data files that you trust."
  else
    say "Claude Code (the claude command) is not installed. Install it, then run:"
    say "  claude plugin marketplace add $source"
    say "  claude plugin install thimble@thimble"
  fi
fi

# ---- the browser workbench

if [ "$web" = 1 ]; then
  step "The browser workbench"
  say "The server's Python packages (uv sync)..."
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  # with pytest (the dev extra, about 3 MB), so that a fix made in the browser can run its tests (fixcopy.py, fix_test)
  quietly uv sync --project "$browser/server" --frozen --extra dev
  say "The page (npm ci, then a build)..."
  quietly npm --prefix "$browser/frontend" ci --no-audit --no-fund
  quietly npm --prefix "$browser/frontend" run build
  say "The sandbox runtime (npm ci in browser/server/sandbox)..."
  sb="$browser/server/sandbox"
  quietly npm --prefix "$sb" ci --ignore-scripts --no-audit --no-fund
  cp "$sb/package-lock.json" "$sb/node_modules/.thimble-lock.json"  # the launcher installs it again when this differs

  mkdir -p "$bin_dir"
  launcher="$bin_dir/thimble-browser"
  if [ -e "$launcher" ] && ! grep -q 'written by thimble scripts/install.sh' "$launcher" 2>/dev/null; then
    say "$launcher is another program, so the launcher was not written. Run $browser/scripts/thimble-browser instead, or pass --bin-dir."
  else
    quoted="'$(printf '%s' "$browser/scripts/thimble-browser" | sed "s/'/'\\\\''/g")'"
    printf '#!/bin/sh\n# thimble-browser, written by thimble scripts/install.sh: starts the browser workbench of this checkout.\nexec %s "$@"\n' \
      "$quoted" > "$launcher.tmp"
    chmod +x "$launcher.tmp"
    mv -f "$launcher.tmp" "$launcher"
    say "The launcher: $launcher"
    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *) notes+=("$bin_dir is not on your PATH: add it, or run $launcher by its full path") ;;
    esac
  fi

  kb() { du -sk "$1" 2>/dev/null | awk '{print $1}' || echo 0; }
  page=$(kb "$browser/frontend/node_modules"); built=$(kb "$browser/frontend/dist")
  venv=$(kb "$browser/server/.venv"); srt=$(kb "$sb/node_modules")
  mb() { echo $((($1 + 512) / 1024)); }
  say "The browser workbench takes $(mb $((page + built + venv + srt))) MB in this checkout: the page's packages $(mb "$page") MB" \
    "(browser/frontend/node_modules), the server's Python packages $(mb "$venv") MB (browser/server/.venv), the sandbox" \
    "runtime $(mb "$srt") MB and the built page $(mb "$built") MB."
  uv run --frozen --quiet --project "$browser/server" python -c \
    'from thimble_browser import sandbox_note; print("The sandbox: " + sandbox_note.line(False).strip().lstrip("! "))' || true
fi

if [ ${#notes[@]} -gt 0 ]; then
  for n in "${notes[@]}"; do say "Note: $n"; done
fi
if [ "$web" = 1 ]; then
  say ""
  say "To start the browser workbench, run this in a folder of files:"
  say ""
  say "  thimble-browser"
  say ""
  say "It opens the folder you are in (or: thimble-browser FOLDER) at http://127.0.0.1:8000. It needs credentials for the"
  say "Claude API, an API key or Workload Identity Federation; browser/README.md says how."
fi
