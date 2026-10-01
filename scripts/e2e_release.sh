#!/usr/bin/env bash
# scripts/e2e_release.sh — the release's end-to-end test: a clean install from a fresh clone, then thimble's UI walked
# in a headless browser on a copy of a corpus, with a screenshot and a pass or fail for each step.
#
#   scripts/e2e_release.sh [--ref REF] [--repo PATH] [--zip | --zip-file ZIP] [--out DIR] [--port N] [--corpus DIR]
#                          [--no-plugin] [--own-caches] [--strict] [--keep-install]
#
#   --ref REF        the branch or commit to clone (default: the branch this checkout has out)
#   --repo PATH      the git repository to clone it from (default: this checkout)
#   --zip            install the release zip scripts/release.sh builds from the clone, as a Global install into the
#                    throwaway THIMBLE_HOME/app, in place of installing the clone itself (a Dev install)
#   --zip-file ZIP   install this release zip as a Global install; nothing is cloned
#   --out DIR        where the run goes: report.md, shots/, logs/, and the clone, home and corpus copy it installs
#                    and runs on (default: a new folder under $TMPDIR). It must be empty or missing
#   --port N         the server's port (default 8470); N+1 is its UI port, which only dev mode listens on
#   --corpus DIR     the folder to copy and open (default: the synthetic corpus scripts/dev/make_toy_corpus.py writes)
#   --no-plugin      answer no to install.sh's plugin question (default: yes when `claude` is on PATH)
#   --own-caches     download into the throwaway home too (uv, npm, Playwright's browsers); by default those caches
#                    are the caller's, so packages and the browser already downloaded are not fetched again
#   --strict         count a failing step that waits for unmerged work (`pending` in the report) as a failure
#   --keep-install   leave the clone and the throwaway home in --out (the report, shots and logs always stay)
#
# Steps: clone REF into <out>/clone; install it (or the zip) with install.sh's flags, non-interactive, into a throwaway
# HOME and THIMBLE_HOME (<out>/home, never the caller's ~/.claude or ~/.thimble); `thimble doctor`; copy the corpus to
# <out>/corpus, add a few files the UI steps open (a chat log in Markdown, one in CSV, a PDF) and a fixture view;
# start the server and a stand-in for the analyst's Claude Code session (scripts/e2e/standin_session.py: no model runs);
# walk the UI (scripts/e2e/release.mjs): the first-launch welcome and the tour, the File browser, a transcript, a PDF, the
# fixture view, Settings > Extensions, then `thimble extension add` of scripts/e2e/fixture-extension switched off and on
# from the CLI and from Settings. Every process it started is stopped on exit, and <out>/report.md lists each step.
#
# A step marked pending waits for work that is not merged yet: its failure is reported as expected and does not fail the
# run (unless --strict), and once it passes the report says so. Exit 0 when no step failed, 1 otherwise.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf 'e2e: %s\n' "$*"; }
die() { printf 'e2e_release.sh: %s\n' "$*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
src="$(cd "$here/.." && pwd -P)"
ref="" repo="" out="" port=8470 corpus="" plugin="" own_caches=0 strict=0 keep_install=0 zip=0 zip_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift 2;;
    --repo) repo="$2"; shift 2;;
    --zip) zip=1; shift;;
    --zip-file) zip_file="$2"; shift 2;;
    --out) out="$2"; shift 2;;
    --port) port="$2"; shift 2;;
    --corpus) corpus="$2"; shift 2;;
    --no-plugin) plugin=no; shift;;
    --own-caches) own_caches=1; shift;;
    --strict) strict=1; shift;;
    --keep-install) keep_install=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "e2e_release.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
done

if [ -n "$zip_file" ]; then
  [ -f "$zip_file" ] || die "--zip-file $zip_file is not a file"
  zip_file="$(cd "$(dirname "$zip_file")" && pwd -P)/$(basename "$zip_file")"
  ref="$(basename "$zip_file" .zip)" commit="$(unzip -p "$zip_file" '*/RELEASE.json' 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("commit", ""))' 2>/dev/null || true)"
else
  repo="$(cd "${repo:-$src}" && git rev-parse --show-toplevel)" || die "--repo ${repo:-$src} is not a git checkout"
  [ -n "$ref" ] || ref="$(git -C "$repo" symbolic-ref --short -q HEAD || git -C "$repo" rev-parse HEAD)"
  commit="$(git -C "$repo" rev-parse --verify -q "$ref^{commit}")" || die "no commit $ref in $repo"
fi
case "$port" in ''|*[!0-9]*) die "--port takes a number";; esac
command -v node >/dev/null || die "node is required"
command -v python3 >/dev/null || die "python3 is required"
[ -z "$corpus" ] || [ -d "$corpus" ] || die "--corpus $corpus is not a folder"
if [ -z "$out" ]; then out="$(mktemp -d "${TMPDIR:-/tmp}/thimble-e2e.XXXXXX")"; fi
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
[ -z "$(ls -A "$out")" ] || die "--out $out is not empty"
for p in "$port" $((port + 1)); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then die "port $p is in use; pick another with --port"; fi
done

clone="$out/clone" home="$out/home" logs="$out/logs" shots="$out/shots" results="$out/results.jsonl"
# the tree thimble runs from: the clone itself, or the Global install a zip makes
tree="$clone"
if [ "$zip" = 1 ] || [ -n "$zip_file" ]; then tree="$home/.thimble/app"; fi
mkdir -p "$home" "$logs" "$shots"
: > "$results"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t0=$SECONDS
standin_pid=""

# record STEP STATUS DETAIL [SHOT]: one line of results.jsonl (scripts/e2e/report.py reads them)
record() {
  python3 -I -c 'import json, sys; print(json.dumps({"step": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3],
"shots": [s for s in sys.argv[4:] if s]}))' "$1" "$2" "$3" "${4:-}" >> "$results"
  say "$1: $2${3:+ ($3)}"
}

# the throwaway environment: nothing of the caller's but PATH, the locale and, unless --own-caches, its download caches
caches=()
if [ "$own_caches" = 0 ]; then
  if command -v uv >/dev/null; then
    caches+=("UV_CACHE_DIR=$(uv cache dir 2>/dev/null)" "UV_PYTHON_INSTALL_DIR=$(uv python dir 2>/dev/null)")
  fi
  if command -v npm >/dev/null; then caches+=("npm_config_cache=$(npm config get cache 2>/dev/null)"); fi
  pw="${PLAYWRIGHT_BROWSERS_PATH:-}"
  if [ -z "$pw" ]; then
    case "$(uname -s)" in Darwin) pw="$HOME/Library/Caches/ms-playwright";; *) pw="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright";; esac
  fi
  caches+=("PLAYWRIGHT_BROWSERS_PATH=$pw")
fi
envs=(env -i "PATH=$home/.local/bin:$PATH" "HOME=$home" "THIMBLE_HOME=$home/.thimble" "THIMBLE_PORT=$port"
      "THIMBLE_UI_PORT=$((port + 1))" "LANG=${LANG:-C.UTF-8}" "TERM=dumb" "SHELL=${SHELL:-/bin/sh}"
      "TMPDIR=${TMPDIR:-/tmp}" ${caches[@]+"${caches[@]}"})
in_env() { "${envs[@]}" "$@"; }

ours() {  # the processes this run started that may still run: the server's session (it starts as its own session
  # leader) and anything running from the clone, the unzipped release or the throwaway home
  local sid="$1"
  { [ -z "$sid" ] || ps -eo pid=,sid= | awk -v s="$sid" '$2 == s {print $1}'
    pgrep -f -- "$clone/" || true; pgrep -f -- "$home/" || true; pgrep -f -- "$out/release/" || true; } | sort -u | grep -vx "$$" || true
}

cleanup() {
  local rc=$? left pid sid=""
  set +e
  if [ -n "$standin_pid" ]; then kill "$standin_pid" 2>/dev/null; wait "$standin_pid" 2>/dev/null; fi
  sid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$home/.thimble/server.json" 2>/dev/null | head -n 1)"
  if [ -x "$tree/plugin/bin/thimble" ]; then
    (cd "$out" && in_env "$tree/plugin/bin/thimble" server stop --yes) > "$logs/stop.log" 2>&1
  fi
  left="$(ours "$sid")"
  for pid in $left; do kill "$pid" 2>/dev/null; done
  [ -z "$left" ] || sleep 2
  for pid in $(ours "$sid"); do kill -9 "$pid" 2>/dev/null; done
  left="$(ours "$sid" | tr '\n' ' ')"
  if [ -z "${left// /}" ]; then record cleanup pass "no process of this run is left"
  else record cleanup fail "still running: $left"; fi
  if [ "$keep_install" = 0 ]; then rm -rf "$clone" "$home" "$out/release"; fi
  python3 -I "$here/e2e/report.py" "$results" "$out/report.md" --ref "$ref" --commit "$commit" --started "$started" \
    --seconds "$((SECONDS - t0))" $([ "$strict" = 1 ] && echo --strict)
  local verdict=$?
  say "report: $out/report.md"
  if [ "$rc" = 0 ]; then rc=$verdict; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "thimble $ref (${commit:-no commit recorded}) from ${zip_file:-$repo} → $out"

# 1. a fresh clone, and the release zip when one is asked for
if [ -z "$zip_file" ]; then
  if git -C "$repo" show-ref --verify -q "refs/heads/$ref"; then
    git clone -q --branch "$ref" --single-branch "$repo" "$clone" > "$logs/clone.log" 2>&1
  else
    git clone -q "$repo" "$clone" > "$logs/clone.log" 2>&1 && git -C "$clone" checkout -q --detach "$commit"
  fi
  if [ "$(git -C "$clone" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then record clone pass "$(git -C "$clone" log -1 --format='%h %s')"
  else record clone fail "see logs/clone.log"; exit 1; fi
fi
if [ "$zip" = 1 ]; then
  if (cd "$clone" && in_env bash scripts/release.sh --out "$out/release") > "$logs/release.log" 2>&1 \
     && zip_file="$(ls "$out"/release/thimble-*.zip 2>/dev/null | head -n 1)" && [ -n "$zip_file" ]; then
    record zip pass "$(basename "$zip_file") from scripts/release.sh"
  else
    record zip fail "scripts/release.sh made no zip (logs/release.log)"; exit 1
  fi
fi
src_tree="$clone"
if [ -n "$zip_file" ]; then
  mkdir -p "$out/release/unzipped"
  unzip -q "$zip_file" -d "$out/release/unzipped" || { record zip fail "could not unzip $zip_file"; exit 1; }
  src_tree="$(ls -d "$out"/release/unzipped/thimble-* | head -n 1)"
fi

# 2. install.sh, every question answered by its flag
if [ -z "$plugin" ]; then if command -v claude >/dev/null; then plugin=yes; else plugin=no; fi; fi
flags=(--browser bundled --no-sandbox-deps --trust-workspaces "--$([ "$plugin" = yes ] && echo plugin || echo no-plugin)")
if (cd "$src_tree" && in_env bash scripts/install.sh "${flags[@]}") < /dev/null > "$logs/install.log" 2>&1; then
  if [ -L "$home/.local/bin/thimble" ] && [ -f "$tree/frontend/dist/index.html" ] && [ -x "$tree/backend/.venv/bin/python" ]; then
    record install pass "install.sh ${flags[*]}$([ "$tree" = "$clone" ] && echo ', a Dev install of the clone' || echo ", a Global install at home/.thimble/app")"
  else
    record install fail "install.sh exited 0 without ~/.local/bin/thimble, frontend/dist or backend/.venv; see logs/install.log"; exit 1
  fi
else
  record install fail "install.sh exited non-zero; see logs/install.log"; exit 1
fi
if [ "$plugin" = yes ]; then
  if grep -q '"thimble@thimble' "$home/.claude/settings.json" 2>/dev/null; then record plugin pass "thimble's plugin in the throwaway ~/.claude/settings.json"
  else record plugin fail "install.sh --plugin left no thimble plugin in the throwaway ~/.claude/settings.json"; fi
fi

# 3. thimble doctor
if (cd "$out" && in_env thimble doctor) > "$logs/doctor.txt" 2>&1; then
  missing=""
  grep -q "^  versions: thimble " "$logs/doctor.txt" || missing="$missing versions"
  grep -q "^  ui: .*the built UI at $tree/frontend/dist" "$logs/doctor.txt" || missing="$missing ui"
  grep -q "^  home: $home/.thimble (THIMBLE_HOME)" "$logs/doctor.txt" || missing="$missing home"
  grep -q "^  python: $tree/backend/.venv" "$logs/doctor.txt" || missing="$missing python"
  if [ -z "$missing" ]; then record doctor pass "logs/doctor.txt; $(grep -m1 '^  auth:' "$logs/doctor.txt" | sed 's/^ *//')"
  else record doctor fail "doctor's lines missing or wrong:$missing (logs/doctor.txt)"; fi
else
  record doctor fail "thimble doctor exited non-zero (logs/doctor.txt)"
fi

# 4. the corpus copy, the files the UI steps open, and the fixture view
mkdir -p "$out/corpus"
if [ -n "$corpus" ]; then
  work="$out/corpus/$(basename "$corpus")"
  cp -R "$corpus" "$work"
else
  work="$out/corpus/toy-incident"
  python3 -I "$src/scripts/dev/make_toy_corpus.py" --out "$work" > "$logs/corpus.log" 2>&1
fi
python3 -I "$here/e2e/extra_files.py" "$work" >> "$logs/corpus.log" 2>&1
record corpus pass "$(find "$work" -type f | wc -l | tr -d ' ') files in a copy at corpus/$(basename "$work")"

# 5. the server, the workspace and the stand-in session
if (cd "$work" && in_env thimble server up) > "$logs/server-up.log" 2>&1 && grep -q "^thimble: http" "$logs/server-up.log"; then
  ws="$(cd "$tree/backend" && in_env "$tree/backend/.venv/bin/python" -I "$here/e2e/workspace.py" "$tree" "$work" 2> "$logs/workspace.log")" || ws=""
  if [ -n "$ws" ]; then record server pass "the server on port $port, workspace $(printf '%s' "$ws" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  else record server fail "the workspace was not registered (logs/workspace.log)"; exit 1; fi
else
  record server fail "thimble server up printed no URL (logs/server-up.log)"; exit 1
fi
in_env "$tree/backend/.venv/bin/python" -I "$here/e2e/standin_session.py" "$tree" "$work" > "$logs/standin.log" 2>&1 &
standin_pid=$!

# 6. the UI, the extension commands among its steps
ui=0
(cd "$out" && in_env THIMBLE_E2E_TREE="$tree" THIMBLE_E2E_CORPUS="$work" THIMBLE_E2E_WS="$ws" \
  THIMBLE_E2E_SHOTS="$shots" THIMBLE_E2E_RESULTS="$results" THIMBLE_E2E_FIXTURE="$here/e2e/fixture-extension" \
  node "$here/e2e/release.mjs") > "$logs/ui.log" 2>&1 || ui=$?
[ "$ui" = 0 ] || say "the UI walk exited $ui (logs/ui.log)"
