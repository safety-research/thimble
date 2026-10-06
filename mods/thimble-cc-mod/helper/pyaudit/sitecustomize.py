"""thimble-cc-mod: note which corpus files a Python process opens, for the coverage count (helper/coverage.py).

thimble-cc-mod puts this folder first on PYTHONPATH for the session, so every python3 the agents run imports it at
start. An audit hook appends each corpus file the process opens for reading, once per process, to
<corpus>/.thimble-cc-mod/coverage/opens.jsonl. It notes nothing for the mod's own helpers (their scripts live in the
helper folder above this one), for files outside the corpus or under its .thimble-cc-mod, and it never raises. Then
the next sitecustomize on the path, if any, runs as it would have.
"""
import os as _os
import sys as _sys


def _thimble_cc_mod_audit() -> None:
    root = _os.environ.get("THIMBLE_CC_MOD_ROOT")
    if not root:
        return
    here = _os.path.dirname(_os.path.abspath(__file__))
    helper = _os.path.dirname(here)
    main = _os.path.abspath(_sys.argv[0]) if _sys.argv and _sys.argv[0] not in ("", "-c", "-m", "-") else ""
    if main.startswith(helper + _os.sep):
        return
    root = _os.path.realpath(root)
    home = _os.path.join(root, ".thimble-cc-mod")
    log = _os.path.join(home, "coverage", "opens.jsonl")
    seen = set()
    import json as _json
    import time as _time

    def hook(event, args):
        if event != "open":
            return
        try:
            path, mode = args[0], args[1]
            if not isinstance(path, str) or (mode and any(c in str(mode) for c in "wax+")):
                return
            p = _os.path.realpath(path) if not path.startswith(root + _os.sep) else path
            if p in seen or not p.startswith(root + _os.sep) or p.startswith(home + _os.sep):
                return
            seen.add(p)
            if not _os.path.isfile(p):
                return
            _os.makedirs(_os.path.dirname(log), exist_ok=True)
            fd = _os.open(log, _os.O_WRONLY | _os.O_APPEND | _os.O_CREAT, 0o644)
            try:
                _os.write(fd, (_json.dumps({"t": round(_time.time(), 3), "pid": _os.getpid(), "file": p}) + "\n").encode())
            finally:
                _os.close(fd)
        except Exception:  # noqa: BLE001 — never break the script being audited
            pass

    _sys.addaudithook(hook)


try:
    _thimble_cc_mod_audit()
except Exception:  # noqa: BLE001
    pass


def _thimble_cc_mod_chain() -> None:
    """Run the sitecustomize this one shadows (a distribution's own), from the rest of the path."""
    import importlib.machinery as _machinery
    import importlib.util as _util

    here = _os.path.dirname(_os.path.abspath(__file__))
    rest = [p for p in _sys.path if p and _os.path.abspath(p) != here]
    spec = _machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec and spec.origin and _os.path.abspath(spec.origin) != _os.path.abspath(__file__) and spec.loader:
        mod = _util.module_from_spec(spec)
        spec.loader.exec_module(mod)


try:
    _thimble_cc_mod_chain()
except Exception:  # noqa: BLE001
    pass
