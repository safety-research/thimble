"""thimble's feature switches: which of its features run, as the analyst sets them in `/config` → thimble, in the
browser's Settings or with `thimble features --set`.

One store, thimble's config file (userconf.py): five switches live in its `features` block and two in keys that 0.8.0
already had. Each switch is on unless the config sets it false; null is the default, which is on.

    key              config path               what "off" does
    autoActivate     features.autoActivate     a data read does not turn thimble on; /thimble, load_thimble, the
                                               `thimble` command and a press still do
    viewProposals    views.propose             no view proposal after a turn (views.propose_enabled)
    labels           features.labels           the guide leaves out the Labels section and the label events, and
                                               apply_label refuses
    checks           features.checks           no automatic check runs, run_check refuses, and the guide leaves out
                                               the Checks section and the `checked` event
    citationMarks    features.citationMarks    the terminal draws citations as plain links, with no ✓ or ×
    coverage         features.coverage         no coverage facts, no coverage line and no Coverage section
    cardCheck        agents.cardCheck.auto     no card check after a card tool (card_check.auto)

settings(c) reads them, set_settings(patch, by) writes them, flags(c) gives the prompt flags (prompts.rendering) of the
switches that change the guide, on(c, key) reads one switch, and auto(c, kind) says whether a background job of that
kind runs. `thimble features [--cwd DIR] [--json] [--set KEY=on|off …]` is the command line (activate.main).
"""
from __future__ import annotations

import os
from typing import Any

from . import userconf

# The switches in the order /config and Settings show them, and where each one lives in thimble's config.
PATHS: dict[str, tuple[str, ...]] = {
    "autoActivate": ("features", "autoActivate"),
    "viewProposals": ("views", "propose"),
    "labels": ("features", "labels"),
    "checks": ("features", "checks"),
    "citationMarks": ("features", "citationMarks"),
    "coverage": ("features", "coverage"),
    "cardCheck": ("agents", "cardCheck", "auto"),
}
KEYS = tuple(PATHS)
# the switches in the config's `features` block (userconf.FEATURES), which the browser's Settings sends as
# ledger.FEATURES_KEY; viewProposals and cardCheck have their own Settings rows from before
BLOCK_KEYS = tuple(k for k, p in PATHS.items() if p[0] == "features")
# the switches that change the guide, by the prompt flag each one sets (prompts.FEATURE_FLAGS)
FLAG_KEYS = {"labels": "labels", "checks": "checks"}
# auto(c, kind): the background job of each kind, by the switch that turns it off
AUTO_KINDS = {"proposer": "viewProposals", "card_check": "cardCheck", "checks": "checks", "coverage": "coverage",
              "labels": "labels"}
# the workspace's settings.json key of the canvas's old card-check switch (card_check.AUTO_KEY, repeated: card_check
# imports the server's stack)
CARD_CHECK_SETTING = "card_check"
ON_WORDS = ("on", "true", "1", "yes")
OFF_WORDS = ("off", "false", "0", "no")


class FeatureError(ValueError):
    """A key that is not a feature switch, or a value that is not on or off; the message says what it takes."""


def _get(conf: dict[str, Any], path: tuple[str, ...]) -> Any:
    for k in path:
        if not isinstance(conf, dict):
            return None
        conf = conf.get(k)
    return conf


def settings(c: str | None = None) -> dict[str, bool]:
    """Every switch of workspace `c` (thimble's home's config alone without one): on unless the config sets it false.
    A config with an error leaves every switch on, as userconf.load_or_defaults gives the defaults then. cardCheck also
    reads the workspace's settings.json `card_check` that the canvas's old switch wrote, as card_check.auto does."""
    conf, _err = userconf.load_or_defaults(c)
    out = {key: _get(conf, path) is not False for key, path in PATHS.items()}
    if c and _get(conf, PATHS["cardCheck"]) is None:
        try:
            from . import ledger  # noqa: PLC0415

            out["cardCheck"] = ledger.stored_settings(c).get(CARD_CHECK_SETTING) is not False
        except Exception:  # noqa: BLE001 — an unknown workspace or an unreadable file leaves the check on
            out["cardCheck"] = True
    return out


def on(c: str | None, key: str) -> bool:
    """Whether the switch `key` is on in workspace `c`. FeatureError for a key that is no switch."""
    if key not in PATHS:
        raise FeatureError(f"{key!r} is not a feature switch; one of {', '.join(KEYS)}")
    return settings(c)[key]


def flags(c: str | None = None) -> frozenset[str]:
    """The prompt flags of the switches that change the guide (FLAG_KEYS) and are on in workspace `c`, as
    prompts.rendering takes them."""
    got = settings(c)
    return frozenset(flag for key, flag in FLAG_KEYS.items() if got[key])


def auto(c: str | None, kind: str) -> bool:
    """Whether the background job `kind` runs in workspace `c` (AUTO_KINDS): `proposer` is views.propose_enabled (which
    also reads its environment switch), `card_check` card_check.auto, and `checks`, `coverage` and `labels` their
    switches. FeatureError for another kind."""
    if kind not in AUTO_KINDS:
        raise FeatureError(f"{kind!r} is not a background job; one of {', '.join(AUTO_KINDS)}")
    if kind == "proposer" and c:
        from . import views  # noqa: PLC0415 — views imports the whole view machinery

        return views.propose_enabled(c)
    if kind == "card_check" and c:
        from . import card_check  # noqa: PLC0415

        return card_check.auto(c)
    return on(c, AUTO_KINDS[kind])


def value(word: Any) -> bool | None:
    """A switch's value from a word or a bool: True for on, False for off, None for default (null). FeatureError
    otherwise."""
    if word is None or isinstance(word, bool):
        return word
    w = str(word).strip().lower()
    if w in ON_WORDS:
        return True
    if w in OFF_WORDS:
        return False
    if w in ("null", "default"):
        return None
    raise FeatureError(f"{word!r} is not a switch value; it takes on or off")


def patch_of(changes: dict[str, Any]) -> dict[str, Any]:
    """A nested patch of thimble's config (userconf.save) for `changes` ({key: on | off | None}). A switch set on is
    written as null, its default, so the file keeps no key it does not need. FeatureError for an unknown key or value."""
    patch: dict[str, Any] = {}
    for key, word in changes.items():
        if key not in PATHS:
            raise FeatureError(f"{key!r} is not a feature switch; one of {', '.join(KEYS)}")
        v = value(word)
        node = patch
        path = PATHS[key]
        for k in path[:-1]:
            node = node.setdefault(k, {})
        node[path[-1]] = None if v is not False else False
    return patch


def set_settings(patch: dict[str, Any], by: str = "") -> dict[str, bool]:
    """Write the switches in `patch` ({key: True | False | None, or on | off}) to thimble's config in thimble's home, and
    return every switch as settings() reads it now. `by` names who changed them (`config` for /config, `browser`,
    `cli`), for the log. FeatureError for an unknown key or value; userconf.ConfigError when the config file has an
    error, writing nothing."""
    import logging  # noqa: PLC0415

    nested = patch_of(patch)
    if nested:
        userconf.save(None, nested)
        logging.getLogger("thimble.features").info("feature switches %s set by %s", sorted(patch), by or "?")
    return settings()


def config_mtime() -> float:
    """The modification time of thimble's config file in thimble's home, 0 when there is none."""
    try:
        return os.stat(userconf.global_file()).st_mtime
    except OSError:
        return 0.0


def report(c: str | None = None) -> dict[str, Any]:
    """`thimble features --json`: {"settings": settings(c), "at": config_mtime()} (contract C6)."""
    return {"settings": settings(c), "at": config_mtime()}
