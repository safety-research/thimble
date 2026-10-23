#!/bin/bash
# check.sh [STEP...]: the checks CI runs, for a contributor to run before a push. The steps, all by default:
#
#   the terminal plugin (plugin/):
#   validate   claude plugin validate plugin: the manifest, the hooks module and its types contract
#   plugin     claude plugin test plugin: the hooks tests (plugin/tests/*.test.ts)
#   node       node --test over every *.test.mjs under plugin/; the card runner's tests start it in its sandbox, which
#              they install in the step's THIMBLE_HOME (plugin/sandbox/setup.mjs; on Linux it needs bubblewrap, socat and
#              ripgrep)
#   python     pytest over plugin/ (the kernel)
#
#   the browser workbench (browser/, thimble 0.8's browser mode):
#   parity     the browser's prompts: each renders and names only the hints the code has, and the API's names are
#              American (browser/backend/tests_public/test_prompts.py, test_american_names.py)
#   server     the server's tests (browser/backend/tests_public), in parallel, without the caller's THIMBLE_* settings;
#              the sandbox tests need scripts/install.sh to have run
#   page       the page's type check, unit tests and build (browser/frontend), after npm ci when its packages are missing
#
# Each test has a time limit, so a test that hangs fails with its name: 120 s for node --test and pytest (the browser's
# in browser/backend/pyproject.toml; the plugin's when pytest-timeout is installed), and vitest's testTimeout (10 s) for
# the page.
#
# The plugin's steps need claude (Claude Code 2.1.307 or later), node 22.18 or later, and Python 3.10 or later with pytest:
# THIMBLE_PYTHON, else python3. The browser's steps need uv and node 22.12 or later. Each step runs with a Claude Code
# config folder and a THIMBLE_HOME of its own, made fresh and deleted after, so it never reads or writes your own; the
# server's tests give each test a thimble browser home of its own.
set -euo pipefail
cd "$(dirname "$0")/.."
export THIMBLE_PYTHON="${THIMBLE_PYTHON:-python3}"
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(validate plugin node python parity server page)

fresh=$(mktemp -d)
trap 'rm -rf "$fresh"' EXIT
mkdir -p "$fresh/claude" "$fresh/thimble"
export THIMBLE_HOME="$fresh/thimble"

# browser_tests ARGS...: pytest in browser/backend with the test extras, without the caller's THIMBLE_* settings and API
# keys, so that a shell that runs a server or holds a key cannot point the tests at its data or let a test reach the API
browser_tests() {
  (
    for v in $(compgen -e | grep -E '^(THIMBLE_|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)' || true); do unset "$v"; done
    cd browser/backend && uv sync --quiet --frozen --no-dev --no-install-project --extra dev &&
      THIMBLE_SKIP_KEY=1 .venv/bin/python -m pytest -q -p no:cacheprovider "$@"
  )
}

for step in "${steps[@]}"; do
  printf '\n== %s\n' "$step"
  case "$step" in
    validate) CLAUDE_CONFIG_DIR="$fresh/claude" DISABLE_AUTOUPDATER=1 claude plugin validate plugin ;;
    plugin) CLAUDE_CONFIG_DIR="$fresh/claude" DISABLE_AUTOUPDATER=1 claude plugin test plugin ;;
    node)
      files=()
      while IFS= read -r f; do files+=("$f"); done < <(find plugin -name '*.test.mjs' -not -path '*/node_modules/*' | sort)
      node --test --test-timeout=120000 "${files[@]}" ;;
    python)
      limit=()  # with pytest-timeout (CI installs it), a test that runs past 120 s fails with its name and its stack
      if "$THIMBLE_PYTHON" -c 'import pytest_timeout' 2>/dev/null; then limit=(--timeout=120 --timeout-method=thread)
      else echo "pytest-timeout is not installed, so a test that hangs holds the run"; fi
      "$THIMBLE_PYTHON" -m pytest plugin -q -p no:cacheprovider ${limit[@]+"${limit[@]}"} ;;
    parity) browser_tests tests_public/test_prompts.py tests_public/test_american_names.py ;;
    server)
      # one worker per CPU, at most 8 (THIMBLE_TEST_WORKERS sets another count): the tests that time a page, a kernel or
      # a hold fail when more workers than CPUs share the machine, as on CI's 4-CPU runner
      cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)
      browser_tests -n "${THIMBLE_TEST_WORKERS:-$((cpus < 8 ? cpus : 8))}" tests_public ;;
    page)
      [ -d browser/frontend/node_modules ] || npm --prefix browser/frontend ci --no-audit --no-fund
      # the build goes to a temporary folder, so the frontend/dist a running server serves is left alone
      (cd browser/frontend && npm run --silent typecheck && npx vitest run && npx vite build --outDir "$fresh/dist" --emptyOutDir --logLevel warn) ;;
    *) echo "check.sh: no step $step (the steps: validate, plugin, node, python, parity, server, page)" >&2; exit 2 ;;
  esac
done
