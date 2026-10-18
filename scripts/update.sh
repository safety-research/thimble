#!/usr/bin/env bash
# scripts/update.sh — bring a thimble install up to date, then run its scripts/install.sh over it.
#
#   scripts/update.sh [--dir DIR] [--from ZIP|URL] [--sums FILE] [--marketplace-name NAME] [--dry-run] [INSTALL FLAGS]
#
# INSTALL FLAGS are install.sh's --browser (which changes the browser it picks), --no-plugin and --require-pinned,
# passed on to it; install.sh asks nothing. --sandbox-deps, --no-sandbox-deps,
# --plugin, --modify-path and --no-modify-path, 0.7's, are passed on too, and install.sh ignores them.
# The install: --dir, else the one $THIMBLE_HOME/app-dir names, else the tree this script is in. A git checkout gets
# `git pull --ff-only` + install.sh in place; a release install needs --from (a release zip, path or https URL), which is
# unpacked and installed over it with ITS install.sh (backend/.venv, frontend/node_modules, workspaces/ and data/ kept).
# A release install is a git repository whose last commit is the release (install.sh git_baseline, refs/thimble/baseline):
# commits after it, such as a code ticket's change, and edits not committed, are kept on a branch local-fixes-<date>
# first (keep_local_fixes), and install.sh commits the new release as the new baseline.
# Before that the zip's SHA-256 is checked against the release's SHA256SUMS: for a URL the one beside it, which must
# exist; for a path --sums FILE, else a SHA256SUMS in the zip's folder when there is one. A mismatch refuses the update.
# Either way install.sh runs npm ci again when package-lock.json changed and Node 20+ is present, since custom views need
# the frontend's packages; in a checkout it also rebuilds frontend/dist when the pull changed a file it is built from (a
# release brings its own build). Claude Code takes the new plugin copy only when plugin.json's version changed, and a
# running session only when it restarts; a running server is not restarted here (one line says how for each).
# --dry-run (thimble update --dry-run) changes nothing: it prints the pull or the zip's check, then runs install.sh's own
# dry run, which shows what the install would do. In a checkout that dry run reads the
# files as they are before the pull; a zip on disk is unpacked into a temporary folder for it, and a URL is not fetched.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

here_tree="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
home="${THIMBLE_HOME:-$HOME/.thimble}"
dir=""
from=""
sums=""
mp_name=""
dry=0
install_flags=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2;;
    --from) from="$2"; shift 2;;
    --sums) sums="$2"; shift 2;;
    --marketplace-name) mp_name="$2"; shift 2;;
    --dry-run) dry=1; shift;;
    --browser) install_flags+=("$1" "${2:-}"); shift $(( $# > 1 ? 2 : 1 ));;
    --browser=* | --no-plugin | --require-pinned | --sandbox-deps | --no-sandbox-deps | --plugin | --no-modify-path \
      | --modify-path) install_flags+=("$1"); shift;;
    -h|--help) usage; exit 0;;
    *) echo "thimble update: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'thimble update: %s\n' "$*" >&2; exit 1; }
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$dry" = 1 ] || "$@"; }
json_get() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2"
  else
    sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
  fi
}
is_tree() { [ -f "$1/backend/pyproject.toml" ] && [ -d "$1/plugin/bin" ]; }
sha256_of() {  # sha256_of FILE: its SHA-256 in lowercase hex
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d' ' -f1
  else python3 -I -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; fi
}
check_digest() {  # check_digest ZIP SUMS NAME: exit unless the zip's SHA-256 is the one SUMS lists for NAME
  local want got
  want="$(tr -d '\r' < "$2" | awk -v n="$3" '$2 == n || $2 == "*" n { print tolower($1); exit }')"
  [ -n "$want" ] || die "$2 lists no SHA-256 for $3 (it may be another release's); refusing to install it"
  got="$(sha256_of "$1")"
  [ "$got" = "$want" ] || die "the SHA-256 of $3 is $got, not $want as $2 lists; refusing to install it"
  say "the SHA-256 of $3 matches $2"
}

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
installed_args+=(${install_flags[@]+"${install_flags[@]}"})
[ "$dry" = 1 ] && say "thimble update --dry-run: what the update would do; nothing changes"
# install.sh's dry run then names `thimble update` as the command that installs
export THIMBLE_INSTALL_VIA=update
dry_install() {  # dry_install INSTALL.SH: install.sh's own dry run, which changes nothing, for what the install would do
  local sh="$1"; shift
  say "+ bash $sh --dir $dir${installed_args[*]+ ${installed_args[*]}}"
  bash "$sh" --dir "$dir" ${installed_args[@]+"${installed_args[@]}"}
}

# keep_local_fixes: on a release install, the commits after its baseline and the edits not committed, on a new branch
# local-fixes-<date>, and the install's branch back at the baseline, so install.sh replaces only the release's files
keep_local_fixes() {
  local base ahead dirty branch n=1 commit idx
  command -v git >/dev/null 2>&1 && [ -d "$dir/.git" ] || return 0
  base="$(git -C "$dir" rev-parse -q --verify refs/thimble/baseline 2>/dev/null)" || return 0
  ahead="$(git -C "$dir" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)"
  dirty="$(git -C "$dir" status --porcelain 2>/dev/null || true)"
  [ "$ahead" != 0 ] || [ -n "$dirty" ] || return 0
  branch="local-fixes-$(date +%Y-%m-%d)"
  while git -C "$dir" rev-parse -q --verify "refs/heads/$branch" >/dev/null; do n=$((n + 1)); branch="local-fixes-$(date +%Y-%m-%d)-$n"; done
  if [ "$dry" = 1 ]; then say "+ keep the changes since the release on the branch $branch, then reset to the release"; return 0; fi
  commit="$(git -C "$dir" rev-parse HEAD)"
  if [ -n "$dirty" ]; then  # the edits not committed, as one commit on top, made in an index of its own
    idx="$(mktemp)"; rm -f "$idx"
    commit="$(GIT_INDEX_FILE="$idx" git -C "$dir" -c core.hooksPath=/dev/null add --all . >/dev/null \
      && tree="$(GIT_INDEX_FILE="$idx" git -C "$dir" write-tree)" \
      && git -C "$dir" -c commit.gpgsign=false commit-tree "$tree" -p HEAD -m "edits not committed before the update from thimble $old_version")" \
      || die "could not keep the edits made in $dir since the release; nothing was changed (commit or remove them, then update again)"
    rm -f "$idx"
  fi
  git -C "$dir" branch "$branch" "$commit" || die "could not keep the changes made in $dir on a branch; nothing was changed"
  git -C "$dir" reset -q --hard "$base" && git -C "$dir" clean -fdq  # what was not ignored is on the branch now
  say "your changes to thimble since $old_version are kept on the branch $branch in $dir"
}

if [ -e "$dir/.git" ] && [ ! -f "$dir/RELEASE.json" ]; then
  say "thimble $old_version at $dir (git checkout)"
  run git -C "$dir" pull --ff-only
  if [ "$dry" = 1 ]; then
    say "(the pull does not run in a dry run, so install.sh's dry run below reads the files as they are now)"
    dry_install "$dir/scripts/install.sh"
    exit 0
  fi
  new_version="$(json_get "$dir/plugin/.claude-plugin/plugin.json" version)"
  run bash "$dir/scripts/install.sh" --dir "$dir" ${installed_args[@]+"${installed_args[@]}"}
else
  say "thimble $old_version at $dir (release install)"
  [ -n "$from" ] || die "a release install updates from a zip: --from <thimble-<version>-<sha>.zip | https://…/thimble-….zip>"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  zip_path="$from"
  zip_name="$(basename "$from")"
  case "$from" in
    http://*) die "refusing a plain http URL; use https";;
    https://*)
      url="${from%%[?#]*}"
      zip_name="${url##*/}"
      [ -n "$zip_name" ] || die "the URL names no file: $from"
      zip_path="$tmp/$zip_name"
      [ -z "$sums" ] || die "--sums goes with a zip on disk; a URL is checked against the SHA256SUMS beside it"
      sums="$tmp/SHA256SUMS"
      run curl -fsSL --proto =https --proto-redir =https -o "$zip_path" "$from"
      run curl -fsSL --proto =https --proto-redir =https -o "$sums" "${url%/*}/SHA256SUMS" \
        || die "no SHA256SUMS beside the zip (${url%/*}/SHA256SUMS), so the download cannot be checked; refusing to install it";;
    *)
      if [ -z "$sums" ] && [ -f "$(dirname "$zip_path")/SHA256SUMS" ]; then sums="$(dirname "$zip_path")/SHA256SUMS"; fi;;
  esac
  if [ "$dry" = 1 ] && [ ! -f "$zip_path" ]; then
    [ -z "$sums" ] || say "+ check the SHA-256 of $zip_name against $sums"
    say "+ unzip -q $zip_path -d $tmp"
    say "+ bash <unpacked>/scripts/install.sh --dir $dir ${installed_args[*]+"${installed_args[*]}"}"
    say "(dry run: the zip was not fetched or opened)"
    exit 0
  fi
  [ -f "$zip_path" ] || die "no such file: $zip_path"
  if [ -n "$sums" ]; then
    [ -f "$sums" ] || die "no such file: $sums"
    check_digest "$zip_path" "$sums" "$zip_name"
  else
    say "no SHA256SUMS beside $zip_path and no --sums: its SHA-256 is not checked"
  fi
  # into a temporary folder, removed on exit, so a dry run unpacks it too, for install.sh's own dry run
  say "+ unzip -q $zip_path -d $tmp/unpacked"
  unzip -q "$zip_path" -d "$tmp/unpacked"
  root=""
  if is_tree "$tmp/unpacked"; then root="$tmp/unpacked"; else
    for cand in "$tmp/unpacked"/*/; do
      if is_tree "${cand%/}"; then root="${cand%/}"; break; fi
    done
  fi
  [ -n "$root" ] || die "the zip holds no thimble tree (expected thimble-<version>-<sha>/ with backend/ and plugin/)"
  new_version="$(json_get "$root/plugin/.claude-plugin/plugin.json" version)"
  say "release $new_version ($(json_get "$root/RELEASE.json" commit 2>/dev/null || echo '?')) → $dir"
  keep_local_fixes
  if [ "$dry" = 1 ]; then dry_install "$root/scripts/install.sh"; exit 0; fi
  run bash "$root/scripts/install.sh" --dir "$dir" ${installed_args[@]+"${installed_args[@]}"}
fi

# both paths update the tree in place, so the ~/.local/bin/thimble link still points at it
if [ "$dry" != 1 ]; then
  say
  if [ "$new_version" = "$old_version" ]; then
    say "version unchanged ($old_version): the files are updated, but Claude Code keeps its cached plugin copy until plugin.json's version changes"
  else
    say "thimble $old_version → $new_version"
    # a running session keeps the plugin it loaded (its MCP shim, and the hooks of a cached copy) until it restarts
    say "Claude Code sessions started before this update keep the previous plugin: quit each one and start it" \
      "again (\`claude -c\`, then /thimble, or \`thimble -c\`, continues the last session)"
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
