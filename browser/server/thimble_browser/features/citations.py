"""Citations: links from a statement to what it rests on, a record of a file, lines of code, a value of a card's table
or a label's count. Claude writes them as Markdown links wherever it writes (an answer, a takeaway, the report), and a
click opens the place.

It owns what a ref resolves to (GET /api/corpora/{c}/ref, for the page; read_ref, for Claude), the `Citing` part of
the chat agent's prompt (prompts/citations.md, the terminal's own words through prompts/shared.json) and, on the page,
citations as links. While it is off, Claude is not asked to cite, and the page draws a link's words as plain text.
"""
from __future__ import annotations

from typing import Any

from .. import canvas, corpus, tools
from ..tools import Result
from . import Feature
from .cards import describe


def resolve(ws: str, folder: Any, ref: str, value: str | None = None) -> dict[str, Any]:
    """What `ref` points at, as the page opens it: {ref, kind, excerpt, ...}; KeyError, FileNotFoundError or
    corpus.OutsideFolder for a ref that names nothing. `value` is the citation's own words, which a citation of a
    card's value is read against (canvas.resolve_card_ref)."""
    if (fn := tools.resolver(ref)) is not None:
        return fn(ws, ref)
    if ref.startswith(("card:", "cell:")):
        got = canvas.resolve_card_ref(ws, ref, value)
        _, cell = canvas.find(ws, ref)
        got["record"] = cell
        return got
    got = corpus.resolve(folder, ref)
    if got["kind"] in ("record", "range"):
        end = got.get("meta", {}).get("end", got["line"])
        page = corpus.page(folder, got["path"], got["line"], end - got["line"] + 1)
        got.update(end_line=end, records=page["records"])
    return got


def bare_ref(ref: str) -> str:
    """A ref without the brackets it may be passed in, `[card:<id>]` or `(card:<id>)`. The brackets a ref holds itself
    stay, balanced as in `card:<id>#revisions/(no name)`."""
    ref = ref.strip().lstrip("[(")
    while ref[-1:] in (")", "]") and ref.count(ref[-1]) > ref.count("(" if ref[-1] == ")" else "["):
        ref = ref[:-1]
    return ref


async def read_ref(t: Any, args: dict[str, Any]) -> Result:
    ref = bare_ref(str(args.get("ref") or ""))
    for prefix, reader in tools.REFS.items():
        if ref.startswith(prefix):
            return reader(t, ref)
    try:
        if (fn := tools.resolver(ref)) is not None:
            got = fn(t.ws, ref)
            return Result(f"{ref} ({got['kind']})\n{got.get('excerpt', '')}")
        if ref.startswith(("card:", "cell:")):
            _, cell = canvas.find(t.ws, ref)
            got = canvas.resolve_card_ref(t.ws, ref)
            return Result(describe(cell) + ("" if got["kind"] == "cell" else f"\n\n{got['excerpt']}"))
        got = corpus.resolve(t.folder, ref)
        return Result(f"{got.get('path')} ({got['kind']})\n{got.get('excerpt', '')}")
    except (KeyError, FileNotFoundError, IndexError, corpus.OutsideFolder, ValueError) as e:
        return Result(f"no such place: {ref} ({e})", True)


def heal_text(ws: str, text: str) -> dict[str, Any]:
    """The healing pass (cards/heal.py) over a text that cites cards: what it did to each citation, for the page."""
    from ..cards import heal as H

    def load(cid: str) -> dict | None:
        try:
            return canvas.find(ws, cid)[1]
        except KeyError:
            return None

    return H.heal(text, load)


def register(ctx: Any) -> None:
    @ctx.app.post("/api/corpora/{c}/heal")
    def heal_route(c: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return heal_text(c, str(body.get("text") or ""))
        except Exception as e:  # noqa: BLE001
            raise ctx.bad(e) from None

    @ctx.app.get("/api/corpora/{c}/ref")
    def resolve_ref(c: str, ref: str, value: str | None = None) -> dict[str, Any]:
        try:
            return resolve(c, ctx.folder_of(c), ref, value)
        except Exception as e:  # noqa: BLE001
            raise ctx.bad(e) from None


FEATURE = Feature(
    name="citations",
    title="Citations",
    does="Each number and quote Claude writes links to the records it came from; a click opens them.",
    register=register,
    tools={"read_ref": read_ref},
    main_tools=("read_ref",),
    prompt="citations.md",
    page=("citations",),
)
