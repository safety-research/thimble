"""The `thimble` command's entry: bin/thimble runs this file with Python 3.10 or later. A command in Claude Code's Bash
sandbox, which may not write thimble's home, is run by the plugin outside it (kernel/handoff.py)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel.cli import main  # noqa: E402
from kernel.handoff import handed_off  # noqa: E402

if __name__ == "__main__":
    code = handed_off(sys.argv[1:])
    sys.exit(main(sys.argv[1:]) if code is None else code)
