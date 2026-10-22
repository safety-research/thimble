"""Marks: the claims of a reply that the analyst would want to check, which Claude writes as `[words](#)` (the terminal's
guidance, section Marking claims). They are checked after the reply, as the terminal checks them
(plugin/marks/checker.ts):

1. After a turn of the chat's agent that ended normally, the marks of its texts (marks_of.mjs, with the terminal's
   message.js) are kept, all `checking`, and the page draws each with a spinner.
2. The checker: copies of the chat (agent.Sessions.spawn, agent `checker`), up to MAX_FORKS at once, each with a share
   of the marks, read the terminal's checker.md and give one JSON item per mark: verified, corrected, wrong or
   unconfirmed, with its evidence. A copy runs main's prompt and tools, so its requests read main's cached
   conversation, and it may only read and run Python.
3. The validator, the terminal's own (plugin/engine/kernel/evidence.py, through kernel.py), checks that evidence with
   no model call and no code run: a quote must stand in the file's line, and computed evidence names one of the
   conversation's real run_python calls (the checker's or main's) by a part of its output, and that call's real output
   must show the words. Its result is what the analyst sees.
4. When the reply's last mark settles, the chat's agent reads what the check changed with the analyst's next message
   (agent.tell), in the terminal's words.

Every way a check ends (an answer, a refusal, an error, a stop) leaves none of its marks `checking`. A reply's marks are
kept in `marks/<chat>/<turn>.json`, and each change is written to the chat's log as a `marks` record, which the page
reads (the newest record of a turn wins).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any

from .. import agent, chats, home, prompts
from ..hub import hub
from . import Feature
from .cards import fenced, notice

log = logging.getLogger("thimble_browser.marks")

MARKS_OF = Path(__file__).resolve().parents[1] / "marks_of.mjs"
# A reply with many marks is split between copies, each with about PER_FORK marks (at most MAX_FORKS copies), which run
# at once, so the reply settles when its slowest share does (the terminal's checker.ts).
PER_FORK = 4
MAX_FORKS = 8
CHECKER_TOOLS = ("Read", "Grep", "Glob", "run_python")
_locks: dict[tuple[str, str, str], asyncio.Lock] = {}


# ---- a reply's marks: marks/<chat>/<turn>.json {chat, turn, items, times, told}

def _path(ws: str, chat: str, turn: str) -> Path:
    if not (home.NAME_RE.match(chat) and re.fullmatch(r"[0-9a-f]{8}", turn)):
        raise KeyError(f"{chat}/{turn}")
    return home.workspace_dir(ws) / "marks" / chat / f"{turn}.json"


def stored(ws: str, chat: str, turn: str) -> dict[str, Any] | None:
    try:
        got = home.read_json(_path(ws, chat, turn))
    except KeyError:
        return None
    return got if isinstance(got, dict) else None


def reply_items(ws: str, chat: str, turn: str) -> list[dict[str, Any]]:
    return (stored(ws, chat, turn) or {}).get("items") or []


def _save(ws: str, reply: dict[str, Any]) -> None:
    home.write_json(_path(ws, reply["chat"], reply["turn"]), reply)
    chats.append(ws, reply["chat"], {"type": "marks", "turn": reply["turn"], "items": reply["items"]})


async def marks_of(texts: list[str]) -> list[dict[str, Any]]:
    """Each mark of the texts: {piece, k, words, sentence} (marks_of.mjs)."""
    proc = await asyncio.create_subprocess_exec("node", str(MARKS_OF), stdin=asyncio.subprocess.PIPE,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate(json.dumps({"texts": texts}).encode())
    if proc.returncode != 0:
        raise RuntimeError(err.decode(errors="replace").strip()[-300:] or "marks_of.mjs failed")
    return json.loads(out.decode())


def split_marks(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """The marks split into the copies' shares, in order: one share up to PER_FORK marks, else as many as PER_FORK gives
    (at most MAX_FORKS), of about equal size. The marks of one sentence stay in one share up to a share's size, since a
    copy writes the notes on its sentences; each run of a sentence's marks goes to the share its middle falls in."""
    k = min(MAX_FORKS, max(1, -(-len(items) // PER_FORK)))
    size = -(-len(items) // k)
    runs: list[list[dict[str, Any]]] = []
    for m in items:
        if runs and runs[-1][0]["sentence"] == m["sentence"] and len(runs[-1]) < size:
            runs[-1].append(m)
        else:
            runs.append([m])
    out: list[list[dict[str, Any]]] = [[] for _ in range(k)]
    before = 0
    for run in runs:
        out[min(k - 1, int((before + len(run) / 2) * k / len(items)))].extend(run)
        before += len(run)
    return [s for s in out if s]


def tell_text(items: list[dict[str, Any]]) -> str:
    """What the chat's agent reads with the analyst's next message: each mark the check corrected or flagged, and each
    note, as the analyst reads them (the terminal's tellText). The check's own words are quoted, since they may quote
    the records."""
    def q(w: str) -> str:
        return w if re.match(r"^[\"“]", w) else f"\"{w}\""

    def why(m: dict[str, Any]) -> str:
        return f" (the check: {q(m['reason'])})" if m.get("reason") else ""

    said = []
    for m in items:
        if m["status"] == "corrected":
            said.append(f"- {q(m.get('was') or m['words'])} is corrected to {q(m['shown'])}{why(m)}")
        elif m["status"] == "failed" and m.get("failedBy") == "evidence":
            said.append(f"- {q(m['words'])} is marked as not confirmed{why(m)}")
        elif m["status"] == "failed":
            said.append(f"- {q(m['words'])} is marked as wrong{why(m)}")
    notes = [f"- {q(n)}" for n in dict.fromkeys(m["note"] for m in items if m.get("note"))]
    if not said and not notes:
        return ""
    parts = ["thimble checked the marks of your last reply against the data. Its words in the blocks below may quote "
             "the records."]
    if said:
        parts.append("The analyst sees these changes in the reply:\n" + fenced("\n".join(said)))
    if notes:
        parts.append("Under the reply, the analyst also reads what the check found false in its unmarked statements:\n"
                     + fenced("\n".join(notes)))
    parts.append("Use the corrected facts from now on. The analyst has read these where they stand, so a correction of "
                 "them in your next reply would tell them twice. A claim the check could not confirm may still be "
                 "true: when you need it again, check it first.")
    return "\n".join(parts)


async def _edit(ws: str, chat: str, turn: str, change: Any) -> dict[str, Any] | None:
    """A change of a reply's marks, one at a time; when it settles the reply's last mark, the busy line's step ends
    and the chat's agent is told what the check changed."""
    async with _locks.setdefault((ws, chat, turn), asyncio.Lock()):
        reply = stored(ws, chat, turn)
        if reply is None:
            return None
        was_open = any(m["status"] == "checking" for m in reply["items"])
        reply = change(reply)
        settled = was_open and not any(m["status"] == "checking" for m in reply["items"])
        if settled:
            reply["times"]["settled"] = time.time()
        _save(ws, reply)
    if settled:
        hub.publish(ws, {"type": "busy", "id": reply["busy"], "word": "checking marks", "on": False})
        if text := tell_text(reply["items"]):
            agent.tell(ws, chat, text)
    return reply


async def _give_up(ws: str, chat: str, turn: str, ns: set[int], why: str) -> None:
    """Each of these marks still checked becomes unchecked: no check gave an answer for it."""
    def change(r: dict[str, Any]) -> dict[str, Any]:
        r["items"] = [{**m, "status": "unchecked", "reason": why} if m["n"] in ns and m["status"] == "checking" else m
                      for m in r["items"]]
        return r

    await _edit(ws, chat, turn, change)


# ---- 1, 2: after a turn, the marks and the checker's copies

def after_turn(s: Any, answer: str, result: str | None) -> None:
    from .. import features  # noqa: PLC0415

    if features.is_on("marks") and s.turn and s.texts:
        asyncio.get_running_loop().create_task(start_check(s.manager, s.ws, s.chat, s.turn, list(s.texts), result))


async def start_check(sessions: Any, ws: str, chat: str, turn: str, texts: list[str], result: str | None) -> None:
    try:
        found = await marks_of(texts)
    except (OSError, RuntimeError, ValueError) as e:
        notice(ws, chat, f"thimble could not read the marks of this reply ({str(e)[:120]}), so they are not checked.")
        return
    if not found:
        return
    items = [{**m, "n": n, "status": "checking", "shown": m["words"]} for n, m in enumerate(found, 1)]
    busy = secrets.token_hex(4)
    reply = {"chat": chat, "turn": turn, "items": items, "busy": busy, "times": {"reply_end": time.time()}}
    _save(ws, reply)
    if result is not None:
        await _give_up(ws, chat, turn, {m["n"] for m in items}, "the reply was interrupted before its marks were checked")
        return
    hub.publish(ws, {"type": "busy", "id": busy, "word": f"checking {len(items)} mark{'s' if len(items) != 1 else ''}",
                     "on": True})
    folder = str(home.corpus_of(ws))
    template = prompts.fill(prompts.shared("checker"), {"CWD": folder, "ROOT": folder})
    for share in split_marks(items):
        lines = "\n".join(f"{m['n']}. [{m['words']}] in: {m['sentence']}" for m in share)
        try:
            await sessions.spawn(ws, "checker", chat, prompts.fill(template, {"MARKS": lines}), title="checking marks",
                                 meta={"check": {"chat": chat, "turn": turn, "marks": [m["n"] for m in share]}})
        except Exception as e:  # noqa: BLE001 — a share that cannot start leaves its marks unchecked, and says so
            log.warning("a check of the marks could not start: %s", e)
            await _give_up(ws, chat, turn, {m["n"] for m in share}, "the check could not start")
            notice(ws, chat, f"The check of the marks could not start ({str(e)[:80]}), so they are not checked.")
    r = stored(ws, chat, turn)
    if r:
        r["times"]["spawned"] = time.time()
        home.write_json(_path(ws, chat, turn), r)


# ---- 3, 4: a copy ended: the validator, the marks' statuses

def run_python_calls(messages: list[dict[str, Any]], by: str) -> list[dict[str, Any]]:
    """The run_python calls of a conversation with their output as Claude read it, each as the validator reads a call:
    its command written as the terminal's one Python script (`python3 - <<'PY'`, the code, `PY`). A call that ended
    with an error counts too, since what it printed before the error is real output."""
    code: dict[str, str] = {}
    out = []
    for m in messages:
        for b in m.get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and b.get("name") == "run_python":
                code[b["id"]] = str((b.get("input") or {}).get("code") or "")
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in code:
                c = b.get("content")
                text = c if isinstance(c, str) else "".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
                out.append({"command": f"python3 - <<'PY'\n{code[b['tool_use_id']]}\nPY", "output": text, "by": by})
    return out


def cited_outputs(answer: str) -> list[str]:
    """The outputs the checker's answer cites as evidence (`"output": "…"`): a call of main's whose output holds none of
    them cannot be a mark's evidence, so the validator is not sent it (the terminal's checker.ts citedOutputs)."""
    out = []
    for m in re.finditer(r'"output"\s*:\s*("(?:[^"\\]|\\.)*")', answer):
        try:
            out.append(str(json.loads(m.group(1))))
        except ValueError:
            continue
    return out


def check_finished(s: Any, result: str | None) -> None:
    asyncio.get_running_loop().create_task(end_check(s, result))


GIVE_UP = {"refused": "The model's safeguards refused the check of the marks, so they are not checked. Settings can "
                      "switch to another model.",
           "stopped": "The check of the marks was stopped, so they are not checked.",
           "failed": "The check of the marks stopped on an error, so they are not checked. The next reply is checked "
                     "again."}


async def end_check(s: Any, result: str | None) -> None:
    from ..kernel import evidence  # noqa: PLC0415 — the plugin's kernel, loaded when a check first ends

    check = s.meta.get("check") or {}
    ws, chat, turn, mine = s.ws, check.get("chat"), check.get("turn"), set(check.get("marks") or [])
    if not chat or not turn:
        return
    ended = time.time()
    try:
        if result is not None:
            await _give_up(ws, chat, turn, mine, "safeguards refused the check" if result == "refused"
                           else f"the check ended: {result}")
            notice(ws, chat, GIVE_UP.get(result, GIVE_UP["failed"]))
            return
        answer = "\n".join(s.texts)
        items = [m for m in reply_items(ws, chat, turn) if m["n"] in mine]
        cited = cited_outputs(answer)
        main = [c for c in run_python_calls(agent.load_messages(ws, chat), "main")
                if any(evidence.printed(o, c["output"]) is not None for o in cited)]
        calls = run_python_calls(agent.load_messages(ws, s.chat), "checker") + main
        folder = str(home.corpus_of(ws))
        got = await asyncio.to_thread(evidence.check_all, [{k: m[k] for k in ("n", "words", "sentence")} for m in items],
                                      answer, calls, folder, folder, str(home.temp_dir(ws)))
        if not got["parsed"]:
            await _give_up(ws, chat, turn, mine, "the check gave no answer thimble could read")
            notice(ws, chat, "The check of the marks gave no answer thimble could read, so they are not checked.")
            return
        by_n = {int(r["n"]): r for r in got["results"]}

        def change(r: dict[str, Any]) -> dict[str, Any]:
            def judged(m: dict[str, Any]) -> dict[str, Any]:
                res = by_n.get(m["n"])
                if m["n"] not in mine or m["status"] != "checking":
                    return m
                if res is None:
                    return {**m, "status": "unchecked", "reason": "the check gave no answer for this mark"}
                return {**m, **{k: v for k, v in res.items() if k != "n"}, "shown": str(res.get("shown") or m["words"])}

            r["items"] = [judged(m) for m in r["items"]]
            r["times"].setdefault("checks", []).append({"marks": len(mine), "ended": ended, "validated": time.time()})
            return r

        await _edit(ws, chat, turn, change)
    except Exception as e:  # noqa: BLE001 — a check that cannot be validated leaves its marks unchecked, and says so
        log.exception("the check of the marks failed")
        notice(ws, chat, f"thimble could not validate the check of the marks ({type(e).__name__}: {str(e)[:80]}), so "
                         "they are not checked.")
    finally:
        await _give_up(ws, chat, turn, mine, "the check ended before it judged this mark")


agent.AGENTS["checker"] = agent.AgentDef(
    agent.main_prompt, agent.main_tools, finished=check_finished, allowed=CHECKER_TOOLS,
    denied="The check of the marks only reads: it can use Read, Grep, Glob, and run_python to run Python.")
agent.AFTER_TURN.append(after_turn)


FEATURE = Feature(
    name="marks",
    title="Marks",
    does="Claude marks the claims you would check, and a second Claude checks each one after the reply.",
    prompt="marks.md",
)
