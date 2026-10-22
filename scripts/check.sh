#!/bin/bash
# check.sh [STEP...]: the checks CI runs, for a contributor to run before a push. The steps, all by default:
#
#   the terminal plugin (plugin/):
#   validate   claude plugin validate plugin: the manifest, the hooks module and its types contract
#   plugin     claude plugin test plugin: the hooks tests (plugin/tests/*.test.ts)
#   node       node --test over every *.test.mjs under plugin/
#   python     pytest over plugin/ (the kernel)
#
#   the browser workbench (browser/):
#   parity     the browser's shared prompts still apply to the plugin's texts (browser/prompts/shared.json)
#   server     the server's tests (browser/server/tests); the sandbox tests need scripts/install.sh to have run
#   page       the page's type check, unit tests and build (browser/frontend), after npm ci when its packages are missing
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

for step in "${steps[@]}"; do
  printf '\n== %s\n' "$step"
  case "$step" in
    validate) CLAUDE_CONFIG_DIR="$fresh/claude" DISABLE_AUTOUPDATER=1 claude plugin validate plugin ;;
    plugin) CLAUDE_CONFIG_DIR="$fresh/claude" DISABLE_AUTOUPDATER=1 claude plugin test plugin ;;
    node)
      files=()
      while IFS= read -r f; do files+=("$f"); done < <(find plugin -name '*.test.mjs' -not -path '*/node_modules/*' | sort)
      node --test "${files[@]}" ;;
    python) "$THIMBLE_PYTHON" -m pytest plugin -q -p no:cacheprovider ;;
    parity) (cd browser/server && uv run --quiet --locked --extra dev pytest -q -p no:cacheprovider tests/test_prompt_parity.py) ;;
    server) (cd browser/server && uv run --quiet --locked --extra dev pytest -q -p no:cacheprovider) ;;
    page)
      [ -d browser/frontend/node_modules ] || npm --prefix browser/frontend ci --no-audit --no-fund
      (cd browser/frontend && npm run --silent typecheck && npx vitest run && npx vite build --logLevel warn) ;;
    *) echo "check.sh: no step $step (the steps: validate, plugin, node, python, parity, server, page)" >&2; exit 2 ;;
  esac
done
