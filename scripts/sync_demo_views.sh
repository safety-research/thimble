#!/usr/bin/env bash
# scripts/sync_demo_views.sh — copy the reviewed views into the demo pre-caches (demos/<dataset>/), in place of the
# views their orientations built, named as the dataset's views and stamped so that `thimble demo` shows them at once.
#
#   scripts/sync_demo_views.sh --from HOME [--dry-run] [DATASET...]
#
#   --from HOME   the THIMBLE_HOME whose workspaces/<dataset>/ hold the reviewed views (the "… (v2)" views); each
#                 dataset's folder is read from HOME/data/<dataset>.corpus.json, for the check against long stretches
#                 copied from the dataset
#   --dry-run     check and list what would change; write nothing
#   DATASET       the pre-caches to sync (default: every dataset below)
#
# For each dataset it runs scripts/dev/demo_views.py, which takes each view as thimble serves it in HOME (the files its
# last gate passed), under its plain slug there when HOME has renamed it, else under its "-v2" slug; writes it under the
# plain slug below with " (v2)" taken off its name and old slugs in its files renamed, stamps its version again with the
# digest of the files written, drops the pre-cache's other views and their proposals, and updates the manifest and
# README.md; it refuses a view that holds an absolute path, the user name or a long stretch of the dataset. Then it runs
# scripts/check_content.py on the tree. Reviewed views that change later: run it again, check, commit.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
py="$repo/backend/.venv/bin/python"

# <dataset> <reviewed slug>=<slug in the pre-cache>…
views_of() {
  case "$1" in
    collusion-wiki) echo "relay-board-v2=relay-board wiki-page-history-v2=wiki-page-history";;
    mythos-5) echo "activity-timeline-v2=activity-timeline";;
    transluce-urlquery) echo "activity-timeline-v2=activity-timeline episode-browser-v2=episode-browser";;
    *) return 1;;
  esac
}
all="collusion-wiki mythos-5 transluce-urlquery"

home="" dry="" names=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) [ $# -ge 2 ] || { usage >&2; exit 2; }; home="$2"; shift 2;;
    --dry-run) dry="--dry-run"; shift;;
    -h|--help) usage; exit 0;;
    -*) echo "sync_demo_views.sh: unknown flag $1" >&2; usage >&2; exit 2;;
    *) views_of "$1" >/dev/null || { echo "sync_demo_views.sh: no views listed for $1" >&2; exit 2; }
       names="$names $1"; shift;;
  esac
done
[ -n "$home" ] || { echo "sync_demo_views.sh: --from HOME is required" >&2; usage >&2; exit 2; }
[ -x "$py" ] || { echo "sync_demo_views.sh: backend/.venv is missing: run scripts/check.sh install" >&2; exit 1; }
[ -n "$names" ] || names="$all"

failed=0
for ds in $names; do
  ws="$home/workspaces/$ds"
  side="$home/data/$ds.corpus.json"
  [ -d "$ws" ] || { echo "sync_demo_views.sh: $ws is missing" >&2; failed=1; continue; }
  corpus="$("$py" -c 'import json, sys; print(json.load(open(sys.argv[1]))["path"])' "$side" 2>/dev/null)" || {
    echo "sync_demo_views.sh: $side names no dataset folder" >&2; failed=1; continue; }
  args=""
  for v in $(views_of "$ds"); do args="$args --view $v"; done
  echo "== $ds"
  # shellcheck disable=SC2086
  "$py" "$repo/scripts/dev/demo_views.py" "$repo/demos/$ds" --from "$ws" --corpus "$corpus" $args $dry || failed=1
done
[ "$failed" = 0 ] || exit 1
[ -n "$dry" ] && exit 0
echo "== content"
python3 "$repo/scripts/check_content.py" "$repo" $(command -v gitleaks >/dev/null || echo --no-gitleaks)
