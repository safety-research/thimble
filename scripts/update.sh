#!/usr/bin/env bash
# scripts/update.sh — bring a thimble install up to date, then run its scripts/install.sh over it.
#
#   scripts/update.sh [--dir DIR] [--from ZIP|URL] [--marketplace-name NAME] [--dry-run]
#
# The install: --dir, else the one $THIMBLE_HOME/app-dir names, else the tree this script is in. A git checkout gets
# `git pull --ff-only` + install.sh in place; a release install needs --from (a release zip, path or https URL), which is
# unpacked and installed over it with ITS install.sh (backend/.venv, frontend/node_modules, workspaces/ and data/ kept).
# Either way install.sh runs npm ci again when package-lock.json changed and Node 20+ is present, since custom views need
# the frontend's packages; in a checkout it also rebuilds frontend/dist when the pull changed a file it is built from (a
# release brings its own build). Claude Code takes the new plugin copy only when plugin.json's version changed; a running
# server is not restarted here (one line says how).
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

here_tree="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
home="${THIMBLE_HOME:-$HOME/.thimble}"
dir=""
from=""
mp_name=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2;;
    --from) from="$2"; shift 2;;
    --marketplace-name) mp_name="$2"; shift 2;;
    --dry-run) dry=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "update.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'update.sh: %s\n' "$*" >&2; exit 1; }
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || "$@"; }
json_get() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2"
  else
    sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
  fi
}
is_tree() { [ -f "$1/backend/pyproject.toml" ] && [ -d "$1/plugin/bin" ]; }

if [ -z "$dir" ]; then
  if [ -f "$home/app-dir" ] && is_tree "$(head -n 1 "$home/app-dir")"; then
    dir="$(head -n 1 "$home/app-dir")"
  elif is_tree "$here_tree"; then
    dir="$here_tree"
  else
    die "no install found: pass --dir, or run scripts/install.sh first"
  fi
fi
is_tree "$dir" || die "$dir is not a thimble tree"
dir="$(cd "$dir" && pwd -P)"
old_version="$(json_get "$dir/plugin/.claude-plugin/plugin.json" version)"
installed_args=()
[ -n "$mp_name" ] && installed_args+=(--marketplace-name "$mp_name")
[ "$dry" = 1 ] && installed_args+=(--dry-run)
[ "$dry" = 1 ] && say "update.sh --dry-run: printing the steps; nothing changes"

if [ -e "$dir/.git" ]; then
  say "thimble $old_version at $dir (git checkout)"
  run git -C "$dir" pull --ff-only
  new_version="$(json_get "$dir/plugin/.claude-plugin/plugin.json" version)"
  run bash "$dir/scripts/install.sh" --dir "$dir" ${installed_args[@]+"${installed_args[@]}"}
else
  say "thimble $old_version at $dir (release install)"
  [ -n "$from" ] || die "a release install updates from a zip: --from <thimble-<version>-<sha>.zip | https://…/thimble-….zip>"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  zip_path="$from"
  case "$from" in
    http://*) die "refusing a plain http URL; use https";;
    https://*)
      zip_path="$tmp/release.zip"
      run curl -fsSL -o "$zip_path" "$from";;
  esac
  if [ "$dry" = 1 ] && [ ! -f "$zip_path" ]; then
    say "+ unzip -q $zip_path -d $tmp"
    say "+ bash <unpacked>/scripts/install.sh --dir $dir ${installed_args[*]+"${installed_args[*]}"}"
    say "(dry run: the zip was not fetched or opened)"
    exit 0
  fi
  [ -f "$zip_path" ] || die "no such file: $zip_path"
  run unzip -q "$zip_path" -d "$tmp/unpacked"
  if [ "$dry" = 1 ]; then
    say "+ bash <unpacked>/scripts/install.sh --dir $dir ${installed_args[*]+"${installed_args[*]}"}"
    exit 0
  fi
  root=""
  if is_tree "$tmp/unpacked"; then root="$tmp/unpacked"; else
    for cand in "$tmp/unpacked"/*/; do
      if is_tree "${cand%/}"; then root="${cand%/}"; break; fi
    done
  fi
  [ -n "$root" ] || die "the zip holds no thimble tree (expected thimble-<version>-<sha>/ with backend/ and plugin/)"
  new_version="$(json_get "$root/plugin/.claude-plugin/plugin.json" version)"
  say "release $new_version ($(json_get "$root/RELEASE.json" commit 2>/dev/null || echo '?')) → $dir"
  run bash "$root/scripts/install.sh" --dir "$dir" ${installed_args[@]+"${installed_args[@]}"}
fi

# both paths update the tree in place, so the ~/.local/bin/thimble link still points at it
if [ "$dry" != 1 ]; then
  say
  if [ "$new_version" = "$old_version" ]; then
    say "version unchanged ($old_version): the files are updated, but Claude Code keeps its cached plugin copy until plugin.json's version changes"
  else
    say "thimble $old_version → $new_version"
  fi
  # a running server keeps the old code until restarted; the analyst picks the moment
  if [ -f "$home/server.json" ]; then
    pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$home/server.json" | head -n 1)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      say "the thimble server (pid $pid) is running the previous version: restart it" \
        "when convenient with: thimble server restart"
    fi
  fi
fi
