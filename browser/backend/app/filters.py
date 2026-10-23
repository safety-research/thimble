"""The filters a chat sets, `set_filter` and `clear_filter`: what the Filter menu and the filter chips do in the
browser.

concepts.py keeps the filters, one per scope in filters.json, so a filter a chat sets shows in every tab and one the
analyst sets reaches the next list_cards. Neither tool makes a label or a card. set_filter changes only what it names: a
label replaces the scope's label filter ("" drops it), each card part given replaces that part (an empty list or false
unsets it). Everything a call names is checked before anything is set, so a refused call changes nothing. clear_filter
drops the scope's whole filter.

The server reads a canvas filter the way the browser's cardFilter.ts does, so results and list_cards can say which cards
it keeps. A text filter keeps a card when each of its words starts a word of the card's text, ignoring case.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from . import cite, concepts, config, tools

LOOSE_GROUP = "loose"  # notebook.GROUP_KINDS: a group whose cards sit on the board outside every frame
# a citation with a label, [[31|card:x#a/b]], reads as its label, and one without, [[card:x]], as nothing
_CITE_LABELLED = re.compile(r"\[\[([^\]|]*)\|[^\]]*\]\]")
_CITE_BARE = re.compile(r"\[\[[^\]]*\]\]")
_WORD_BREAK = re.compile(r"[^\w]+")  # what separates words for a text filter: anything but letters, digits and _
# the words the canvas's chips use for each part (Canvas.tsx PART_WORD), which the results use too
PART_WORDS = {"kinds": "Kind", "groups": "Group", "makers": "Made by", "checks": "Check", "starred": "Starred",
              "locked": "Locked", "text": "Text"}
SCOPE_UNITS = {"files": concepts.FILE_UNITS, "canvas": ("cell",), "report": ("span",)}
# A card's check state and its words in the Filter menu and chips, by the mark the card shows (lib/cardCheck.ts
# checkState): failed, the red ✕ for a real problem the check found (numbers its code types in, or a revision of the
# check's that would not run); verified, a check read the card to the end and found no such problem; unverified, a check
# runs on it, was stopped or could not finish; unchecked, no check read it.
CHECK_WORDS = {"verified": "Verified", "unverified": "Unverified", "failed": "Failed", "unchecked": "Not checked"}
CHECK_STATES = tuple(CHECK_WORDS)
_CHECK_OF_STATUS = {"ok": "verified", "fixed": "verified", "pending": "unverified", "stopped": "unverified",
                    "error": "unverified"}
FIX_FIELDS = ("title", "code", "takeaway")  # checkstore.FIX_FIELDS


# --------------------------------------------------------------------------- the canvas's cards, as the filter reads them


def maker(created_by: str | None, chats: dict[str, dict]) -> str:
    """Who made a card, as its top row names them: `main` for the analyst's and terminal's cards, a chat's title, else
    created_by as it is."""
    c = str(created_by or "")
    chat_id = c[5:] if c.startswith("chat:") else "main" if c in ("", "user", "terminal") else None
    if chat_id is None:
        return c
    if chat_id == "main":
        return "main"
    meta = chats.get(chat_id)
    if meta is None:
        return chat_id
    if meta.get("kind") == "agent":
        return str(meta.get("role") or meta.get("title") or chat_id)
    return str(meta.get("title") or chat_id)


def search_text(*texts: Any) -> str:
    """The words a text filter searches, lowercased: the texts joined, each citation's markup taken out."""
    joined = " ".join(str(t or "") for t in texts)
    return " ".join(_CITE_BARE.sub(" ", _CITE_LABELLED.sub(r"\1", joined)).split()).casefold()


def _words(text: str) -> list[str]:
    return [w for w in _WORD_BREAK.split(text.casefold()) if w]


def text_matches(text: str, query: str) -> bool:
    """Whether each word of `query` starts a word of `text` (search_text), ignoring case."""
    have = _words(text)
    return all(any(w.startswith(q) for w in have) for q in _words(query))


def _read_text(t: Any) -> str:
    """A takeaway as the analyst reads it: a labelled citation as its label, a bare one as nothing, spaces collapsed."""
    return " ".join(_CITE_BARE.sub("", _CITE_LABELLED.sub(r"\1", str(t or ""))).split())


def _live_fix_fields(cell: dict) -> list[str] | None:
    """The fields of the card's newest applied check fix while it is still in effect (lib/cardCheck.ts liveFix): its
    fields as the fix left them, and more than the takeaway's links changed; else None."""
    for f in reversed(cell.get("fixes") if isinstance(cell.get("fixes"), list) else []):
        if not isinstance(f, dict) or f.get("state") != "applied":
            continue
        fields = [k for k in f.get("fields") or [] if k in FIX_FIELDS]
        if not fields:
            continue
        after = f.get("after") if isinstance(f.get("after"), dict) else {}
        if any((after.get(k) or "") != (cell.get(k) or "") for k in fields):
            return None
        before = f.get("before") if isinstance(f.get("before"), dict) else {}
        same_text = fields == ["takeaway"] and _read_text(before.get("takeaway")) == _read_text(after.get("takeaway"))
        return None if same_text else fields
    return None


def _live_fix(cell: dict) -> bool:
    """Whether the card's newest applied check fix is still in effect (_live_fix_fields)."""
    return _live_fix_fields(cell) is not None


def _check_problem(cell: dict, rec: dict) -> bool:
    """Whether the card shows the check's red ✕ (lib/cardCheck.ts checkProblem): a check read it to the end and found
    numbers its code types in, unless a fix of the check's has replaced the code since; or the check ended `error` with
    a revision of its own recorded as not kept (checkstore.record_rejected)."""
    status = str(rec.get("status") or "")
    if status in ("ok", "fixed"):
        render = (rec.get("stages") or {}).get("render") if isinstance(rec.get("stages"), dict) else None
        typed = render.get("typed") if isinstance(render, dict) else None
        return bool(isinstance(typed, list) and typed and "code" not in (_live_fix_fields(cell) or []))
    if status == "error" and rec.get("id"):
        fixes = cell.get("fixes") if isinstance(cell.get("fixes"), list) else []
        return any(isinstance(f, dict) and f.get("state") == "rejected" and f.get("check") == rec["id"] for f in fixes)
    return False


def check_state(cell: dict) -> str:
    """The card's check state, by the mark the card shows: failed for the red ✕ (_check_problem), else by its latest
    check's status, else verified while an applied fix is in effect, else unchecked. A label card is never checked."""
    if cell.get("kind") == "label":
        return "unchecked"
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else {}
    if rec and _check_problem(cell, rec):
        return "failed"
    return _CHECK_OF_STATUS.get(str(rec.get("status") or "")) or ("verified" if _live_fix(cell) else "unchecked")


def canvas_cards(c: str) -> list[dict]:
    """The cards the canvas draws, as the canvas route serves them (no Scratch),
    each {id, kind, group, maker, check, starred, locked, text}."""
    from . import agents, notebook

    notebook.migrate_scratch(c)
    data = notebook.canvas(config.workspace_dir(c))
    chats = {str(m.get("id")): m for m in agents.list_chats(c)}
    loose = {g["id"] for g in data["groups"] if g.get("kind") == LOOSE_GROUP}
    out = []
    for cell in data["cells"]:
        cid = str(cell.get("id") or "")
        if not cid:
            continue
        group = cell.get("notebook")
        out.append({"id": cid, "kind": "note" if cell.get("kind") == "md" else str(cell.get("kind") or "code"),
                    "group": None if group in loose else group, "maker": maker(cell.get("created_by"), chats),
                    "check": check_state(cell), "starred": cell.get("starred") is True,
                    "locked": cell.get("locked") is True,
                    "text": search_text(cell.get("title"), cite.canon_text(str(cell.get("takeaway") or "")))})
    return out


def passes(card: dict, entry: dict) -> bool:
    """Whether a card passes every card part of a canvas filter that is set."""
    for part in ("kinds", "groups", "makers", "checks"):
        if entry.get(part) and card[part[:-1]] not in entry[part]:
            return False
    if entry.get("starred") and not card["starred"]:
        return False
    if entry.get("locked") and not card["locked"]:
        return False
    return not entry.get("text") or text_matches(card["text"], entry["text"])


def label_keeps(c: str, concept_id: str, value: str) -> set[str]:
    """The ids of the cards the label gave `value`."""
    got = concepts.concept_rows(config.workspace_dir(c), concept_id, value, concepts.ROWS_MAX, 0)
    return {cite.strip_card(r.get("ref")) for r in got["rows"] if str(r.get("ref") or "").startswith(cite.CARD_PREFIXES)}


def canvas_view(c: str) -> dict | None:
    """{entry, cards, kept}: the canvas's filter, the cards on the canvas and the ids of those it keeps; None while the
    canvas has no filter."""
    entry = concepts.read_filters(config.workspace_dir(c)).get("canvas")
    if not entry:
        return None
    cards = canvas_cards(c)
    label = label_keeps(c, entry["concept"], entry["value"]) if entry.get("concept") else None
    kept = {x["id"] for x in cards if passes(x, entry) and (label is None or x["id"] in label)}
    return {"entry": entry, "cards": cards, "kept": kept}


def describe(c: str, entry: dict) -> str:
    """A filter in the chips' words: `claims a PR = yes; Kind · table; Group · Orientation; Text · "merge"`."""
    from . import notebook

    ws = config.workspace_dir(c)
    out = []
    if entry.get("concept"):
        concept = concepts.read_concept(ws, entry["concept"])
        out.append(f"{concept['name'] if concept else entry['concept']} = {entry['value']}")
    rows = notebook.list_notebooks(ws, figures=False)
    by_id = {r["id"]: r for r in rows}
    for part in concepts.CARD_PARTS:
        v = entry.get(part)
        if not v:
            continue
        if part in ("starred", "locked"):
            out.append(PART_WORDS[part])
        elif part == "text":
            out.append(f'{PART_WORDS[part]} · "{v}"')
        elif part == "checks":
            out.append(f"{PART_WORDS[part]} · {', '.join(CHECK_WORDS.get(s, s) for s in v)}")
        else:
            names = [tools._group_name(rows, by_id[g]) if part == "groups" and g in by_id else g for g in v]
            out.append(f"{PART_WORDS[part]} · {', '.join(names)}")
    return "; ".join(out)


def event_attrs(c: str) -> dict[str, str]:
    """`<scope>_filter` for each scope with a filter, in the chips' words; sent with each browser message to main and
    threads."""
    return {f"{scope}_filter": describe(c, entry) for scope, entry in concepts.read_filters(config.workspace_dir(c)).items()}


# --------------------------------------------------------------------------- the tools


def _find_label(ws: Any, name: str, scope: str) -> tuple[dict | None, str]:
    """(the label `name` names, by id, `concept:<id>` or name, among the labels over the scope's units, or None, and
    why not)."""
    key = name.strip()
    key = key[len("concept:"):] if key.startswith("concept:") else key
    concept = concepts.find_concept(ws, key)
    here = [k for k in concepts.list_concepts(ws) if k["unit"] in SCOPE_UNITS[scope]]
    names = ", ".join(repr(k["name"]) for k in here) or "none yet"
    if concept is None:
        return None, f"set_filter: no label {name!r}; the labels over {scope} are {names}"
    if concept["unit"] not in SCOPE_UNITS[scope]:
        return None, (f"set_filter: the label {concept['name']!r} labels {tools.UNIT_WORDS.get(concept['unit'], concept['unit'])}s, "
                      f"not {scope}; the labels over {scope} are {names}")
    return concept, ""


def _flag(v: Any) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "yes", "1"))


def _strings(v: Any) -> list[str]:
    items = [v] if isinstance(v, str) else v if isinstance(v, list) else []
    return [" ".join(str(x).split()) for x in items if str(x).strip()]


def _card_parts(c: str, args: dict, cards: list[dict]) -> tuple[dict, str]:
    """(the card parts a call names, checked and resolved: groups as ids, kinds and makers as the canvas writes them;
    the error when one is not known)."""
    from . import notebook

    out: dict[str, Any] = {}
    if "kinds" in args and args["kinds"] is not None:
        kinds = ["note" if k.casefold() == "md" else k.casefold() for k in _strings(args["kinds"])]
        bad = [k for k in kinds if k not in tools.CELL_KINDS]
        if bad:
            return {}, f"set_filter: no card kind {', '.join(map(repr, bad))}; the kinds are {', '.join(tools.CELL_KINDS)}"
        out["kinds"] = kinds
    if "groups" in args and args["groups"] is not None:
        ws = config.workspace_dir(c)
        ids = []
        for g in _strings(args["groups"]):
            row = tools._find_notebook(ws, g)
            if row is None:
                rows = notebook.list_notebooks(ws, figures=False)
                return {}, f"set_filter: no group {g!r}; the groups are {', '.join(repr(tools._group_name(rows, r)) for r in rows)}"
            ids.append(row["id"])
        out["groups"] = ids
    if "makers" in args and args["makers"] is not None:
        present = sorted({x["maker"] for x in cards if x["maker"]})
        by_key = {m.casefold(): m for m in present}
        makers = []
        for m in _strings(args["makers"]):
            if m.casefold() not in by_key:
                return {}, f"set_filter: no card on the canvas was made by {m!r}; its makers are {', '.join(map(repr, present))}"
            makers.append(by_key[m.casefold()])
        out["makers"] = makers
    if "checks" in args and args["checks"] is not None:
        # by the state's name or its word in the Filter menu: `not checked` is unchecked
        by_word = {**{s: s for s in CHECK_STATES}, **{w.casefold(): s for s, w in CHECK_WORDS.items()}}
        checks = []
        for s in _strings(args["checks"]):
            state = by_word.get(s.casefold().replace("_", " ")) or by_word.get(s.casefold())
            if state is None:
                words = ", ".join(repr(w.casefold()) for w in CHECK_WORDS.values())
                return {}, f"set_filter: no check state {s!r}; the states are {words}"
            if state not in checks:
                checks.append(state)
        out["checks"] = checks
    for part in ("starred", "locked"):
        if part in args and args[part] is not None:
            out[part] = _flag(args[part])
    if "text" in args and args["text"] is not None:
        out["text"] = " ".join(str(args["text"]).split())
    return out, ""


def _kept_line(c: str) -> str:
    view = canvas_view(c)
    return " " + tools.hint("set_filter-kept", kept=len(view["kept"]), total=len(view["cards"])) if view else ""


async def tool_set_filter(ctx: Any, args: dict[str, Any]) -> Any:
    """The `set_filter` tool."""
    scope = str(args.get("scope") or "").strip().lower()
    if scope not in concepts.SCOPES:
        return tools.err(f"set_filter: `scope` must be one of {', '.join(concepts.SCOPES)}")
    named = [p for p in concepts.CARD_PARTS if args.get(p) is not None]
    if named and scope != "canvas":
        return tools.err(f"set_filter: {', '.join(named)} filter the canvas's cards; set them with scope canvas")
    label = args.get("label")
    if label is None and not named:
        return tools.err(f"set_filter: name a `label`{', or a part of the card filter' if scope == 'canvas' else ''}")
    ws = ctx.ws
    concept, value = None, ""
    if label is not None and str(label).strip():
        concept, why = _find_label(ws, str(label), scope)
        if concept is None:
            return tools.err(why)
        value = " ".join(str(args.get("value") or "").split())
        if not value:
            value = concept["labels"][0]
        else:
            match = next((v for v in concept["labels"] if v.casefold() == value.casefold()), None)
            if match is None:
                return tools.err(f"set_filter: the label {concept['name']!r} has no value {value!r}; its values are "
                                 f"{', '.join(map(repr, concept['labels']))}")
            value = match
    parts: dict[str, Any] = {}
    if named:
        cards = await asyncio.to_thread(canvas_cards, ctx.c)
        parts, why = _card_parts(ctx.c, args, cards)
        if why:
            return tools.err(why)
    if concept is not None:
        concepts.set_filter(ctx.c, scope, concept["id"], value)
    elif label is not None:
        concepts.clear_filter(ctx.c, scope)
    if parts:
        now = concepts.card_parts(concepts.read_filters(ws).get("canvas"))
        concepts.set_card_filter(ctx.c, {**now, **parts})
    entry = concepts.read_filters(ws).get(scope)
    if not entry:
        return tools.ok(tools.hint("clear_filter-cleared", scope=scope))
    text = tools.hint("set_filter-set", scope=scope, filter=describe(ctx.c, entry))
    if scope == "canvas":
        text += await asyncio.to_thread(_kept_line, ctx.c)
    elif scope == "files":
        text += " " + tools.hint("set_filter-files")
    return tools.ok(text)


async def tool_clear_filter(ctx: Any, args: dict[str, Any]) -> Any:
    """The `clear_filter` tool: the scope's whole filter goes."""
    scope = str(args.get("scope") or "").strip().lower()
    if scope not in concepts.SCOPES:
        return tools.err(f"clear_filter: `scope` must be one of {', '.join(concepts.SCOPES)}")
    concepts.clear_filter(ctx.c, scope, whole=True)
    return tools.ok(tools.hint("clear_filter-cleared", scope=scope))
