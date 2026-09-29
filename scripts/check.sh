#!/usr/bin/env bash
# scripts/check.sh — the checks every change must pass. CI runs them on each push and pull request; run them locally
# before you open one.
#
#   scripts/check.sh [STEP...]
#
#   install   backend/.venv with the test extras (uv), frontend/node_modules (npm ci), and the headless Chromium that
#             the renderer's, the views' and the browser checks drive (its system libraries are the machine's; GitHub's
#             Ubuntu runners have them)
#   content   no secrets, files that never belong in the tree, or file names that only case tells apart (Checks.tsx
#             beside checks.ts, which a case-insensitive disk resolves as one module) (scripts/check_content.py, with
#             gitleaks when it is installed)
#   backend   the backend's tests (backend/tests_public): hermetic, with no network, no Claude Code and no API key
#   frontend  the type check of the UI and of its tests, the frontend's tests (frontend/tests/public) and the production
#             build, into a temporary folder so that the frontend/dist a running server serves is left alone
#   browser   the frontend's browser checks (frontend/tests/public/browser) in the headless Chromium: the sandboxed
#             outputs and a view's label marks; skipped, with a line saying so, where that Chromium does not start (CI
#             requires it)
#
# With no STEP it runs content, backend, frontend and browser in that order and stops at the first that fails. In a
# fresh checkout run `scripts/check.sh install` once first (or scripts/install.sh, which installs the same things there).
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
here="$repo/scripts"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

step() { printf '\n== %s\n' "$*"; }
die() { echo "check.sh: $*" >&2; exit 1; }
need() {  # need PATH HINT: stop with HINT when PATH is missing
  [ -e "$1" ] || die "$2"
}

install() {
  step "install"
  command -v uv >/dev/null || die "uv is required: https://docs.astral.sh/uv/getting-started/installation/"
  command -v npm >/dev/null || die "Node 20+ with npm is required"
  # the same sync install.sh runs in a checkout: the runtime closure of uv.lock plus the test extras
  (cd "$repo/backend" && uv sync --frozen --no-dev --no-install-project --extra dev)
  (cd "$repo/frontend" && npm ci --no-audit --no-fund)
  # the backend's and the frontend's Playwright pin different builds of the browser: the card harness (app/render.py)
  # drives the first, a view's check page (scripts/view_shot.mjs) the second
  (cd "$repo/backend" && .venv/bin/python -m playwright install chromium-headless-shell)
  (cd "$repo/frontend" && npx playwright install chromium-headless-shell)
}

content() {
  step "content"
  local gitleaks=""
  if ! command -v gitleaks >/dev/null; then
    [ "${CI:-}" = true ] && die "gitleaks is not installed"
    echo "gitleaks is not installed, so the secret scan is skipped here (CI runs it)"
    gitleaks=--no-gitleaks
  fi
  python3 "$here/check_content.py" "$repo" $gitleaks
}

backend() {
  step "backend"
  local py="$repo/backend/.venv/bin/python"
  need "$py" "backend/.venv is missing: run scripts/check.sh install"
  "$py" -c "import pytest" 2>/dev/null || die "pytest is not installed in backend/.venv: run scripts/check.sh install"
  # the suite runs without the caller's THIMBLE_* settings and API keys, so a shell that runs a server or holds a key
  # cannot point the tests at its data or let a test reach the API
  (
    for v in $(compgen -e | grep -E '^(THIMBLE_|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)' || true); do unset "$v"; done
    cd "$repo/backend" && THIMBLE_SKIP_KEY=1 "$py" -m pytest tests_public -q -p no:cacheprovider
  )
}

frontend() {
  step "frontend"
  local bin="$repo/frontend/node_modules/.bin"
  need "$bin/vitest" "frontend/node_modules is missing or older than package-lock.json: run scripts/check.sh install"
  (cd "$repo/frontend" && "$bin/tsc" -b && "$bin/tsc" -p tsconfig.test.json)
  (cd "$repo/frontend" && "$bin/vitest" run)
  (cd "$repo/frontend" && "$bin/vite" build --outDir "$tmp/dist" --emptyOutDir --logLevel warn)
}

skipped=""
browser() {
  step "browser"
  local bin="$repo/frontend/node_modules/.bin" why
  need "$bin/vitest" "frontend/node_modules is missing or older than package-lock.json: run scripts/check.sh install"
  # one launch of the frontend's Playwright Chromium tells whether it is installed and has the libraries it needs here
  if ! why="$(cd "$repo/frontend" && node -e "require('playwright').chromium.launch().then((b) => b.close(), (e) => { console.log(String(e.message).split('\\n')[0]); process.exit(1) })" 2>&1)"; then
    [ "${CI:-}" = true ] && die "the headless Chromium does not start, so the browser checks cannot run: $why"
    echo "the headless Chromium does not start here, so the browser checks are skipped: $why"
    echo "scripts/check.sh install installs it (or, in frontend/, npx playwright install chromium-headless-shell)"
    skipped=" (browser skipped: no headless Chromium)"
    return 0
  fi
  (cd "$repo/frontend" && "$bin/vitest" run --config vitest.browser.config.ts)
}

steps=""  # a plain word list rather than an array: macOS's bash 3.2 refuses an empty array under set -u
for a in "$@"; do
  case "$a" in
    install|content|backend|frontend|browser) steps="$steps $a";;
    -h|--help) usage; exit 0;;
    *) echo "check.sh: unknown step $a" >&2; usage >&2; exit 2;;
  esac
done
[ -n "$steps" ] || steps="content backend frontend browser"
for s in $steps; do "$s"; done
printf '\ncheck.sh: %s passed%s\n' "${steps# }" "$skipped"
