#!/usr/bin/env bash
# scripts/e2e_release.sh — the release's end-to-end test: a clean install from a fresh clone, then thimble's UI walked
# in a headless browser on a copy of a corpus, with a screenshot and a pass or fail for each step.
#
#   scripts/e2e_release.sh [--ref REF] [--repo PATH] [--zip | --zip-file ZIP] [--out DIR] [--port N] [--corpus DIR]
#                          [--own-caches] [--strict] [--keep-install]
#
#   --ref REF        the branch or commit to clone (default: the branch this checkout has out)
#   --repo PATH      the git repository to clone it from (default: this checkout)
#   --zip            install the release zip scripts/release.sh builds from the clone, as a Global install into the
#                    run's THIMBLE_HOME/app, in place of installing the clone itself (a Dev install)
#   --zip-file ZIP   install this release zip as a Global install; nothing is cloned
#   --out DIR        where the run goes: report.md, shots/, logs/, and the clone, THIMBLE_HOME and corpus copy it
#                    installs and runs on (default: a new folder under $TMPDIR). It must be empty or missing
#   --port N         the server's port (default: the first of 8470, 8472, ... 8498 that is free with the one after it);
#                    N+1 is its UI port, which only dev mode listens on
#   --corpus DIR     the folder to copy and open (default: the synthetic corpus scripts/dev/make_toy_corpus.py writes)
#   --own-caches     download into <out>/caches (uv, npm, Playwright's browsers); by default those caches are the
#                    caller's, so packages and the browser already downloaded are not fetched again
#   --strict         count a failing step that waits for unmerged work (`pending` in the report) as a failure
#   --keep-install   leave the clone and THIMBLE_HOME in --out (the report, shots and logs always stay)
#
# Steps: clone REF into <out>/clone; install it (or the zip) with install.sh's flags, non-interactive, into a fresh
# THIMBLE_HOME (<out>/thimble-home) with --no-plugin; `thimble doctor`; copy the corpus to
# <out>/corpus, add a few files the UI steps open (chat logs in Markdown, CSV and SQLite, a PDF) and a fixture view;
# start the server and a stand-in for the analyst's Claude Code session (scripts/e2e/standin_session.py: no model runs);
# walk the UI (scripts/e2e/release.mjs): the first-launch welcome and the tour, the File browser, a transcript, a PDF, the
# fixture view, Settings > Extensions, then `thimble extension add` of scripts/e2e/fixture-extension switched off and on
# from the CLI and from Settings. No model runs in the walk: when Settings offers to run the extension's orientation
# instructions, a run record and a chat in the workspace stand in for an orientation that ran as a subagent of main,
# first of an earlier Claude Code session, then of the stand-in's session (THIMBLE_E2E_SESSION, the id this script gives
# the stand-in and the walk). Every process it started is stopped on exit, and <out>/report.md lists each step.
#
# With THIMBLE_LIVE_CLAUDE=1 two contract checks against Claude Code follow the UI walk, so that a Claude Code update
# that changes a format thimble reads fails the release; without it each is reported as skipped:
#   - the `claude -p` format check (scripts/e2e/contract_print.py): the hook fields, the two-stop shape and the hand-back,
#     a nested agent's parentAgentId, the task notification, the MCP `_meta` tool-use id, the result line's
#     contextWindow and subagent_stats, Claude Code's concurrency-limit text, and that thimble's hooks module registers
#     nothing in -p and the run ends within 2 s of its last result line; its stand-in server takes the first free port
#     after the UI port;
#   - the interactive check of the hooks module (scripts/e2e/contract_module.py), with the server stopped and run inside
#     the check, the stand-in session stopped, and the launcher in `tmux -L $THIMBLE_E2E_SOCKET` (default
#     thimble-e2e-<port>): the module's hello and thimble's types in main's first agent listing, a spawn through the
#     bridge on exact values, its toolu_plugin_ id, a deny, the hand-back, the descendants' values, a follow-up, /clear,
#     a stop, the classifier smoke and the quit. Claude Code must trust the folder main runs in, and the check never
#     answers its trust question yes, so set THIMBLE_E2E_TRUSTED_DIR to a folder Claude Code trusts: the corpus copy for
#     this check goes into a new folder there, removed on exit. Both run models on the caller's own Claude login.
#
# The run keeps the caller's HOME, so thimble and claude use the caller's own Claude login and config, and it leaves
# them as they were: it puts the `thimble` link in <out>/bin (THIMBLE_BIN_DIR) in place of ~/.local/bin, passes
# --no-modify-path so that no shell startup file gets a line, and installs only when install.sh --dry-run plans no
# `claude plugin` command, no write to ~/.local/bin/thimble and no line in a startup file. The last step checks that
# Claude Code's plugins and marketplaces, its trusted folders, ~/.local/bin/thimble and the lines thimble's installer
# added to the startup files are as they were before the run.
#
# A step marked pending waits for work that is not merged yet: its failure is reported as expected and does not fail the
# run (unless --strict), and once it passes the report says so. Exit 0 when no step failed, 1 otherwise.
set -euo pipefail
{  # the whole script is read before it runs, so a change to this file during a run does not reach it

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf 'e2e: %s\n' "$*"; }
die() { printf 'e2e_release.sh: %s\n' "$*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
src="$(cd "$here/.." && pwd -P)"
ref="" repo="" out="" port="" corpus="" own_caches=0 strict=0 keep_install=0 zip=0 zip_file="" trusted_copy=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift 2;;
    --repo) repo="$2"; shift 2;;
    --zip) zip=1; shift;;
    --zip-file) zip_file="$2"; shift 2;;
    --out) out="$2"; shift 2;;
    --port) port="$2"; shift 2;;
    --corpus) corpus="$2"; shift 2;;
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
busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ -z "$port" ]; then
  for p in $(seq 8470 2 8498); do if ! busy "$p" && ! busy $((p + 1)); then port=$p; break; fi; done
  [ -n "$port" ] || die "no free pair of ports from 8470 to 8499; pick one with --port"
fi
case "$port" in *[!0-9]*) die "--port takes a number";; esac
command -v node >/dev/null || die "node is required"
command -v python3 >/dev/null || die "python3 is required"
[ -z "$corpus" ] || [ -d "$corpus" ] || die "--corpus $corpus is not a folder"
if [ -z "$out" ]; then out="$(mktemp -d "${TMPDIR:-/tmp}/thimble-e2e.XXXXXX")"; fi
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
[ -z "$(ls -A "$out")" ] || die "--out $out is not empty"
for p in "$port" $((port + 1)); do
  if busy "$p"; then die "port $p is in use; pick another with --port"; fi
done

clone="$out/clone" thome="$out/thimble-home" bin="$out/bin" logs="$out/logs" shots="$out/shots" results="$out/results.jsonl"
# the tree thimble runs from: the clone itself, or the Global install a zip makes
tree="$clone"
if [ "$zip" = 1 ] || [ -n "$zip_file" ]; then tree="$thome/app"; fi
mkdir -p "$thome" "$bin" "$logs" "$shots"
chmod 700 "$thome"
: > "$results"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t0=$SECONDS
standin_pid="" walk_pid=""

# record STEP STATUS DETAIL [SHOT]: one line of results.jsonl (scripts/e2e/report.py reads them)
record() {
  python3 -I -c 'import json, sys; print(json.dumps({"step": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3],
"shots": [s for s in sys.argv[4:] if s]}))' "$1" "$2" "$3" "${4:-}" >> "$results"
  say "$1: $2${3:+ ($3)}"
}

# the run's environment: the caller's, with its HOME and Claude config, less thimble's variables and those that name the
# Claude Code session it runs in; a fresh THIMBLE_HOME, this run's ports, and <out>/bin first on PATH
unset_vars=()
while IFS= read -r v; do
  case "$v" in THIMBLE_* | CLAUDECODE | CLAUDE_PID | CLAUDE_EFFORT | CLAUDE_CODE_ENTRYPOINT | CLAUDE_CODE_EXECPATH \
    | CLAUDE_CODE_SESSION_* | CLAUDE_CODE_CHILD_SESSION | CLAUDE_CODE_MESSAGING_* | CLAUDE_CODE_BRIDGE_*) unset_vars+=(-u "$v");; esac
done < <(compgen -e)
caches=()
if [ "$own_caches" = 1 ]; then
  caches=("UV_CACHE_DIR=$out/caches/uv" "npm_config_cache=$out/caches/npm" "PLAYWRIGHT_BROWSERS_PATH=$out/caches/ms-playwright")
fi
envs=(env ${unset_vars[@]+"${unset_vars[@]}"} "PATH=$bin:$PATH" "THIMBLE_HOME=$thome" "THIMBLE_BIN_DIR=$bin"
      "THIMBLE_PORT=$port" "THIMBLE_UI_PORT=$((port + 1))" ${caches[@]+"${caches[@]}"})
in_env() { "${envs[@]}" "$@"; }

ours() {  # the processes this run started that may still run: the server's session (it starts as its own session
  # leader), the UI walk's process group, and anything running from the clone, the unzipped release or THIMBLE_HOME
  local sid="$1"
  { [ -z "$sid" ] || ps -eo pid=,sid= | awk -v s="$sid" '$2 == s {print $1}'
    [ -z "$walk_pid" ] || ps -eo pid=,pgid= | awk -v g="$walk_pid" '$2 == g {print $1}'
    pgrep -f -- "$clone/" || true; pgrep -f -- "$thome/" || true; pgrep -f -- "$out/release/" || true; } | sort -u | grep -vx "$$" || true
}

claude_files() { python3 -I "$here/e2e/claude_files.py" "$out" "$@"; }

files_before=""  # the file holding what claude_files.py printed before the install
cleanup() {
  local rc=$? left pid sid="" changed
  set +e
  if [ -n "$standin_pid" ]; then kill "$standin_pid" 2>/dev/null; wait "$standin_pid" 2>/dev/null; fi
  sid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$thome/server.json" 2>/dev/null | head -n 1)"
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
  if [ -n "$files_before" ]; then
    if changed="$(claude_files --against "$files_before" 2>&1)"; then
      record claude-files pass "Claude Code's plugins, marketplaces and trusted folders, ~/.local/bin/thimble and the shell startup files as before the run"
    else record claude-files fail "changed during the run: $changed"; fi
  fi
  if [ "$keep_install" = 0 ]; then rm -rf "$clone" "$thome" "$bin" "$out/release"; fi
  [ -z "$trusted_copy" ] || rm -rf "$trusted_copy"
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

# 2. install.sh, every question answered by its flag, once its dry run shows it leaves the caller's files alone
if ! claude_files > "$logs/claude-files-before.json" 2>&1; then
  record claude-files fail "could not read Claude Code's files: $(tail -n 1 "$logs/claude-files-before.json")"; exit 1
fi
files_before="$logs/claude-files-before.json"
flags=(--browser bundled --no-sandbox-deps --no-plugin --no-modify-path)
# --verbose: the dry run then prints every step's commands, which the check below reads
if ! (cd "$src_tree" && in_env bash scripts/install.sh "${flags[@]}" --dry-run --verbose) < /dev/null > "$logs/install-plan.log" 2>&1; then
  record install fail "install.sh --dry-run exited non-zero; see logs/install-plan.log"; exit 1
fi
planned="$(grep -E '^\+ claude plugin ' "$logs/install-plan.log" || true)"
planned="$planned$(grep -F -- "$HOME/.local/bin/thimble" "$logs/install-plan.log" | grep -E '^\+ ' || true)"
planned="$planned$(grep -E '^\+ append to ' "$logs/install-plan.log" || true)"
if [ -n "$planned" ]; then
  record install fail "not installed: install.sh's dry run plans changes to the caller's files: $(printf '%s' "$planned" | head -n 3 | tr '\n' ';')"; exit 1
fi
if (cd "$src_tree" && in_env bash scripts/install.sh "${flags[@]}") < /dev/null > "$logs/install.log" 2>&1; then
  if [ -L "$bin/thimble" ] && [ -f "$tree/frontend/dist/index.html" ] && [ -x "$tree/backend/.venv/bin/python" ]; then
    record install pass "install.sh ${flags[*]}$([ "$tree" = "$clone" ] && echo ', a Dev install of the clone' || echo ", a Global install at thimble-home/app")"
  else
    record install fail "install.sh exited 0 without bin/thimble, frontend/dist or backend/.venv; see logs/install.log"; exit 1
  fi
else
  record install fail "install.sh exited non-zero; see logs/install.log"; exit 1
fi

# 3. thimble doctor
if (cd "$out" && in_env thimble doctor) > "$logs/doctor.txt" 2>&1; then
  missing=""
  grep -q "^  versions: thimble " "$logs/doctor.txt" || missing="$missing versions"
  grep -q "^  ui: .*the built UI at $tree/frontend/dist" "$logs/doctor.txt" || missing="$missing ui"
  grep -q "^  home: $thome (THIMBLE_HOME)" "$logs/doctor.txt" || missing="$missing home"
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
standin_sid="$(python3 -I -c 'import uuid; print(uuid.uuid4())')"
in_env THIMBLE_E2E_SESSION="$standin_sid" "$tree/backend/.venv/bin/python" -I "$here/e2e/standin_session.py" "$tree" "$work" \
  > "$logs/standin.log" 2>&1 &
standin_pid=$!

# 6. the UI, the extension commands among its steps
ui=0
walk=(node "$here/e2e/release.mjs")
if command -v setsid >/dev/null; then walk=(setsid "${walk[@]}"); fi  # its own process group, so cleanup finds its browser
(cd "$out" && exec "${envs[@]}" THIMBLE_E2E_TREE="$tree" THIMBLE_E2E_CORPUS="$work" THIMBLE_E2E_WS="$ws" \
  THIMBLE_E2E_SESSION="$standin_sid" THIMBLE_E2E_SHOTS="$shots" THIMBLE_E2E_RESULTS="$results" THIMBLE_E2E_FIXTURE="$here/e2e/fixture-extension" \
  "${walk[@]}") > "$logs/ui.log" 2>&1 &
walk_pid=$!
wait "$walk_pid" || ui=$?
[ "$ui" = 0 ] || say "the UI walk exited $ui (logs/ui.log)"

# 7. the `claude -p` contract check, with THIMBLE_LIVE_CLAUDE=1: a stand-in server of its own on the first free port
#    after the UI port, and its runs' streams, hooks and transcripts in <out>/contract-print
if [ "${THIMBLE_LIVE_CLAUDE:-}" = 1 ]; then
  stub_port=""
  for p in $(seq $((port + 2)) $((port + 40))); do if ! busy "$p"; then stub_port=$p; break; fi; done
  if [ -z "$stub_port" ]; then
    record contract-print fail "no free port from $((port + 2)) to $((port + 40)) for its stand-in server"
  elif ! (cd "$out" && in_env "$tree/backend/.venv/bin/python" -I "$here/e2e/contract_print.py" "$tree" \
          "$out/contract-print" --port "$stub_port" --results "$results") > "$logs/contract-print.log" 2>&1 \
       && ! grep -q '"step": "contract-print-' "$results"; then
    record contract-print fail "the check stopped before its assertions (logs/contract-print.log)"
  fi
else
  record contract-print skip "THIMBLE_LIVE_CLAUDE is not 1"
fi

# 8. the interactive contract check of the hooks module, with THIMBLE_LIVE_CLAUDE=1: the stand-in session and the
#    server stop, and the check runs the server itself; the corpus is copied into THIMBLE_E2E_TRUSTED_DIR when it is set
if [ "${THIMBLE_LIVE_CLAUDE:-}" = 1 ]; then
  if [ -n "$standin_pid" ]; then kill "$standin_pid" 2>/dev/null || true; wait "$standin_pid" 2>/dev/null || true; standin_pid=""; fi
  (cd "$out" && in_env "$tree/plugin/bin/thimble" server stop --yes) > "$logs/contract-server-stop.log" 2>&1 || true
  mod_corpus="$work"
  if [ -n "${THIMBLE_E2E_TRUSTED_DIR:-}" ]; then
    if trusted_copy="$(mktemp -d "${THIMBLE_E2E_TRUSTED_DIR%/}/thimble-e2e.XXXXXX")"; then
      mod_corpus="$trusted_copy/$(basename "$work")"
      cp -R "$work" "$mod_corpus"
    else
      trusted_copy=""
      say "could not make a folder in THIMBLE_E2E_TRUSTED_DIR=$THIMBLE_E2E_TRUSTED_DIR; the check runs in the corpus copy"
    fi
  fi
  if ! (cd "$out" && in_env "$tree/backend/.venv/bin/python" -I "$here/e2e/contract_module.py" "$tree" "$mod_corpus" \
        "$out/contract-module" --results "$results" --socket "${THIMBLE_E2E_SOCKET:-thimble-e2e-$port}") \
        > "$logs/contract-module.log" 2> "$logs/contract-module-server.log" \
     && ! grep -q '"step": "contract-module-' "$results"; then
    record contract-module fail "the check stopped before its assertions (logs/contract-module.log)"
  fi
else
  record contract-module skip "THIMBLE_LIVE_CLAUDE is not 1"
fi
}
