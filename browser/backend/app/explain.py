"""e in the chat: an explainer of words the analyst selected in one of Claude's answers, written on demand as the
terminal's e writes one (plugin/explain/expand.ts), on main's answers and on a side thread's.

POST /ws/{c}/explain {chat, turn, words}: the answer is the run of chat `chat` (main, or a side thread) whose `done`
record names `turn`: its texts, and the analyst's question before them (_turn). The words stand on the first sentence of
the answer that holds them (answer_comments.passages, words_in), where the explainer is a comment of the Explainers check
(answer_comments.add, `asked`), worded as the look's explainers are (look.explainer_comment): the chat tints its words in
the check's color and opens it on them, as it does any explainer, and it stays with the answer. The check must show in
the chat (on, with Chat in its Show in), as the terminal's e needs Explainers on.

What it says comes from one fork of main (marks.run_fork, as the look and the citation check fork it), which reads the
terminal's text (the registry's `explain-expand`), then the words, the question, the answer as the terminal reads it
(its citations as Markdown links, cite.to_links) and the lines of the files it cites: the places the check of its
citations found (its marks' evidence), then the files it links to (explain_of.mjs, with the terminal's
plugin/explain/ask.mjs). As in the terminal, a term is explained once in a session: words an open explainer already
explains take its words, with no call, on the sentence that holds them here. An open explainer or heads-up of the
answer's whose words hold the words is the answer, and so is a heads-up whose words the new explainer would meet, since
the two never share words (answer_comments.add).

    _turn(c, chat, turn)          -> {texts, question, at} of that run, or None
    explain(c, chat, turn, words) -> the comment, or (status, why there is none)
"""
from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agents, answer_comments, config, look

log = logging.getLogger("thimble.explain")
router = APIRouter()

HERE = Path(__file__).resolve().parent
EXPLAIN_OF = HERE / "explain_of.mjs"
CHECK = "explainers"  # the check whose comment an explainer is (look.LENS_OF)
HEADS = "heads-up"  # the check whose heads-ups never share words with an explainer (answer_comments.APART)
SHORT = 40  # characters of the words a line names, as the terminal's names them
OFF = "Explainers is off for the chat. Turn it on under Comments in the top bar, with Chat in its Show in."


def _norm(words: Any) -> str:
    """Words as a term: without the backticks of code, white space as one space (the terminal's termOf)."""
    return " ".join(str(words or "").replace("`", "").split())


def _short(words: str) -> str:
    return words if len(words) <= SHORT else f"{words[:SHORT - 1]}…"


def _turn(c: str, chat: str, turn: str) -> dict[str, Any] | None:
    """The run of chat `chat` whose `done` record names `turn`: its texts as the page shows them as that run's rows
    (each text record after the run before it but an API error's line, as threads.answer reads a thread's), the
    analyst's question that started it (the first message after the run before it that thimble did not send), and when
    it ended; None when no run ended under `turn`."""
    texts: list[str] = []
    question = ""
    for r in agents.read_events(agents.paths(c, chat)[1]):
        kind = r.get("type")
        if kind == "done":
            if r.get("turn") == turn:
                return {"texts": texts, "question": question, "at": r.get("ts")}
            texts, question = [], ""
        elif kind == "user" and not question and r.get("by") != agents.THIMBLE:
            question = str(r.get("text") or "")
        elif kind == "text" and not r.get("api_error") and str(r.get("delta") or "").strip():
            texts.append(str(r["delta"]))
    return None


async def _node(req: dict[str, Any]) -> dict[str, Any]:
    """explain_of.mjs on `req`, in a worker thread as look.py runs its Node (marks.marks_of says why)."""
    done = await asyncio.to_thread(subprocess.run, ["node", str(EXPLAIN_OF)], input=json.dumps(req).encode(),
                                   capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace").strip()[-300:] or "explain_of.mjs failed")
    return json.loads(done.stdout.decode())


def _shown(c: str) -> bool:
    """Whether the chat shows the Explainers check's comments: it is on, with Chat in its Show in."""
    from . import checks  # noqa: PLC0415 — checks imports answer_comments, as this module does

    return answer_comments._in_chat(checks.read(c, CHECK))


def _standing(c: str, passage: dict[str, Any], words: str) -> dict[str, Any] | None:
    """On `passage`, an open explainer whose words hold `words`, or an open heads-up whose words meet them, of the checks
    the chat shows (answer_comments._seen): the terminal opens the explainer or heads-up the selected words stand
    inside, and a heads-up keeps its words, which an explainer never shares (answer_comments.APART); None for none."""
    m = answer_comments._find(answer_comments.plain(passage["text"]), words)
    if m is None:
        return None
    seen = answer_comments._seen(c)
    for cm in answer_comments.open_comments(c):
        if cm.get("ref") != passage["ref"] or cm.get("check") not in seen:
            continue
        a, b = answer_comments._span(cm)
        if (cm.get("check") == CHECK and a <= m.start() and m.end() <= b) or (
                cm.get("check") == HEADS and a < m.end() and m.start() < b):
            return cm
    return None


def _explained(c: str, words: str) -> dict[str, Any] | None:
    """The session's open explainer of these words, whatever their case, on any answer (the terminal's glossFor); None
    for none."""
    want = words.lower()
    return next((cm for cm in answer_comments.open_comments(c)
                 if cm.get("check") == CHECK and _norm(cm.get("words")).lower() == want), None)


async def explain(c: str, chat: str, turn: str, words: str, fork: Any = None) -> dict[str, Any] | tuple[int, str]:
    """The explainer of `words` on the answer of chat `chat`'s run `turn` (module note): the comment, new or standing,
    or (an HTTP status, a sentence that says why there is none). `fork`: what forks main, marks.run_fork unless given."""
    from . import checks, cite, marks  # noqa: PLC0415 — checks and marks import much of the app

    term = _norm(words)
    if not term:
        return 422, "Select some words in an answer to explain them."
    if not _shown(c):
        return 409, OFF
    got = await asyncio.to_thread(_turn, c, chat, turn)
    if got is None:
        return 404, "That answer is not in this chat any more."
    rows = [{"uuid": str(i), "text": t} for i, t in enumerate(got["texts"])]
    passage, said = None, None
    for p in answer_comments.passages({"turn": turn, "rows": rows}):
        said = answer_comments.words_in(p, term)
        if said:
            passage = p
            break
    if passage is None or not said:
        return 409, f"“{_short(term)}” isn't in the answer as Claude wrote it; select words of its text."
    standing = _standing(c, passage, said)
    if standing is not None:
        return standing
    before = _explained(c, said)
    if before is not None:
        text, details = str(before.get("text") or ""), str(before.get("details") or "")
    else:
        main = marks._main_now(c)
        if isinstance(main, str):
            return 409, f"The explanation of “{_short(term)}” was not written: {main}. Try again once Claude's session is attached."
        answer = cite.to_links("\n\n".join(got["texts"]))
        items = (marks.stored(c, turn) or {}).get("items") or []
        roots = [r for r in marks.check_folders(c, main[0]) if r]
        req = {"term": said, "question": got["question"], "answer": answer, "items": items, "roots": roots}
        try:
            prompt = (await _node({"prompt": req}))["prompt"]
        except (OSError, RuntimeError, ValueError) as e:
            log.exception("%s: the explainer's prompt was not written", c)
            return 502, f"The explanation of “{_short(term)}” was not written: {type(e).__name__}."
        ran = await (fork or marks.run_fork)(c, main[0], main[1], prompt)
        if ran.get("error") and not ran.get("answer"):
            return 502, f"The explanation of “{_short(term)}” was not written: {ran['error']}. Select the words and press e again."
        explainer = (await _node({"reply": str(ran.get("answer") or "")}))["explainer"]
        if not explainer:
            return 502, f"The explanation of “{_short(term)}” came back empty. Select the words and press e again."
        text, details = look.explainer_comment(said, explainer["body"], explainer["here"])
    cm, _new = answer_comments.add(c, passage=passage, text=text, details=details, author=checks.AUTHOR, check=CHECK,
                                   words=said, asked=True, chat="" if chat == agents.MAIN_ID else chat)
    return cm


class ExplainBody(BaseModel):
    chat: str
    turn: str
    words: str


@router.post("/ws/{c}/explain")
async def explain_route(c: str, body: ExplainBody) -> dict[str, Any]:
    """e on words the analyst selected in an answer: the explainer of them, which the chat opens (explain). {id, ref,
    turn, check}; 404 for no such answer, else 409 or 502 with why there is none."""
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e))
    got = await explain(c, body.chat, body.turn, body.words)
    if isinstance(got, tuple):
        raise HTTPException(got[0], got[1])
    return {"id": str(got["id"]), "ref": str(got.get("ref") or ""), "turn": str(got.get("turn") or ""),
            "check": str(got.get("check") or "")}
