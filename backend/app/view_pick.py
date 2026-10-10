"""`pick_views`: propose many views, keep two (views round 5, pipeline 5; exploration).

Main writes about eight concepts for a view, each a different kind of form, and calls `pick_views`. One structured
model call (model.structured, on Settings' dev row, as a build runs) reads prompts/view-pick.md, which holds the
guidelines and the concepts and nothing of main's reasoning, and keeps the two concepts that best follow the guidelines
and differ from each other. The tool answers with the two, each with its reason; main then proposes both with
`propose_view`, and each is built. The picker reads the concepts in a shuffled order (seeded by their names), so the
order main wrote them in does not lean its pick. Every call's concepts, the order shown and the two kept are kept in
the workspace's views/picks.json.

The tool is listed only where the prompts' tools.md has its section (tools.Spec.optional)."""
from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from typing import Any

from . import config, views

PICKS_FILE = "picks.json"  # in the workspace's views state folder: every call's concepts and the two kept, in order
FEW, MANY = 3, 16  # concepts a call takes
PROMPT = "view-pick"
TOOL_NAME = "keep_two"
SCHEMA = {"type": "object", "properties": {
    "keep": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
    "why": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2}},
    "required": ["keep", "why"]}


def picks_path(c: str):
    return views.state_dir(c) / PICKS_FILE


def check(args: dict[str, Any]) -> tuple[list[dict[str, str]], str | None]:
    """The concepts, each {name, concept} as text, and what is wrong with them (None when nothing). A concept given in
    other fields (form, question) is joined into `concept`."""
    raw = args.get("concepts")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if not isinstance(raw, list):
        return [], "pick_views: `concepts` is a list of objects, each with name and concept"
    out = []
    for i, x in enumerate(raw, 1):
        if not isinstance(x, dict):
            return [], f"pick_views: concept {i} is not an object with name and concept"
        name = " ".join(str(x.get("name") or "").split())
        body = " ".join(str(x.get("concept") or "").split()) or " ".join(
            " ".join(str(v).split()) for k, v in x.items() if k != "name" and isinstance(v, str))
        if not name or not body:
            return [], f"pick_views: concept {i} has no {'name' if not name else 'concept'}"
        out.append({"name": name, "concept": body})
    if not FEW <= len(out) <= MANY:
        return [], f"pick_views: give about eight concepts, not {len(out)}"
    return out, None


def shuffled(concepts: list[dict[str, str]]) -> list[int]:
    """The order the picker reads the concepts in, as indices into `concepts`: shuffled, seeded by their names, so the
    order main wrote them in (its favorite first, often) does not lean the pick, and one list always reads the same."""
    order = list(range(len(concepts)))
    random.Random("\n".join(r["name"] for r in concepts)).shuffle(order)
    return order


def listing(concepts: list[dict[str, str]]) -> str:
    return "\n\n".join(f"{i}. {r['name']}\n{r['concept']}" for i, r in enumerate(concepts, 1))


def store(c: str, entry: dict[str, Any]) -> None:
    p = picks_path(c)
    try:
        rows = json.loads(p.read_text("utf-8")) if p.is_file() else []
    except (OSError, ValueError):
        rows = []
    rows = rows if isinstance(rows, list) else []
    rows.append({"n": len(rows) + 1, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry})
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(p)


async def tool_pick_views(ctx: Any, args: dict[str, Any]) -> Any:
    """The `pick_views` tool: the two concepts the picker keeps, each with its reason, as JSON."""
    from . import model, prompts, tools  # noqa: PLC0415

    concepts, problem = check(args)
    if problem:
        return tools.err(problem)
    order = shuffled(concepts)
    shown = [concepts[i] for i in order]
    try:
        text = prompts.render(PROMPT, {"concepts": listing(shown)})
    except prompts.PromptError as e:
        return tools.err(f"pick_views: its prompt could not be made ({e})")
    role = config.call_settings(ctx.c, "dev")
    spec = model.ToolSpec(name=TOOL_NAME, description="The two concepts you keep, by number, and why.",
                          input_schema=SCHEMA)
    res = await model.structured(text, tool=spec, model=role["model"], effort=role["effort"], speed=role["speed"],
                                 refusal=role["refusal"], cwd=config.corpus_dir(ctx.c))
    entry: dict[str, Any] = {"concepts": concepts, "order": [i + 1 for i in order], "prompt": text,
                             "status": res.status, "model": res.model_used, "cost_usd": res.cost_usd}
    keep = (res.output or {}).get("keep") if res.status == "ok" else None
    why = (res.output or {}).get("why") or ["", ""]
    if not (isinstance(keep, list) and len(set(keep)) == 2 and all(isinstance(k, int) and 1 <= k <= len(concepts)
                                                                    for k in keep)):
        entry["detail"] = res.detail or f"the picker kept {keep!r}"
        store(ctx.c, entry)
        return tools.err(f"pick_views: the picker gave no two concepts ({entry['detail']})")
    kept = [{"n": order[k - 1] + 1, **shown[k - 1], "why": str(w)} for k, w in zip(keep, why)]  # n: main's numbering
    entry["kept"] = kept
    store(ctx.c, entry)
    return tools.ok(json.dumps({"kept": kept}, indent=1, ensure_ascii=False))
