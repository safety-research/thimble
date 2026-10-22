#!/bin/sh
# temp-allow.sh: the PreToolUse command hook of hooks.json (temp_allow.py), with the Python that bin/thimble runs:
# THIMBLE_PYTHON, else the plugin's own .venv, else python3. No Python: no answer, and Claude Code decides as it would.
here=$(cd "$(dirname "$0")/.." && pwd)
py=${THIMBLE_PYTHON:-}
if [ -z "$py" ] && [ -x "$here/.venv/bin/python" ]; then py="$here/.venv/bin/python"; fi
"${py:-python3}" -I "$here/hooks/temp_allow.py" 2>/dev/null
exit 0
