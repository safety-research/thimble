---
name: shared
description: Loads thimble's shared guidance for this corpus (what thimble is, how its agents communicate with the analyst, what makes a good card, when to use a label and how to cite), which main's and the orientation's prompts already include.
user-invocable: false
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble prompt *) Bash(true)
---

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble prompt preamble shared --cwd "${CLAUDE_PROJECT_DIR}" 2>&1 || true`
