"""Every lean test runs with a THIMBLE_HOME of its own, so a test (or a `thimble` it starts) never writes into the
person's ~/.thimble. The node side is test-home.mjs. It sits at lean/, above tests/ and verbs/, so it covers both."""
import os
import tempfile
from pathlib import Path

_real = str(Path.home() / ".thimble")
if not os.environ.get("THIMBLE_HOME") or os.environ.get("THIMBLE_HOME") == _real:
    os.environ["THIMBLE_HOME"] = tempfile.mkdtemp(prefix="thimble-test-home-")
