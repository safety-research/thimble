"""thimble's feature switches (0.9.0 build spec 3.6, contract C6): which of thimble's features are on, from thimble's
config file (`<home>/config.json`), which the browser's Settings and /config's thimble rows both change.

    autoActivate    features.autoActivate      data reads turn thimble on
    viewProposals   views.propose              the view proposer after each turn
    labels          features.labels            labels, their guidance and their tool
    checks          features.checks            checks, on documents, cards and answers
    citationMarks   features.citationMarks     the terminal's check marks and crosses on citations
    coverage        features.coverage          the coverage facts, line and view
    cardCheck       agents.cardCheck.auto      the card check after card tools

    thimble features [--cwd DIR] [--json] [--set KEY=on|off ...]
        prints {"settings": {key: bool, ...}, "at": <mtime of config.json>}

SCAFFOLD STUB (core lane): every switch is on unless `--set` stored it off, which the stub writes into the `features`
block of config.json as it is, with no validation (until the core lane's userconf validation, 0.8.0's userconf calls that
block "not a setting", so only a test or a lane's own scratch home should use --set). `views.propose` and
`agents.cardCheck.auto` are not read yet.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

KEYS = ("autoActivate", "viewProposals", "labels", "checks", "citationMarks", "coverage", "cardCheck")
FEATURES_KEY = "features"  # the block in config.json
GUIDE_FLAGS = ("labels", "checks")  # the switches the guide's sections follow (flags)
# features.auto's kinds: what runs by itself, by the switch it follows
AUTO_KINDS = {"proposer": "viewProposals", "card_check": "cardCheck", "checks": "checks", "coverage": "coverage",
              "labels": "labels"}


def _file() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / "config.json"


def _raw() -> dict[str, Any]:
    try:
        data = json.loads(_file().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def settings(c: str | None = None) -> dict[str, bool]:
    """Every switch, on unless config.json's `features` block holds false for it. `c` (a workspace) is not read yet."""
    block = _raw().get(FEATURES_KEY)
    block = block if isinstance(block, dict) else {}
    return {k: block.get(k) is not False for k in KEYS}


def set_settings(patch: dict[str, bool], by: str) -> dict[str, bool]:
    """Store `patch` (switch -> bool, None back to the default) in config.json's `features` block, as it is; the
    switches after. `by` says who changed them (`terminal`, `browser`), not kept by the stub."""
    data = _raw()
    block = data.get(FEATURES_KEY) if isinstance(data.get(FEATURES_KEY), dict) else {}
    for k, v in patch.items():
        if k not in KEYS:
            raise ValueError(f"no feature {k!r}; the features are {', '.join(KEYS)}")
        if v is None:
            block.pop(k, None)
        else:
            block[k] = bool(v)
    data[FEATURES_KEY] = block
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    os.replace(tmp, path)
    return settings()


def flags(c: str | None) -> frozenset[str]:
    """The switched-on subset of GUIDE_FLAGS, which the guide renders with (prompts' {{if:labels}}, {{if:checks}})."""
    on_now = settings(c)
    return frozenset(k for k in GUIDE_FLAGS if on_now[k])


def on(c: str | None, key: str) -> bool:
    """Whether switch `key` is on."""
    return settings(c)[key]


def auto(c: str | None, kind: str) -> bool:
    """Whether what runs by itself of `kind` (AUTO_KINDS) runs."""
    return settings(c)[AUTO_KINDS[kind]]


def _mtime() -> float:
    try:
        return _file().stat().st_mtime
    except OSError:
        return 0.0


def main(argv: list[str]) -> int:
    """`features [--cwd DIR] [--json] [--set KEY=on|off ...]` (module note). Exit 0; a bad --set prints {"error"}."""
    patch: dict[str, bool] = {}
    args = list(argv)
    while "--set" in args:
        i = args.index("--set")
        pair = args[i + 1] if i + 1 < len(args) else ""
        del args[i:i + 2]
        key, _, value = pair.partition("=")
        if key not in KEYS or value not in ("on", "off"):
            sys.stdout.write(json.dumps({"error": f"--set takes KEY=on|off with KEY one of {', '.join(KEYS)}"}) + "\n")
            return 0
        patch[key] = value == "on"
    out = set_settings(patch, "terminal") if patch else settings()
    sys.stdout.write(json.dumps({"settings": out, "at": _mtime()}) + "\n")
    return 0
