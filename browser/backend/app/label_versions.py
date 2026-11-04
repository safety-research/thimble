"""Label versions (B19): what each label showed (its counts, as concepts.card_values reads them) after each change of
the label, with when thimble kept it, so a citation of a label is checked against the label as it was when the cited
words were written, never as it is now (marks.session_cards gives the validator every version, as the place
`card:label-<label id>`, and evidence.check_card reads them at that time).

    <home>/label-versions/<workspace>/<label id>.jsonl   one label's versions, oldest first, one per line:
                                                          {v, at, made, values, counts, n, unit}
    <home>/label-versions/<workspace>/times.jsonl        when the words of each check's citations were written, {key,
                                                          at}: a reply's turn, a takeaway (time_of)

Where. Thimble's home (cli.home, beside the workspaces' folder), outside the workspace: the kernels' sandbox hides it
from a card's code (notebook._kernel_hides), and no agent has it among the folders it writes (runtime.spec_of), so
neither can add, change or remove a version or a time. The label's own files (its definition, rows and store) lie in
the workspace, which a card's code writes (kernel_wrap): a change to them changes no version kept before it, and the
check reads a label only through its versions.

When. A version is kept (keep) of what the label shows (concepts.card_values) by the step of thimble's that
changed the label's rows, right after it: a run's end, a redefinition, a correction, its Undo. Never from
what the label's files show when no such step changed them: those files are the workspace's, which a card's code can
write. A label from before thimble kept versions gets its first one as it stands, before main's next turn (keep_first).
A version is kept only when what the label shows differs from the newest one. When the label shows other counts than its
newest version and no step kept them (shows_other), the check reads that version as no longer shown, but keeps none.

What a version is evidence of. It shows its values from when it was made until the next one was. The validator takes
as evidence only the versions made by the time the cited words were written: the label as it was then, or an earlier
version, never a later one, which the words could not have read (evidence._card_entry). So a later change of the label,
by a run, a correction or a write to its files, confirms no words written before it.

Not covered (B25, the kernels may write the workspace): a write to a label's rows by a card's code is in the version
the next step of thimble's keeps, as it is in what the label shows everyone; and a card's code can make such a step
through the server's API, as the analyst can.
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
from pathlib import Path
from typing import Any

from . import config, ledger

log = logging.getLogger("thimble.label_versions")

DIR = "label-versions"
TIMES = "times.jsonl"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # a label's id (concepts.ID_RE)
# what made a version that no change of the label made: a label from before thimble kept versions, kept as it stood
FIRST = "the label as thimble first kept it"
RESTORED = "brought back by Undo"  # a deleted label's Undo (concepts.restore_concept)
# what changed after a label's newest version when it shows other counts and no step of thimble's kept them
CHANGED = "its counts changed"
CORRECTED = re.compile(r"^(\d+) values? corrected$")
_lock = threading.Lock()


def folder(c: str) -> Path:
    """The workspace's versions, in thimble's home."""
    from . import cli  # noqa: PLC0415 — cli imports config, procs and cc_plugin only

    if not config._valid_name(c):
        raise ValueError(f"no workspace {c!r}")
    return cli.home() / DIR / c


def _file(c: str, kid: str) -> Path:
    if not ID_RE.match(kid or ""):
        raise ValueError(f"no label {kid!r}")
    return folder(c) / f"{kid}.jsonl"


def _valid(v: Any) -> dict[str, Any] | None:
    """A version as kept, or None for a line that is not one."""
    try:
        n, at = v["v"], v["at"]
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            return None
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
            return None
        return {"v": n, "at": float(at), "made": str(v.get("made") or ""), "values": [str(x) for x in v["values"]],
                "counts": {str(k): int(x) for k, x in v["counts"].items()}, "n": int(v["n"]), "unit": str(v["unit"])}
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def read(c: str, kid: str) -> list[dict[str, Any]]:
    """The versions kept of label `kid`, oldest first: each a number above the one before it, made no earlier."""
    try:
        text = _file(c, kid).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return []
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            v = _valid(json.loads(line))
        except ValueError:
            continue
        if v is not None and (not out or (v["v"] > out[-1]["v"] and v["at"] >= out[-1]["at"])):
            out.append(v)
    return out


def _shows(v: dict[str, Any]) -> tuple:
    return (v["values"], v["counts"], v["n"], v["unit"])


def keep(c: str, concept: dict[str, Any], made: str, shown: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Keep what label `concept` shows now (concepts.card_values, or `shown`) as its next version, made by
    `made` (what changed, in the words of the label's stale tag), unless its newest version shows the same. The newest
    version, or None when the label's counts cannot be read now. Never raises: a version not kept leaves the label's
    citations as not confirmed, never as confirmed."""
    try:
        from . import concepts  # noqa: PLC0415 — concepts keeps versions here

        if shown is None:
            shown = concepts.card_values(config.workspace_dir(c), concept)
        if shown is None:
            return None
        now = {"values": [str(x) for x in shown["values"]], "counts": {str(k): int(x) for k, x in shown["counts"].items()},
               "n": int(shown["n"]), "unit": str(shown["unit"])}
        p = _file(c, str(concept["id"]))
        config.private_dir(p.parent)
        with _lock, ledger.locked(p):
            kept = read(c, str(concept["id"]))
            if kept and _shows(kept[-1]) == _shows(now):
                return kept[-1]
            v = {"v": kept[-1]["v"] + 1 if kept else 1, "at": max(time.time(), kept[-1]["at"] if kept else 0.0), "made": made, **now}
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(v, ensure_ascii=False) + "\n")
            return v
    except Exception:  # noqa: BLE001 — see the docstring
        log.exception("%s: a version of label %s was not kept", c, concept.get("id"))
        return None


def keep_first(c: str) -> None:
    """A first version of each label of workspace `c` that has none, as it stands: a label from before thimble kept
    versions. Before main's turn, so that a citation of such a label in the turn has one to hold against, and before a
    check. A label that runs is left to its run's end. Never raises."""
    from . import concepts  # noqa: PLC0415

    try:
        labels = concepts.list_concepts(config.workspace_dir(c))
    except Exception:  # noqa: BLE001 — no labels read, no versions kept
        log.exception("%s: the labels were not read to keep their versions", c)
        return
    for concept in labels:
        if not concepts._applying(c, concept["id"]) and not read(c, concept["id"]):
            keep(c, concept, FIRST)


def shows_other(c: str, concept: dict[str, Any], newest: dict[str, Any]) -> bool:
    """Whether the label shows other counts now than its newest version, with no step of thimble's having kept them:
    then that version is shown no longer, though no version holds what the label shows. Never raises."""
    from . import concepts  # noqa: PLC0415

    try:
        now = concepts.card_values(config.workspace_dir(c), concept)
    except Exception:  # noqa: BLE001 — a label that cannot be read now is read as its newest version
        return False
    if now is None:
        return False
    return (now["values"], {str(k): int(x) for k, x in now["counts"].items()}, int(now["n"]), str(now["unit"])) != _shows(newest)


def after_text(kept: list[dict[str, Any]], i: int) -> str:
    """What changed in the label after its version kept[i], in the words of its stale tag (concepts.changed_since):
    each later version's making, consecutive corrections as one; '' for the newest."""
    parts: list[str] = []
    fixed = 0
    for v in kept[i + 1:]:
        m = CORRECTED.match(v["made"])
        if m:
            fixed += int(m.group(1))
            continue
        if fixed:
            parts.append(f"{fixed} value{'' if fixed == 1 else 's'} corrected")
            fixed = 0
        if v["made"]:
            parts.append(v["made"])
    if fixed:
        parts.append(f"{fixed} value{'' if fixed == 1 else 's'} corrected")
    return "; ".join(parts)


def keep_time(c: str, key: str, at: float) -> None:
    """Keep when the words of a check's citations were written (`key`: `turn:<turn>` for a reply's or a side thread's
    answer's, `takeaway:<card>:<hash of its text>` for a card's takeaway), for a repair of one of them later
    (time_of). The first time kept for a key stands. Never raises."""
    try:
        p = folder(c) / TIMES
        config.private_dir(p.parent)
        with _lock, ledger.locked(p):
            if time_of(c, key) is None:
                with open(p, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"key": key, "at": float(at)}) + "\n")
    except Exception:  # noqa: BLE001 — a repair of these citations then reads the labels as they are
        log.exception("%s: the time of the check %s was not kept", c, key)


def time_of(c: str, key: str) -> float | None:
    """When the words of the citations under `key` were written (keep_time); None when no time was kept, as for a
    check before thimble kept them."""
    try:
        text = (folder(c) / TIMES).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    for line in text.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        at = rec.get("at") if isinstance(rec, dict) else None
        if rec.get("key") == key and isinstance(at, (int, float)) and not isinstance(at, bool) and math.isfinite(at):
            return float(at)
    return None


def drop(c: str, kids: list[str]) -> None:
    """The versions of the labels `kids` go, with their workspace's folder (ledger.reset_workspace)."""
    for kid in kids:
        try:
            _file(c, kid).unlink(missing_ok=True)
            ledger.lock_file(_file(c, kid)).unlink(missing_ok=True)
        except (OSError, ValueError):
            log.exception("%s: the versions of label %s were not deleted", c, kid)
