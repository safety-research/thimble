"""Every plugin test runs with a THIMBLE_HOME of its own, so a test (or a `thimble` it starts) never writes into the
person's ~/.thimble. The node side is test-home.mjs. It sits at the plugin's root, above every test folder, so it covers them all."""
import os
import tempfile
from pathlib import Path

_real = str(Path.home() / ".thimble")
if not os.environ.get("THIMBLE_HOME") or os.environ.get("THIMBLE_HOME") == _real:
    os.environ["THIMBLE_HOME"] = tempfile.mkdtemp(prefix="thimble-test-home-")
# git reads no setting of the person's or the machine's: a global core.hooksPath would run their hooks (a secret scan, a
# policy check) at each of the many commits the tests make, which made the kernel's tests several times slower. A test
# that needs a git setting makes it in its own repository.
os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
