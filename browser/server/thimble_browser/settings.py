"""The analyst's settings, kept in the server's home (`settings.json`), and the API key file.

    credentials   {"source": "wif", "file": "<path>"} (Workload Identity Federation, with the IDs and the identity
                  token's source in that config file: wif.py) or {"source": "key"} (an API key the analyst pasted in
                  Settings, kept in `api-key` with mode 0600), or {} for none yet
    model         the model every agent runs on, claude-opus-5-5 unless the analyst picks another
    effort        low | medium | high | xhigh | max, for the chat, its threads and thimble's agents
    features      {name: on} for each feature that is turned off or on (features/), on when not named

Nothing here is read from or written to the environment.
"""
from __future__ import annotations

import os
from typing import Any

from . import home, wif

DEFAULTS: dict[str, Any] = {"credentials": {}, "model": "claude-opus-5-5", "effort": "high", "features": {}}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MODELS = ("claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5")


def _path() -> Any:
    return home.root() / "settings.json"


def read() -> dict[str, Any]:
    got = home.read_json(_path(), {}) or {}
    return {**DEFAULTS, **{k: v for k, v in got.items() if k in DEFAULTS}}


def write(patch: dict[str, Any]) -> dict[str, Any]:
    cur = read()
    for k, v in patch.items():
        if k == "credentials":
            if not isinstance(v, dict) or v.get("source") not in ("wif", "key", None):
                raise ValueError("credentials: {source: wif, file} or {source: key}")
            if v.get("source") == "wif":
                try:
                    v = {"source": "wif", "file": str(wif.load(v.get("file")).path)}
                except wif.WifError as e:
                    raise ValueError(f"Workload Identity Federation: {e}") from None
            cur[k] = {kk: v[kk] for kk in ("source", "file") if kk in v}
        elif k == "model":
            if not isinstance(v, str) or not v.startswith("claude-"):
                raise ValueError("model: a Claude model id, such as claude-opus-5-5")
            cur[k] = v
        elif k == "effort":
            if v not in EFFORTS:
                raise ValueError(f"effort: one of {', '.join(EFFORTS)}")
            cur[k] = v
        elif k == "features":
            if not isinstance(v, dict) or not all(isinstance(x, bool) for x in v.values()):
                raise ValueError("features: {name: true or false}")
            cur[k] = {**cur.get("features", {}), **{str(n): bool(x) for n, x in v.items()}}
    home.write_json(_path(), cur)
    return cur


def _key_path() -> Any:
    return home.root() / "api-key"


def set_api_key(key: str) -> None:
    """Keep the analyst's API key, readable by this user alone; an empty key removes it."""
    p = _key_path()
    if not key:
        try:
            p.unlink()
        except OSError:
            pass
        return
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key.strip())
    os.chmod(p, 0o600)


def api_key() -> str | None:
    try:
        return _key_path().read_text().strip() or None
    except OSError:
        return None


def has_api_key() -> bool:
    return _key_path().is_file()
