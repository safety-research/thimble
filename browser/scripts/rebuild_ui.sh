#!/usr/bin/env bash
# scripts/rebuild_ui.sh — rebuild frontend/dist under a server that is serving it, without pulling the rug from under an
# open page.
#
#   scripts/rebuild_ui.sh [--frontend DIR] [--skip-typecheck] [--keep-hours N] [--dry-run]
#   scripts/rebuild_ui.sh --swap NEW DIST [--keep-hours N]     the swap alone, on a build already made (what the build
#                                                              runs last)
#
#   --frontend DIR     the frontend/ folder (default: this checkout's)
#   --skip-typecheck   no `tsc --noEmit` before the build
#   --keep-hours N     a chunk of an earlier build is pruned once older than N hours (default 24)
#   --dry-run          print the commands; build and change nothing
#
# The server serves frontend/dist as plain files and Vite code-splits the app, so an open page fetches the hashed chunks
# of the build it loaded. Deleting dist and rebuilding would break the next dynamic import() on every open page, so the
# build lands in frontend/dist.new and is merged into dist in place:
#   1 every new file is copied atomically (temp file, then mv), assets/ first and index.html last;
#   2 the previous build's assets/* stay, so the chunks an open page names keep answering;
#   3 a top-level file (outside assets/) the new build lacks is removed;
#   4 assets not in the new build and older than --keep-hours are pruned;
#   5 dist.new is removed.
# Without a dist yet, dist.new becomes dist. backend/app/dev.py runs it after a change to frontend/. Needs node >= 20
# and frontend/node_modules (`npm ci` runs when it is missing).
set -euo pipefail

usage()  { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say()    { printf '%s\n' "$*"; }
die()    { printf 'rebuild_ui.sh: %s\n' "$*" >&2; exit 1; }
run()    { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || "$@"; }
run_in() { local d="$1"; shift; printf '+ cd %q &&' "$d"; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || ( cd "$d" && "$@" ); }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
frontend="$here/../frontend"
keep_hours=24
skip_tc=0
dry=0
swap_new=""
swap_dist=""
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend) frontend="$2"; shift 2;;
    --skip-typecheck) skip_tc=1; shift;;
    --keep-hours) keep_hours="$2"; shift 2;;
    --dry-run) dry=1; shift;;
    --swap) swap_new="$2"; swap_dist="$3"; shift 3;;
    -h|--help) usage; exit 0;;
    *) echo "rebuild_ui.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
done
case "$keep_hours" in ''|*[!0-9]*) die "--keep-hours takes a whole number of hours (got '$keep_hours')";; esac

# swap NEW DIST — the merge described in the header; NEW is consumed. Prints one line with the counts.
swap() {
  local new="$1" dist="$2" f rel dir tmp kept=0 pruned=0 copied=0
  [ -f "$new/index.html" ] || die "$new has no index.html: not a build (nothing swapped)"
  if [ ! -d "$dist" ]; then
    mv "$new" "$dist"
    say "$dist: the first build, in place"
    return 0
  fi
  # a temp file an earlier, interrupted swap left behind
  find "$dist" -type f -name '.*.tmp.*' -delete 2>/dev/null || true
  # 1 the new build's files, atomically, assets/ first and the rest (index.html among them) after
  while IFS= read -r -d '' f; do
    rel="${f#"$new"/}"
    dir="$dist/$(dirname "$rel")"
    mkdir -p "$dir"
    tmp="$dir/.$(basename "$rel").tmp.$$"
    cp -p "$f" "$tmp"
    mv -f "$tmp" "$dist/$rel"
    copied=$((copied + 1))
  done < <({ [ -d "$new/assets" ] && find "$new/assets" -type f -print0; find "$new" -path "$new/assets" -prune -o -type f -print0; } 2>/dev/null)
  # 3 top-level files the new build lacks: gone
  while IFS= read -r -d '' f; do
    rel="${f#"$dist"/}"
    [ -e "$new/$rel" ] || rm -f "$f"
  done < <(find "$dist" -path "$dist/assets" -prune -o -type f -print0)
  # 4 the earlier builds' chunks: kept for their day, pruned after it (never a file of the new build)
  if [ -d "$dist/assets" ]; then
    while IFS= read -r -d '' f; do
      rel="${f#"$dist"/}"
      [ -e "$new/$rel" ] && continue
      if [ -n "$(find "$f" -mmin +"$((keep_hours * 60))" 2>/dev/null)" ]; then rm -f "$f"; pruned=$((pruned + 1)); else kept=$((kept + 1)); fi
    done < <(find "$dist/assets" -type f -print0)
  fi
  find "$dist" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  # 5
  rm -rf "$new"
  say "$dist: the new build in place ($copied files); $kept earlier chunk(s) kept for open pages, $pruned older than ${keep_hours} h pruned"
}

if [ -n "$swap_new" ]; then
  [ "$dry" = 1 ] && die "--swap has no --dry-run"
  swap "$swap_new" "$swap_dist"
  exit 0
fi

# ---------------------------------------------------------------------------- the build
[ -f "$frontend/package.json" ] || die "$frontend has no package.json (--frontend names the frontend/ folder)"
frontend="$(cd "$frontend" && pwd -P)"
if [ "$dry" != 1 ]; then
  command -v node >/dev/null 2>&1 || die "node is not installed (>= 20 is needed to build the UI)"
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "${major:-0}" -ge 20 ] || die "node >= 20 is required to build the frontend (found $(node -v))"
fi
[ "$dry" != 1 ] || say "rebuild_ui.sh --dry-run: printing the steps; nothing is built or changed"
if [ -e "$frontend/node_modules" ]; then say "frontend/node_modules present"; else run_in "$frontend" npm ci; fi
[ "$skip_tc" = 1 ] || run_in "$frontend" npx tsc --noEmit -p tsconfig.app.json
run rm -rf "$frontend/dist.new"
run_in "$frontend" npx vite build --outDir dist.new --emptyOutDir
if [ "$dry" = 1 ]; then
  say "+ swap $frontend/dist.new into $frontend/dist (the earlier chunks kept, those older than ${keep_hours} h pruned)"
  exit 0
fi
[ -f "$frontend/dist.new/index.html" ] || die "the build produced no $frontend/dist.new/index.html"
swap "$frontend/dist.new" "$frontend/dist"
