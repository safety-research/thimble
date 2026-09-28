"""A view ticket's build session (app/dev.py) may read the corpus but not change it."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI

from app import config, dev, ledger, views

CORPUS = "boards"
READER = '''
import json


def build_index(paths):
    return {"lines": {f"{p}#L{n}": json.loads(line)["body"] for p in paths for n, line in enumerate(open(p), 1)}}


def records(index, query):
    return [{"ref": r, "body": b} for r, b in index["lines"].items()]


def resolve(index, locator):
    ref = f"{locator.get('path')}#{locator.get('fragment')}"
    body = index["lines"].get(ref)
    return None if body is None else {"excerpt": body, "label": "a post", "refs": [ref], "key": None, "target": {"ref": ref}}
'''
HTML = """<!doctype html><html><body><div id="out"></div><script>
thimble.onOpen(async () => { document.getElementById('out').textContent = JSON.stringify(await thimble.fetch({})) })
</script></body></html>"""


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


def test_a_view_build_s_session_may_read_the_corpus_but_not_change_it(board, monkeypatch):
    """The session runs in the corpus folder with Edit and Bash allowed, so its flags deny edits in the corpus and in
    the worked examples, and put Bash in the sandbox with no network where it can run, beside the dev role's fast
    mode, with its check command the one command run outside the sandbox; the prompt names that same command. A code
    ticket's session, in its own worktree, gets none of it."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: {"dev": {"model": "claude-opus-4-8", "fast": True}})
    corpus = config.corpus_dir(CORPUS)
    folder = views.views_dir(CORPUS) / "posts"
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder))
    settings = json.loads(flags[flags.index("--settings") + 1])
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)", f"Edit(/{views.EXAMPLES_DIR}/**)"]
    box = settings["sandbox"]
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    check = dev.view_check_command(CORPUS, "posts")
    assert box["excludedCommands"] == [check, f"{check} *"] and check.endswith(f"/api/ws/{CORPUS}/views/posts/check")
    assert settings["fastMode"] is True and "Read" in flags[flags.index("--allowedTools") + 1].split(",")
    prompt = dev.build_view_prompt(CORPUS, {"slug": "posts", "name": "Posts", "claims": ["board.jsonl"]}, folder, corpus)
    assert f"`{check} '<ref>'`" in prompt and "curl" not in prompt
    code = dev.Sessions()._flags(CORPUS, "thimble ticket 1: x")
    assert json.loads(code[code.index("--settings") + 1]) == {"fastMode": True}, "a code ticket is not fenced"
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert "sandbox" not in dev.read_only_fence([corpus]), "no sandbox where it cannot run; the deny stays"
    inside = corpus / ".thimble" / "views" / "posts"
    assert dev.view_read_only(corpus, inside) == (views.EXAMPLES_DIR,), "a corpus that holds the view's folder is left out"


def _app() -> FastAPI:
    a = FastAPI()
    a.include_router(views.router, prefix="/api")
    a.include_router(ledger.router, prefix="/api")
    return a
