"""A card's script, run again on a click, as the mod runs it (hooks/register.tsx rerunCard): it must not write outside
the folder's .thimble-cc-mod/, nor change the corpus. `python3 tests/test_sandbox.py` (no dependencies)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")

ESCAPE = """import json, os, sys
sys.path.insert(0, {helper!r})
from tcard import card
tried = {{}}
for name, path in (("outside", {outside!r}), ("corpus", {corpus!r})):
    try:
        with open(path, "a") as f:
            f.write("written by a card's script\\n")
        tried[name] = "wrote"
    except OSError as e:
        tried[name] = type(e).__name__
card("bar", "How many?", rows=[("a", 1)])
print("TRIED " + json.dumps(tried))
"""


def rerun(cwd: str, script: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """A card's script run again, as rerunCard runs it: python3 in the folder, the card's choices in the environment."""
    extra = {"THIMBLE_CC_MOD_PARAMS": "{}", "THIMBLE_CC_MOD_ONLY": "0:abc123", "THIMBLE_CC_MOD_ROOT": cwd}
    return subprocess.run(["python3", script], cwd=cwd, env={**os.environ, **extra, **(env or {})},
                          capture_output=True, text=True, timeout=180)


def _corpus(root: str, outside: str) -> tuple[str, str]:
    corpus = os.path.join(root, "pages.jsonl")
    with open(corpus, "w") as f:
        f.write('{"name": "Main"}\n')
    scripts = os.path.join(root, ".thimble-cc-mod", "scripts")
    os.makedirs(scripts)
    script = os.path.join(".thimble-cc-mod", "scripts", "escape.py")
    with open(os.path.join(root, script), "w") as f:
        f.write(ESCAPE.format(helper=HELPER, outside=os.path.join(outside, "written.txt"), corpus=corpus))
    return corpus, script


def test_a_rerun_writes_only_under_thimble_cc_mod() -> None:
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        corpus, script = _corpus(root, outside)
        r = rerun(root, script)
        assert r.returncode == 0, r.stderr
        tried = json.loads(next(line for line in r.stdout.splitlines() if line.startswith("TRIED "))[6:])
        assert not os.path.exists(os.path.join(outside, "written.txt")), f"the rerun wrote outside the folder: {tried}"
        with open(corpus) as f:
            assert f.read() == '{"name": "Main"}\n', f"the rerun changed the corpus: {tried}"
        assert "wrote" not in tried.values(), tried
        # what it may write, it wrote: the card, under .thimble-cc-mod/
        assert len(os.listdir(os.path.join(root, ".thimble-cc-mod", "cards"))) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
