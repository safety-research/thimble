#!/bin/bash
# check.sh [STEP...]: the checks CI runs, for a contributor to run before a push. The steps, all by default:
#
#   validate   claude plugin validate plugin: the manifest, the hooks module and its types contract
#   plugin     claude plugin test plugin: the hooks tests (plugin/tests/*.test.ts)
#   node       node --test over every *.test.mjs under plugin/
#   python     pytest over plugin/ (the kernel)
#
# Needs claude (Claude Code 2.1.301 or later), node 22 or later, and a Python with pandas and pytest: THIMBLE_PYTHON,
# else python3. Each step runs with a Claude Code config folder and a THIMBLE_HOME of its own, made fresh and deleted
# after, so it never reads or writes your own.
set -euo pipefail
cd "$(dirname "$0")/.."
export THIMBLE_PYTHON="${THIMBLE_PYTHON:-python3}"
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(validate plugin node python)

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
    *) echo "check.sh: no step $step (the steps: validate, plugin, node, python)" >&2; exit 2 ;;
  esac
done
