"""No agent thimble starts leaves anything in the corpus folder. thimble's own agents are subagents of main, which run in
main's permission mode and write in work folders outside the corpus (subagents.write_dirs). The card and label kernels
need no model and run wherever their sandbox runs."""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from app import (checks, config, critique_session, dev, kernel_wrap, notebook,
                 orient_session, srt, write_session)

CORPUS = "copy"
LIVE = os.environ.get("THIMBLE_LIVE_CLAUDE") == "1"
REAL_CLAUDE = shutil.which("claude")  # read at import, before the suite's stand-in goes first on PATH
LIVE_MODEL = os.environ.get("THIMBLE_LIVE_MODEL") or "claude-haiku-4-5"
LIVE_TIMEOUT_S = 300


@pytest.fixture()
def corpus(tmp_path, monkeypatch, mini_dir) -> Path:
    """A copy of the `mini` corpus under the name CORPUS."""
    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / CORPUS)
    (data / CORPUS / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    yield (data / CORPUS).resolve()


def snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every entry under `root`, hidden ones included: its size and modification time, 0 and 0 for a folder."""
    out: dict[str, tuple[int, int]] = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        out[str(path.relative_to(root))] = (0, 0) if path.is_dir() else (st.st_size, st.st_mtime_ns)
    return out


def test_every_agent_s_work_folder_lies_outside_the_corpus(corpus):
    """The work folder of every kind of agent, and every folder main's Bash may write, lies outside the corpus folder."""
    from app import subagents

    for folder in subagents.write_dirs(CORPUS):
        assert not folder.resolve().is_relative_to(corpus), folder
    folders = {"orientation": orient_session.work_dir(CORPUS), "critic": critique_session.work_dir(CORPUS, "c1"),
               "writer": write_session.work_dir(CORPUS, "report"), "check": checks.work_dir(CORPUS, "k1", "report"),
               "view build": dev.view_work_dir(CORPUS, "posts")}
    for kind, folder in folders.items():
        assert not folder.resolve().is_relative_to(corpus), kind


def _kernel_wraps() -> str:
    """The kernel's sandbox where one runs here, else ''."""
    node, package = srt.node(), srt.package(config.REPO_ROOT)
    if node and package and kernel_wrap.srt_works(node, package):
        return config.KERNEL_WRAP_SRT
    return config.KERNEL_WRAP_BWRAP if sys.platform == "linux" and kernel_wrap.works() else ""


async def test_card_and_label_code_that_runs_shell_commands_in_the_corpus_leaves_it_as_it_was(corpus, monkeypatch):
    wrap = _kernel_wraps()
    if not wrap:
        pytest.skip("no kernel sandbox runs here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)
    before = snapshot(corpus)
    code = (f"import os, subprocess\nos.chdir({str(corpus)!r})\n"
            f"print(subprocess.run('cd agents && ls | head -2; ls -a', shell=True, capture_output=True, text=True).stdout)")
    try:
        cell = await notebook.run_code(CORPUS, code, "main")
        said = "".join(b.get("text/plain", "") or b.get("text", "") for b in cell["outputs"])
        assert "agent-01.jsonl" in said, cell["outputs"]
        outputs, _n, _err = await notebook.execute_on(CORPUS, "labels", code)
        assert "agent-01.jsonl" in json.dumps(outputs), outputs
    finally:
        await notebook.shutdown_all()
    assert snapshot(corpus) == before, sorted(set(snapshot(corpus)) ^ set(before))
