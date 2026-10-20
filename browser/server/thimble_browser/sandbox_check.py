"""`thimble-browser --check-sandbox`: tests the sandbox that card code runs in (cards/sandbox.py) on this machine.

It runs a small card on a made-up folder, then cards that try each thing a card may not do: write into the folder,
read the home folder or thimble browser's workspaces, reach the network, see the server's environment, keep a file for
the next run, and run past its time. It prints one line per check, pass or FAIL, and when there is no sandbox, why and
what to install. It needs no sign-in and opens no browser. Its folder is a new temp folder, removed at the end.

Exit status: 0 when every check passes, 1 when one fails or there is no sandbox.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import socket
import tempfile
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import home
from .cards import sandbox

ERR = "application/vnd.thimble.error+json"
SECRET = "THIMBLE_CHECK_SECRET"
INTERNET = ("1.1.1.1", 443)  # an address on the internet that answers on 443
CSV = "run,outcome\na,merged\nb,failed\n"
# what a run's environment may hold besides child_env's: what the runner and the shell add
OWN_ENV = {"MATPLOTLIBRC", "PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"}


class Context:
    """The made-up folder and what the checks look for."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.folder = self.new_folder("files")
        self.token = secrets.token_hex(8)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.canary = home.root() / f"sandbox-check-{self.token}.txt"
        self.canary.write_text("thimble browser's own folder\n")

    def new_folder(self, name: str) -> Path:
        d = self.base / name
        d.mkdir()
        (d / "results.csv").write_text(CSV)
        return d

    def close(self) -> None:
        self.listener.close()
        self.canary.unlink(missing_ok=True)


async def card(code: str, folder: Path, timeout: float = 30) -> tuple[dict[str, Any], Any]:
    """The run's result, and the JSON its last line printed (None when it printed none)."""
    r = await sandbox.run_code(code, folder, timeout=timeout)
    text = "".join(o.get("text/plain", "") for o in r.get("outputs", []) if o.get("_stream") == "stdout").strip()
    try:
        return r, json.loads(text.splitlines()[-1]) if text else None
    except ValueError:
        return r, None


def error_of(r: dict[str, Any]) -> str:
    errs = [o[ERR] for o in r.get("outputs", []) if ERR in o]
    return f"{errs[-1]['ename']}: {errs[-1]['evalue']}" if errs else str(r.get("error") or "no output")


async def runs_a_card(c: Context) -> tuple[bool, str]:
    r, _ = await card("import pandas as pd\npd.read_csv('results.csv').set_index('run')", c.folder)
    rows = (r.get("frame") or {}).get("rows")
    if r.get("status") == "ok" and rows == [["a", "merged"], ["b", "failed"]]:
        return True, "a table of results.csv"
    return False, error_of(r)


async def no_write(c: Context) -> tuple[bool, str]:
    code = ("import json\nout = []\n"
            "for name, mode in (('new.txt', 'w'), ('results.csv', 'a')):\n"
            "    try:\n        open(name, mode).write('x')\n        out.append('wrote ' + name)\n"
            "    except OSError as e:\n        out.append(e.strerror or type(e).__name__)\n"
            "print(json.dumps(out))")
    folder = c.new_folder("write")  # its own, so that the other checks read results.csv as it was
    _, got = await card(code, folder)
    changed = (folder / "new.txt").exists() or (folder / "results.csv").read_text() != CSV
    if changed or not isinstance(got, list) or any(str(x).startswith("wrote") for x in got):
        return False, f"the folder changed: {got}"
    return True, str(got[0])


def _shown_names(h: Path, c: Context) -> set[str]:
    """The home folder's entries on the way to a folder the sandbox shows (its Python, its runner), which a run sees."""
    shown = sandbox.rules_for(c.folder, c.base)["filesystem"]["allowRead"]
    out = set()
    for e in shown:
        for p in (Path(e["path"]), Path(os.path.realpath(e["path"]))):
            if h in p.parents:
                out.add(p.relative_to(h).parts[0])
    return out


async def no_home(c: Context) -> tuple[bool, str]:
    h = Path.home()
    try:
        names = set(os.listdir(h))
    except OSError:
        names = set()
    names -= _shown_names(h, c)
    files = sorted(n for n in names if (h / n).is_file())[:5]
    code = (f"import json, os\nh, files = {str(h)!r}, {files!r}\nout = {{'read': []}}\n"
            "try:\n    out['list'] = os.listdir(h)\nexcept OSError as e:\n    out['list'] = e.strerror\n"
            "for n in files:\n    try:\n        open(os.path.join(h, n), 'rb').read(1)\n        out['read'].append(n)\n"
            "    except OSError:\n        pass\nprint(json.dumps(out))")
    r, got = await card(code, c.folder)
    if not isinstance(got, dict):
        return False, error_of(r)
    seen = sorted(names & set(got["list"])) if isinstance(got["list"], list) else []
    if seen or got["read"]:
        return False, f"it saw {', '.join(seen + got['read'])}"
    if not names:
        return True, "the home folder has nothing else to look for"
    return True, f"it sees none of the home folder's {len(names)} entries"


async def no_workspaces(c: Context) -> tuple[bool, str]:
    code = (f"import json, os\nroot, canary = {str(home.root())!r}, {str(c.canary)!r}\nout = []\n"
            "try:\n    out += os.listdir(root)\nexcept OSError:\n    pass\n"
            "try:\n    open(canary).read()\n    out.append('read')\nexcept OSError:\n    pass\nprint(json.dumps(out))")
    r, got = await card(code, c.folder)
    if not isinstance(got, list):
        return False, error_of(r)
    if got:
        return False, f"it saw {', '.join(got[:5])} in {home.root()}"
    return True, str(home.root())


async def no_network(c: Context) -> tuple[bool, str]:
    code = ("import json, socket\nout = {}\n"
            f"for name, addr in (('the internet', {INTERNET!r}), ('127.0.0.1', ('127.0.0.1', {c.port}))):\n"
            "    try:\n        socket.create_connection(addr, timeout=3).close()\n        out[name] = 'connected'\n"
            "    except OSError as e:\n        out[name] = type(e).__name__\n"
            "try:\n    socket.getaddrinfo('example.com', 443)\n    out['DNS'] = 'connected'\n"
            "except OSError as e:\n    out['DNS'] = type(e).__name__\n"
            "try:\n    socket.socket(socket.AF_UNIX).close()\n    out['a Unix socket'] = 'connected'\n"
            "except OSError as e:\n    out['a Unix socket'] = type(e).__name__\n"
            "print(json.dumps(out))")
    r, got = await card(code, c.folder)
    if not isinstance(got, dict):
        return False, error_of(r)
    reached = [k for k, v in got.items() if v == "connected"]
    if reached:
        return False, f"it reached {', '.join(reached)}"
    return True, f"no connection to the internet or to 127.0.0.1:{c.port}, no DNS, no Unix socket"


async def no_environment(c: Context) -> tuple[bool, str]:
    r, got = await card("import json, os\nprint(json.dumps(sorted(os.environ)))", c.folder)
    if not isinstance(got, list):
        return False, error_of(r)
    other = sorted(set(got) - set(sandbox.child_env("/tmp")) - OWN_ENV)
    if SECRET in got or other:
        return False, f"it sees {', '.join(other)}"
    return True, f"it sees only its own {len(got)} variables"


async def keeps_nothing(c: Context) -> tuple[bool, str]:
    marker = f"/tmp/thimble-keep-{c.token}"
    write = ("import json, os\nout = {'tmpdir': os.environ['TMPDIR'], 'wrote': []}\n"
             f"for p in (os.path.join(os.environ['TMPDIR'], 'keep.txt'), {marker!r}):\n"
             "    try:\n        open(p, 'w').write('x')\n        out['wrote'].append(p)\n    except OSError:\n        pass\n"
             "print(json.dumps(out))")
    r, first = await card(write, c.folder)
    if not isinstance(first, dict) or not first["wrote"]:
        return False, f"a run could not write its own folder: {error_of(r)}"
    if Path(marker).exists():
        Path(marker).unlink()
        return False, f"it wrote {marker} on this machine"
    if Path(first["tmpdir"]).exists():
        return False, f"its folder {first['tmpdir']} is still on this machine"
    look = f"import json, os\nprint(json.dumps([p for p in {first['wrote']!r} if os.path.exists(p)]))"
    r, second = await card(look, c.folder)
    if not isinstance(second, list):
        return False, error_of(r)
    if second:
        return False, f"the next run found {', '.join(second)}"
    return True, "the next run found none of the files the first one wrote"


async def stops_in_time(c: Context) -> tuple[bool, str]:
    t = time.monotonic()
    r = await sandbox.run_code("import time\ntime.sleep(60)", c.folder, timeout=2)
    took = time.monotonic() - t
    errs = [o[ERR]["ename"] for o in r.get("outputs", []) if ERR in o]
    if r.get("status") == "error" and errs and errs[-1] == "TimeoutError" and took < 30:
        return True, f"a 2 s limit stopped it after {took:.0f} s"
    return False, f"after {took:.0f} s: {error_of(r)}"


CHECKS: list[tuple[str, Callable[[Context], Awaitable[tuple[bool, str]]]]] = [
    ("runs a card that reads the folder", runs_a_card),
    ("cannot write into the folder", no_write),
    ("cannot read the home folder", no_home),
    ("cannot read thimble browser's workspaces", no_workspaces),
    ("cannot reach the network", no_network),
    ("cannot see the server's environment", no_environment),
    ("keeps nothing between runs", keeps_nothing),
    ("stops a run past its time", stops_in_time),
]


async def run_checks() -> list[tuple[bool, str, str]]:
    """(passed, check, detail) for each of CHECKS, run in a new temp folder with a secret in this environment."""
    base = Path(tempfile.mkdtemp(prefix="thimble-check-")).resolve()
    c = Context(base)
    os.environ[SECRET] = c.token
    try:
        got = await asyncio.gather(*(f(c) for _, f in CHECKS), return_exceptions=True)
    finally:
        os.environ.pop(SECRET, None)
        c.close()
        shutil.rmtree(base, ignore_errors=True)
    out = []
    for (name, _), res in zip(CHECKS, got):
        if isinstance(res, BaseException):
            res = (False, f"{type(res).__name__}: {res}")
        out.append((res[0], name, res[1]))
    return out


def main() -> int:
    st = sandbox.status()
    if not st.kind:
        print("thimble browser: no sandbox, so card code will not run")
        print(f"  why: {st.why}")
        print(f"  to do: {st.fix}")
        return 1
    print(f"thimble browser: checking the sandbox ({st.kind})", flush=True)
    results = asyncio.run(run_checks())
    for ok, name, detail in results:
        print(f"  {'pass' if ok else 'FAIL'}  {name}" + (f": {detail}" if detail else ""))
    failed = sum(not ok for ok, _, _ in results)
    if failed:
        print(f"{failed} of {len(results)} checks failed: card code is not safe to run here")
        return 1
    print(f"all {len(results)} checks passed")
    return 0
