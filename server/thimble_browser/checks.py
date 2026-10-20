"""Report checks: each a prompt that one of thimble's agents reads the report against, leaving comments beside the
passages it applies to (frontend report/Checks.tsx, report/checkComments.ts, report/Margin.tsx).

A check is `checks/<id>.json` in the workspace = {id, name, prompt, colour, shown, builtin, created_by, ts, version,
covers, runs: {report: Run}}. The built-ins are prompts/browser/checks/<id>.md, read from the prompt file until first
changed, each on or off as its front matter's `shown` says until the analyst turns it on or off. A check that is on
(`shown`) shows its comments, and runs again by itself after the writer saves the report, unless the home's checks.json
says `report_checks: false` (PUT /ws/{c}/checks/settings turns that on or off).

A run is the agent `check` (prompts/browser/check.md) in a chat of its own (kind `agent`, role `check`). Its first
message holds the check's instructions, the passages it covers, the report with the id of every passage, the cards and
the analyst's chat. It comments with add_comment and ends with one line, the run's summary. Run = {run, status:
running|done|failed|stopped, chat, started, ended, covered, seen, comments, summary, stale}.

The cache. A passage is a paragraph of the report, fingerprinted by its words. A run covers the passages whose
fingerprint the check has not seen (all of them once its prompt changes); a run that ends `done` supersedes the check's
earlier open comments on those passages and records their fingerprints in `seen`. `stale` counts the passages that
changed since the check's last run.

Comments are `docs/report.comments.json`: {id, sentence_id, paragraph?, text, details, author, check?, run?, evidence,
quote, ts, status: open|resolved, resolution?}. A comment keeps the words of the passage it is on (`quote`), so it
follows that passage when the report is written again, and leaves the page while no passage holds those words. The
report's routes serve the open ones as the document's `comments` (report.DECORATE). The analyst's Done resolves one, and
the analyst can leave their own comment on a sentence.

Main gets `run_check` and `stop_check`.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import secrets
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from . import agent, canvas, chats, home, prompts, report, tools
from .agent import AGENTS, READ, AgentDef
from .hub import hub

log = logging.getLogger("thimble_browser.checks")

ROLE = "check"
DOC = report.DOC
BUILTINS = ("judgment", "unverified", "important-details")
COLOURS = (3, 4, 6, 7, 8, 1, 2, 5)  # the label palette's places a new check takes, after the built-ins'
CHECK_TOOLS = READ + ("run_python", "read_ref", "list_cards", "add_comment")
MAIN_TOOLS = ("run_check", "stop_check")
CHAT_CHARS = 30_000
REF = re.compile(r"^report:([a-z0-9-]+)#([tp])(\d+(?:\.\d+)*)$")


def _now() -> str:
    return home.now()


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


# ---- the switch

def _conf_path() -> Path:
    return home.root() / "checks.json"


def auto() -> bool:
    """Whether the checks that are on run again by themselves after the writer saves the report."""
    return bool((home.read_json(_conf_path(), {}) or {}).get("report_checks", True))


def set_auto(on: bool) -> None:
    home.write_json(_conf_path(), {**(home.read_json(_conf_path(), {}) or {}), "report_checks": bool(on)})


# ---- the checks

def _dir(ws: str) -> Path:
    d = home.workspace_dir(ws) / "checks"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _front(text: str) -> tuple[dict[str, Any], str]:
    meta: dict[str, Any] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        for line in text[4:end].split("\n"):
            k, _, v = line.partition(":")
            v = v.strip()
            meta[k.strip()] = (v.lower() == "true" if v.lower() in ("true", "false") else
                               int(v) if v.isdigit() else
                               [x.strip() for x in v.strip("[]").split(",") if x.strip()] if v.startswith("[") else v)
        text = text[end + 5:]
    return meta, text.strip()


def builtin(cid: str) -> dict[str, Any] | None:
    if cid not in BUILTINS:
        return None
    meta, body = _front(prompts.read(f"browser/checks/{cid}.md"))
    return {"id": cid, "name": str(meta.get("name") or cid), "prompt": body, "colour": int(meta.get("color") or 1),
            "shown": bool(meta.get("shown")), "builtin": True, "created_by": "thimble", "ts": None, "version": 1,
            "covers": ["documents"], "runs": {}}


def read(ws: str, cid: str) -> dict[str, Any] | None:
    if not home.NAME_RE.match(cid):
        return None
    got = home.read_json(_dir(ws) / f"{cid}.json")
    if isinstance(got, dict):
        return got
    return builtin(cid)


def save(ws: str, check: dict[str, Any]) -> dict[str, Any]:
    for r in (check.get("runs") or {}).values():
        r.pop("stale", None)  # counted as the checks are listed (_with_stale), never stored
    home.write_json(_dir(ws) / f"{check['id']}.json", check)
    hub.publish(ws, {"type": "checks", "id": check["id"]})
    return check


def list_checks(ws: str) -> list[dict[str, Any]]:
    out = [read(ws, b) for b in BUILTINS]
    for p in sorted(_dir(ws).glob("*.json"), key=lambda p: p.stat().st_mtime):
        if p.stem not in BUILTINS:
            got = home.read_json(p)
            if isinstance(got, dict):
                out.append(got)
    out = [c for c in out if c]
    for c in out:
        _with_stale(ws, c)
    return out


def by_name(ws: str, name: str) -> dict[str, Any] | None:
    key = _collapse(name).lower()
    for c in list_checks(ws):
        if c["name"].lower() == key or c["id"] == key:
            return c
    return None


def create(ws: str, name: str, prompt: str, *, created_by: str) -> dict[str, Any]:
    name, prompt = _collapse(name), prompt.strip()
    if not name or not prompt:
        raise ValueError("a check needs a name and a prompt")
    if by_name(ws, name):
        raise FileExistsError(f"there is a check named {name!r} already")
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "check"
    cid, n = base, 2
    while read(ws, cid) is not None:
        cid, n = f"{base}-{n}", n + 1
    used = {c.get("colour") for c in list_checks(ws)}
    colour = next((k for k in COLOURS if k not in used), COLOURS[len(used) % len(COLOURS)])
    return save(ws, {"id": cid, "name": name, "prompt": prompt, "colour": colour, "shown": True, "builtin": False,
                     "created_by": created_by, "ts": _now(), "version": 1, "covers": ["documents"], "runs": {}})


def edit(ws: str, cid: str, **patch: Any) -> dict[str, Any]:
    check = read(ws, cid)
    if check is None:
        raise KeyError(cid)
    if patch.get("name") is not None and _collapse(patch["name"]):
        check["name"] = _collapse(patch["name"])
    if patch.get("prompt") is not None and patch["prompt"].strip() and patch["prompt"].strip() != check["prompt"]:
        check["prompt"] = patch["prompt"].strip()
        check["version"] = int(check.get("version") or 1) + 1
        for r in (check.get("runs") or {}).values():
            r["seen"] = []
    if patch.get("colour") is not None:
        check["colour"] = int(patch["colour"])
    if patch.get("shown") is not None:
        check["shown"] = bool(patch["shown"])
    return save(ws, check)


# ---- passages and comments

def passages(ws: str) -> list[dict[str, Any]]:
    """The report's paragraphs: {ref, id, sentences: [{id, text}], text, fp}."""
    doc = report.writeup(ws) if report.markdown(ws) is not None else None
    out = []
    for sec in (doc or {}).get("sections") or []:
        for p in sec["paragraphs"]:
            text = " ".join(s["text"] for s in p["sentences"])
            out.append({"ref": f"report:{DOC}#{p['id']}", "id": p["id"], "heading": sec.get("heading") or "",
                        "sentences": [{"id": s["id"], "text": s["text"]} for s in p["sentences"]], "text": text,
                        "fp": hashlib.sha1(_collapse(text).encode()).hexdigest()[:16]})
    return out


def _comments_path(ws: str) -> Path:
    d = home.workspace_dir(ws) / "docs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{DOC}.comments.json"


def stored_comments(ws: str) -> list[dict[str, Any]]:
    got = home.read_json(_comments_path(ws), [])
    return got if isinstance(got, list) else []


def _save_comments(ws: str, comments: list[dict[str, Any]]) -> None:
    home.write_json(_comments_path(ws), comments)


def anchored(ws: str, doc: dict[str, Any]) -> list[dict[str, Any]]:
    """The open comments placed on the report as it stands: each on the sentence, or the paragraph, whose words it
    keeps; a comment whose words no passage holds any more is left out."""
    sents: dict[str, str] = {}
    by_text: dict[str, str] = {}
    paras: dict[str, str] = {}  # a paragraph's words -> its first sentence's id
    first_of: dict[str, str] = {}
    for sec in doc.get("sections") or []:
        for p in sec["paragraphs"]:
            if not p["sentences"]:
                continue
            for s in p["sentences"]:
                sents[s["id"]] = s["text"]
                by_text.setdefault(_collapse(s["text"]), s["id"])
            words = _collapse(" ".join(s["text"] for s in p["sentences"]))
            paras.setdefault(words, p["sentences"][0]["id"])
            first_of[p["id"]] = p["sentences"][0]["id"]
    out = []
    for c in stored_comments(ws):
        if c.get("status") != "open":
            continue
        quote = _collapse(c.get("quote"))
        sid = str(c.get("sentence_id") or "")
        if c.get("paragraph"):
            at = paras.get(quote) if quote else first_of.get(sid)
        elif quote:
            at = sid if _collapse(sents.get(sid)) == quote else by_text.get(quote)
        else:
            at = sid if sid in sents else None
        if at:
            out.append({**c, "sentence_id": at})
    return out


def decorate(ws: str, doc: dict[str, Any]) -> None:
    doc["comments"] = anchored(ws, doc)


LINK = re.compile(r"(?<!!)\[([^\[\]\n]*)\]\(([^()\s]+)\)")


def note_parts(text: str, details: str) -> tuple[str, str, str]:
    """(the statement as the analyst reads it, its details, the refs both cite): the statement's links flattened to
    their words."""
    refs = [m.group(2) for m in LINK.finditer(f"{text}\n{details}")]
    refs += re.findall(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", f"{text}\n{details}")
    shown = LINK.sub(lambda m: "" if m.group(1).strip() in ("", "↗") else m.group(1), text)
    shown = re.sub(r"\[\[(?:([^\]|]*)\|)?[^\]]+\]\]", lambda m: m.group(1) or "", shown)
    return _collapse(shown), str(details or "").strip(), " ".join(dict.fromkeys(refs))


def add_comment(ws: str, *, sentence_id: str, text: str, details: str = "", author: str, quote: str,
                paragraph: bool = False, check: str | None = None, run: str | None = None,
                evidence: str = "") -> dict[str, Any]:
    comments = stored_comments(ws)
    used = {c.get("id") for c in comments}
    cid = "c" + secrets.token_hex(4)
    while cid in used:
        cid = "c" + secrets.token_hex(4)
    c = {"id": cid, "sentence_id": sentence_id, **({"paragraph": True} if paragraph else {}), "text": text,
         "details": details, "author": author, "check": check, "run": run, "evidence": evidence, "quote": quote,
         "ts": _now(), "status": "open", "reply": None}
    comments.append(c)
    _save_comments(ws, comments)
    hub.publish(ws, {"type": "report", "slug": DOC, "status": "commented", "span": f"report:{DOC}#{sentence_id}"})
    return c


def resolve(ws: str, comment: str, resolution: str = "done") -> None:
    comments = stored_comments(ws)
    hit = next((c for c in comments if c.get("id") == comment), None)
    if hit is None:
        raise KeyError(comment)
    hit.update(status="resolved", resolution=resolution, resolved=_now())
    _save_comments(ws, comments)
    hub.publish(ws, {"type": "report", "slug": DOC, "status": "commented"})


# ---- runs

def _stream(ws: str, cid: str, status: str, run: str, chat: str) -> None:
    hub.publish(ws, {"type": "check", "id": cid, "doc": DOC, "status": status, "run": run, "chat": chat})


def _with_stale(ws: str, check: dict[str, Any]) -> None:
    rec = (check.get("runs") or {}).get(DOC)
    if not isinstance(rec, dict) or rec.get("status") == "running":
        return
    seen = set(rec.get("seen") or [])
    rec["stale"] = sum(1 for p in passages(ws) if p["fp"] not in seen) or None


def to_cover(ws: str, check: dict[str, Any], wanted: list[str] | None = None) -> list[dict[str, Any]]:
    ps = passages(ws)
    if wanted:
        ids = set()
        for w in wanted:
            m = REF.match(w.strip().strip("[]"))
            if m:
                pid = m.group(3) if m.group(2) == "p" else ".".join(m.group(3).split(".")[:2])
                ids.add(f"p{pid}")
        return [p for p in ps if p["id"] in ids]
    seen = set(((check.get("runs") or {}).get(DOC) or {}).get("seen") or [])
    return [p for p in ps if p["fp"] not in seen]


def task_text(ws: str, check: dict[str, Any], cover: list[dict[str, Any]]) -> str:
    doc = report.writeup(ws) or {}
    covered = {p["id"] for p in cover}
    lines = [f"Run the check \"{check['name']}\" over the report, report:{DOC}.", "", "## The check's instructions", "",
             check["prompt"], "", "## The passages to comment on", ""]
    lines += [f"- report:{DOC}#{p['id']} (its sentences: " + ", ".join(s["id"] for s in p["sentences"]) + ")"
              for p in cover]
    lines += ["", "Comment on a sentence as report:report#<t-id>, on a paragraph as report:report#<p-id>.", "",
              "## The report, with the id of every passage", "", f"# {doc.get('title') or ''}"]
    for sec in doc.get("sections") or []:
        if sec.get("heading"):
            lines += ["", f"## {sec['heading']}"]
        figs = {f.get("after_paragraph"): f for f in sec.get("figures") or []}
        for f in sec.get("figures") or []:
            if f.get("lead"):
                lines.append(f"[figure] card:{f['cell']}: {f.get('caption') or ''}")
        for p in sec["paragraphs"]:
            mark = "" if p["id"] in covered else " (not to comment on)"
            lines += ["", f"[{p['id']}]{mark}"]
            lines += [f"  [{s['id']}] {s['text']}" for s in p["sentences"]]
            f = figs.get(p["id"])
            if f:
                lines.append(f"[figure] card:{f['cell']}: {f.get('caption') or ''}")
    lines += ["", "## The cards", ""]
    for nb in canvas.notebooks(ws):
        lines.append(f"### {nb.get('title')}")
        lines += [f"- card:{c['id']} ({c['kind']}) {c['title']} | takeaway: {c.get('takeaway') or '(none)'}"
                  for c in nb["cells"]]
    chat = []
    for r in chats.records(ws, "main"):
        if r.get("type") == "user":
            chat.append(f"[analyst] {r.get('text')}")
        elif r.get("type") == "text":
            if chat and chat[-1].startswith("[claude] "):
                chat[-1] += r.get("delta") or ""
            else:
                chat.append("[claude] " + (r.get("delta") or ""))
    text = "\n".join(chat)
    lines += ["", "## The analyst's chat", "", (text[-CHAT_CHARS:] if text else "(empty)")]
    return "\n".join(lines)


def running_chat(ws: str, check: dict[str, Any], sessions: agent.Sessions) -> str | None:
    rec = (check.get("runs") or {}).get(DOC) or {}
    chat = rec.get("chat")
    return chat if rec.get("status") == "running" and chat in sessions.running(ws) else None


async def start_run(ws: str, sessions: agent.Sessions, cid: str, *, wanted: list[str] | None = None,
                    from_main: str | None = None) -> dict[str, Any] | None:
    """Start a run of check `cid` on the report, on the passages `wanted`, else those it has not seen; the run, or
    None when the report is not written, there is nothing to cover, or a run goes on already."""
    check = read(ws, cid)
    if check is None:
        raise KeyError(cid)
    if report.markdown(ws) is None or running_chat(ws, check, sessions):
        return None
    cover = to_cover(ws, check, wanted)
    if not cover:
        return None
    rid = "r" + secrets.token_hex(4)
    chat = "k" + secrets.token_hex(4)
    m = chats.new_meta(chat, kind="agent", title=check["name"], parent="main")
    m.update(role=ROLE, status="running", check=cid, run=rid, doc=DOC, brief=f"Run the check {check['name']}.")
    chats.save_meta(ws, m)
    old = (check.get("runs") or {}).get(DOC) or {}
    rec = {"run": rid, "status": "running", "chat": chat, "started": _now(), "ended": None,
           "covered": [p["ref"] for p in cover], "covered_fp": [p["fp"] for p in cover],
           "seen": list(old.get("seen") or []), "comments": 0, "summary": ""}
    check.setdefault("runs", {})[DOC] = rec
    save(ws, check)
    if from_main:
        chats.append(ws, "main", {"type": "agent", "chat": chat, "role": ROLE, "title": check["name"],
                                  "tool_use_id": from_main})
    await sessions.get(ws, chat).send(task_text(ws, check, cover), shown=f"Run the check {check['name']} on the "
                                      f"report: {len(cover)} passage{'s' if len(cover) != 1 else ''}.")
    _stream(ws, cid, "running", rid, chat)
    return rec


def _run_finished(session: agent.Session, result: str | None) -> None:
    ws, chat = session.ws, session.chat
    status = {None: "done", "stopped": "stopped"}.get(result, "failed")
    m = chats.meta(ws, chat)
    m.update(status=status, ts_end=_now())
    if status == "stopped":
        m["stopped_by"] = "analyst"
    chats.save_meta(ws, m)
    check = read(ws, str(m.get("check")))
    if check is None:
        return
    rec = (check.get("runs") or {}).get(DOC)
    if not isinstance(rec, dict) or rec.get("run") != m.get("run"):
        return
    summary = ""
    for msg in reversed(agent.load_messages(ws, chat)):
        if msg.get("role") == "assistant":
            summary = "".join(b.get("text", "") for b in msg.get("content") or [] if b.get("type") == "text").strip()
            if summary:
                break
    rec.update(status=status, ended=_now(), summary=summary[:500])
    if status == "done":
        covered = set(rec.get("covered") or [])
        rec["seen"] = list(dict.fromkeys([*(rec.get("seen") or []), *(rec.get("covered_fp") or [])]))
        # the check's earlier comments on the passages this run covered give way to this run's
        comments = stored_comments(ws)
        ps = {p["id"]: p for p in passages(ws)}
        for c in comments:
            if c.get("check") == check["id"] and c.get("run") != rec["run"] and c.get("status") == "open":
                pid = "p" + ".".join(str(c.get("sentence_id") or "")[1:].split(".")[:2])
                if f"report:{DOC}#{pid}" in covered and pid in ps:
                    c.update(status="resolved", resolution="superseded", resolved=_now())
        _save_comments(ws, comments)
    save(ws, check)
    _stream(ws, check["id"], status, rec["run"], chat)
    hub.publish(ws, {"type": "report", "slug": DOC, "status": "commented"})


async def stop_runs(ws: str, sessions: agent.Sessions, cid: str) -> None:
    check = read(ws, cid)
    chat = running_chat(ws, check, sessions) if check else None
    if chat:
        await sessions.get(ws, chat).interrupt()
    elif check:
        rec = (check.get("runs") or {}).get(DOC)
        if isinstance(rec, dict) and rec.get("status") == "running":
            rec.update(status="stopped", ended=_now())
            save(ws, check)
            _stream(ws, cid, "stopped", str(rec.get("run")), str(rec.get("chat")))


def _writer_ended(session: agent.Session, result: str | None) -> None:
    """The writer saved the report: each check that is on runs on the passages it has not seen."""
    if result is not None or not auto() or session.manager is None:
        return
    loop = asyncio.get_running_loop()
    for c in list_checks(session.ws):
        if c.get("shown"):
            loop.create_task(_quietly(start_run(session.ws, session.manager, c["id"])))


async def _quietly(coro: Any) -> None:
    try:
        await coro
    except Exception:  # noqa: BLE001
        log.exception("a check's run did not start")


# ---- tools

async def t_add_comment(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    meta = s.meta if s is not None else {}
    if s is None or s.role != ROLE:
        return tools.Result("add_comment comments only in a check's run", True)
    check = read(t.ws, str(meta.get("check")))
    rec = ((check or {}).get("runs") or {}).get(DOC) or {}
    ref = str(args.get("ref") or "").strip().strip("[]")
    m = REF.match(ref)
    if not m or m.group(1) != DOC:
        return tools.Result(f"no passage {ref}: name one as report:report#t<id> or report:report#p<id>", True)
    whole = m.group(2) == "p"
    pid = "p" + (m.group(3) if whole else ".".join(m.group(3).split(".")[:2]))
    p = next((x for x in passages(t.ws) if x["id"] == pid), None)
    if p is None or (not whole and not any(x["id"] == "t" + m.group(3) for x in p["sentences"])):
        return tools.Result(f"no passage {ref} in the report as it stands", True)
    if p["ref"] not in set(rec.get("covered") or []):
        return tools.Result(f"{ref} is not among the passages this run covers", True)
    text, details, evidence = note_parts(str(args.get("text") or ""), str(args.get("details") or ""))
    if not text:
        return tools.Result("add_comment: `text` is empty", True)
    sid = p["sentences"][0]["id"] if whole else "t" + m.group(3)
    quote = p["text"] if whole else next(x["text"] for x in p["sentences"] if x["id"] == sid)
    add_comment(t.ws, sentence_id=sid, text=text, details=details, author="check", quote=quote, paragraph=whole,
                check=check["id"] if check else None, run=rec.get("run"), evidence=evidence)
    if check is not None and rec.get("run") == meta.get("run"):
        rec["comments"] = int(rec.get("comments") or 0) + 1
        save(t.ws, check)
    return tools.Result(f"commented on {ref}")


async def t_run_check(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    if s is None or s.manager is None:
        return tools.Result("this agent cannot run a check", True)
    name = _collapse(args.get("name"))
    instructions = str(args.get("instructions") or "").strip()
    check = by_name(t.ws, name)
    try:
        if check is None:
            if not instructions:
                names = ", ".join(c["name"] for c in list_checks(t.ws))
                return tools.Result(f"There is no check named {name!r}: give `instructions` to make it, or run one of "
                                    f"{names}.", True)
            check = create(t.ws, name, instructions, created_by="main")
        check = edit(t.ws, check["id"], prompt=instructions or None, shown=True)
    except (ValueError, FileExistsError) as e:
        return tools.Result(str(e), True)
    if report.markdown(t.ws) is None:
        return tools.Result(f"The check {check['name']} is on. The report is not written yet, so it runs once the "
                            "writer saves it.")
    rec = await start_run(t.ws, s.manager, check["id"], wanted=list(args.get("passages") or []) or None,
                          from_main=None)
    if rec is None:
        return tools.Result(f"The check {check['name']} is on, and nothing ran: it has checked every passage as it "
                            "stands, or a run of it goes on.")
    return tools.Result(f"The check {check['name']} runs on {len(rec['covered'])} passages of the report; thimble shows "
                        "its comments beside the report as it leaves them.")


async def t_stop_check(t: tools.Tools, args: dict[str, Any]) -> tools.Result:
    s = t.session
    check = by_name(t.ws, str(args.get("name") or ""))
    if check is None:
        return tools.Result(f"There is no check named {args.get('name')!r}.", True)
    edit(t.ws, check["id"], shown=False)
    if s is not None and s.manager is not None:
        await stop_runs(t.ws, s.manager, check["id"])
    return tools.Result(f"The check {check['name']} is off; its comments are kept.")


def _check_prompt(folder: Path) -> str:
    return prompts.render("browser/check.md", {"workdir": str(folder)})


AGENTS[ROLE] = AgentDef(_check_prompt, CHECK_TOOLS, finished=_run_finished)
tools.register("add_comment", t_add_comment)
tools.register("run_check", t_run_check)
tools.register("stop_check", t_stop_check)
if decorate not in report.DECORATE:
    report.DECORATE.append(decorate)


def register(ctx: Any) -> None:
    main = AGENTS["main"]
    main.tools = main.tools + tuple(n for n in MAIN_TOOLS if n not in main.tools)
    writer = AGENTS["writer"]
    if not getattr(writer.finished, "runs_checks", False):
        prev = writer.finished

        def finished(session: agent.Session, result: str | None) -> None:
            if prev is not None:
                prev(session, result)
            _writer_ended(session, result)
        finished.runs_checks = True  # type: ignore[attr-defined]
        writer.finished = finished
    app, sessions = ctx.app, ctx.sessions

    def doc_of(slug: str) -> str:
        if slug != DOC:
            raise HTTPException(404, f"thimble browser has one document, the report, not {slug!r}")
        return slug

    @app.get("/api/ws/{c}/checks")
    def checks_list(c: str) -> list[dict[str, Any]]:
        ctx.ws_of(c)
        return list_checks(c)

    @app.get("/api/ws/{c}/checks/settings")
    def checks_settings(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        return {"auto": auto()}

    @app.put("/api/ws/{c}/checks/settings")
    def checks_settings_set(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        if "auto" in body:
            set_auto(bool(body["auto"]))
        return {"auto": auto()}

    @app.post("/api/ws/{c}/checks", status_code=201)
    async def checks_create(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        try:
            check = create(c, str(body.get("name") or ""), str(body.get("prompt") or ""), created_by="analyst")
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        except FileExistsError as e:
            raise HTTPException(409, str(e)) from None
        await start_run(c, sessions, check["id"])
        return read(c, check["id"]) or check

    @app.patch("/api/ws/{c}/checks/{cid}")
    async def checks_edit(c: str, cid: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        before = read(c, cid)
        if before is None:
            raise HTTPException(404, f"no check {cid!r}")
        check = edit(c, cid, name=body.get("name"), prompt=body.get("prompt"), colour=body.get("colour"),
                     shown=body.get("shown"))
        if body.get("shown") is False:
            await stop_runs(c, sessions, cid)
        elif check.get("shown") and (body.get("shown") is True or check.get("version") != before.get("version")):
            await start_run(c, sessions, cid)
        got = read(c, cid) or check
        _with_stale(c, got)
        return got

    @app.post("/api/ws/{c}/checks/{cid}/run", status_code=202)
    async def checks_run(c: str, cid: str, body: dict = Body(default={})) -> dict[str, Any]:
        ctx.ws_of(c)
        doc_of(str(body.get("doc") or DOC).removeprefix("report:"))
        if read(c, cid) is None:
            raise HTTPException(404, f"no check {cid!r}")
        rec = await start_run(c, sessions, cid, wanted=list(body.get("passages") or []) or None)
        if rec is None:
            raise HTTPException(409, "the report has no passage to check: it is not written, the check has seen "
                                     "every passage as it stands, or a run of it goes on")
        return rec

    @app.post("/api/ws/{c}/checks/{cid}/runs/{doc}/stop")
    async def checks_stop(c: str, cid: str, doc: str) -> dict[str, Any]:
        ctx.ws_of(c)
        if read(c, cid) is None:
            raise HTTPException(404, f"no check {cid!r}")
        await stop_runs(c, sessions, cid)
        return read(c, cid) or {}

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/comments")
    def comment_add(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        doc_of(slug)
        sid = str(body.get("sentence_id") or "")
        text = str(body.get("text") or "").strip()
        doc = report.writeup(c) or {}
        quote = next((s["text"] for sec in doc.get("sections") or [] for p in sec["paragraphs"]
                      for s in p["sentences"] if s["id"] == sid), None)
        if quote is None or not text:
            raise HTTPException(400, "a comment needs a sentence of the report and its text")
        return add_comment(c, sentence_id=sid, text=text, author="analyst", quote=quote)

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/comments/{comment}/dismiss")
    def comment_dismiss(c: str, slug: str, comment: str) -> dict[str, Any]:
        ctx.ws_of(c)
        doc_of(slug)
        try:
            resolve(c, comment)
        except KeyError:
            raise HTTPException(404, f"no comment {comment!r}") from None
        return report.writeup(c) or {}
