"""Share on a fix in the browser: a fix as a public GitHub issue that the analyst checks and submits themselves, as s in
the terminal's Your fixes does (plugin/fix/share.ts).

    POST /api/fixes/{fid}/share       Claude writes the title, what was wrong and how it was fixed (the plugin's
                                      prompts/fix-draft.md, on the dev row's model of Settings); then the kernel's
                                      `thimble fix share ID` (plugin/engine/kernel/share.py) takes the analyst's names and
                                      values out of it and gives GitHub's new-issue link with the text, and what it took out

The analyst opens the link in their own tab, reads the text on GitHub's page and presses Submit there. Nothing
is sent from here at any point. The fixes are the plugin's (its home, THIMBLE_PLUGIN_HOME or ~/.thimble), so a fix made
in the terminal shares from here too. When Claude writes no text, the kernel uses the text an earlier share had, else the
analyst's words and what the fixer said, and the answer says why.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config

router = APIRouter()

PLUGIN_HOME_ENV = "THIMBLE_PLUGIN_HOME"


def plugin_home() -> Path:
    return Path(os.environ.get(PLUGIN_HOME_ENV) or os.path.expanduser("~/.thimble"))


def plugin_dir() -> Path:
    """The terminal plugin of the tree this server runs from (the repository's plugin/, beside browser/)."""
    return config.REPO_ROOT.parent / "plugin"


def kernel(args: list[str], *, stdin: str | None = None, timeout: float = 120) -> tuple[bool, str, str]:
    """`thimble fix ARGS` as the analyst's own command, in the plugin's home: (ok, stdout, the error's last line)."""
    env = {**config.passed_environ(), "THIMBLE_HOME": str(plugin_home()), "THIMBLE_SESSION": "person-browser",
           "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("THIMBLE_ROOT", None)
    try:
        p = subprocess.run([sys.executable, "-I", str(plugin_dir() / "engine" / "thimble.py"), "fix", *args],
                           input=stdin if stdin is not None else "", capture_output=True, text=True, timeout=timeout,
                           env=env, cwd=str(Path.home()))
    except subprocess.TimeoutExpired:
        return False, "", f"thimble fix {args[0]} took longer than {int(timeout)} s"
    except OSError as e:
        return False, "", f"thimble fix could not run: {e}"
    lines = (p.stderr or "").strip().splitlines()
    return p.returncode == 0, p.stdout, re.sub(r"^thimble fix \w+: ", "", lines[-1] if lines else "")


def _prompt(rec: dict[str, Any], diff: str) -> str:
    """What the drafting call reads, as the terminal's (plugin/fix/share.ts drafted)."""
    files = "; ".join(f"{f['path']} +{f.get('add') or 0} −{f.get('del') or 0}" for f in rec.get("files") or [])
    return "\n".join([
        "The person's words, each round:", *[f'<round n="{i + 1}">{w}</round>' for i, w in enumerate(rec.get("words") or [])], "",
        f"What the fix does, as its author said it: {rec.get('summary') or '(nothing said)'}", "",
        f"Files: {files or 'none (a request with no code)'}",
        f"Tests: {rec.get('tests') or 'not run'}", "",
        "The change:", "<diff>", diff[:24000], "</diff>",
    ])


def _json_in(text: str) -> dict[str, Any]:
    m = re.search(r"\{[\s\S]*\}", text or "")
    if m:
        with contextlib.suppress(ValueError):
            got = json.loads(m.group(0))
            return got if isinstance(got, dict) else {}
    return {}


async def drafted(c: str | None, rec: dict[str, Any]) -> dict[str, str] | str:
    """Claude's title, wrong and fixed for one fix, in one model call; a string is why there is none."""
    from . import runtime  # noqa: PLC0415

    try:
        role = config.call_settings(c, "dev")
        system = (plugin_dir() / "prompts" / "fix-draft.md").read_text("utf-8")
        diff = ""
        if rec.get("commit"):
            ok, out, _ = await asyncio.to_thread(kernel, ["diff", str(rec["id"])], timeout=30)
            diff = out if ok else ""
        prompt = _prompt(rec, diff)
        if runtime.uses_api():
            from . import llm  # noqa: PLC0415

            client = await asyncio.to_thread(llm.client)
            msg = await client.messages.create(model=role["model"], max_tokens=2000, system=system,
                                               messages=[{"role": "user", "content": prompt}])
            got = _json_in("".join(getattr(b, "text", "") for b in msg.content))
        else:
            from . import model  # noqa: PLC0415

            spec = model.ToolSpec("issue", "The issue's title, what was wrong, and how it was fixed.", {
                "type": "object", "required": ["title", "wrong", "fixed"],
                "properties": {"title": {"type": "string"}, "wrong": {"type": "string"}, "fixed": {"type": "string"}}})
            res = await model.structured(prompt, tool=spec, model=role["model"], effort=role["effort"], speed=role["speed"],
                                         refusal=role["refusal"], system=system, cwd=str(plugin_home()))
            if res.status != "ok":
                return f"Claude did not write the text ({res.status})"
            got = res.output or {}
    except Exception as e:  # noqa: BLE001 - any failure of the call: the page still opens, with the fix's own words
        return f"Claude did not write the text: {str(e)[:200]}"
    title = " ".join(str(got.get("title") or "").split())[:72]
    if not title:
        return "Claude wrote no title"
    return {"title": title, "wrong": str(got.get("wrong") or "").strip(), "fixed": str(got.get("fixed") or "").strip()}


class ShareBody(BaseModel):
    ws: str | None = None  # the workspace whose Settings name the model


@router.post("/fixes/{fid}/share")
async def share_route(fid: int, http: Request, body: ShareBody | None = None) -> dict[str, Any]:
    """The analyst's Share: Claude's text, then the kernel's GitHub link, which the page opens in a tab.
    The analyst's click alone: the server's token, which Claude's tools hold, is not enough."""
    from . import subagents  # noqa: PLC0415

    subagents.analyst_only(http)
    ok, out, err = await asyncio.to_thread(kernel, ["show", str(fid), "--json"], timeout=30)
    if not ok:
        raise HTTPException(404, err or f"there is no fix {fid}")
    rec = json.loads(out)
    d = await drafted(body.ws if body else None, rec)
    args = ["share", str(fid), "--json", *([] if isinstance(d, str) else ["--draft", "-"])]
    ok, out, err = await asyncio.to_thread(kernel, args, stdin=None if isinstance(d, str) else json.dumps(d), timeout=180)
    if not ok:
        raise HTTPException(409, err or "thimble fix share gave nothing")
    r = json.loads(out)
    return {**{k: r.get(k) for k in ("id", "title", "took", "url", "shortened", "text")},
            "note": d if isinstance(d, str) else ""}
