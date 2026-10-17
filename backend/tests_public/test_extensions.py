"""app.extensions: `thimble extension add` lists each contribution of an extension and copies it into thimble's home
once the analyst says yes; from then on it runs in every workspace until it is removed or switched off, and only its
views check whether they fit a corpus. The fixture extension ext-min gives one of each contribution: a view that is
also a card type, a card-only type, an agent, a report type and orientation instructions. Reader calls run in this
process, and the quick model call that checks whether a view fits answers from `fit`."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
from pathlib import Path

import pytest


from app import (call_result, cardtypes, config, extensions, orient_session,
                 prompts, report_types, view_fit, views)

FIXTURE = Path(__file__).parent / "fixtures" / "ext-min"
CORPUS = "tallies"


@pytest.fixture()
def corpus(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data" / CORPUS
    (d / "tally").mkdir(parents=True)
    rows = [{"who": w, "what": f"task {i}"} for i, w in enumerate(["ana", "bo", "ana", "cy"])]
    (d / "tally" / "a.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "tallies"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    return d.resolve()


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


@pytest.fixture(autouse=True)
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._memo.clear()
    views._ready.clear()


@pytest.fixture(autouse=True)
def fit(monkeypatch) -> dict:
    """The check on whether a view fits, in place: it answers `answer`, and keeps the prompts it got in `asked`."""
    got: dict = {"asked": [], "answer": {"status": "ok", "output": {"fits": True, "reason": "Each record says who did a task."}}}

    async def ask(c: str, text: str, **_kw) -> call_result.CallResult:
        got["asked"].append(text)
        return call_result.CallResult(**got["answer"])

    monkeypatch.setattr(view_fit, "ask", ask)
    return got


def _add(src: Path = FIXTURE) -> str:
    names = extensions.add(str(src), yes=True, say=lambda _: None)
    assert names is not None
    return names[0]


def _copy(tmp_path: Path, name: str, **manifest) -> Path:
    d = tmp_path / name
    shutil.copytree(FIXTURE, d)
    raw = json.loads((d / "extension.json").read_text())
    raw.update(name=name, **manifest)
    (d / "extension.json").write_text(json.dumps(raw))
    return d


def test_add_lists_each_contribution_with_its_own_description_and_adds_nothing_without_a_yes():
    said: list[str] = []
    assert extensions.add(str(FIXTURE), ask=lambda _: "n", say=said.append) is None
    assert not extensions.source_path("ext-min").exists()
    text = "\n".join(said)
    for part in ("ext-min 0.1.0", "view        tally: Each record of the tally files, counted by who made it. Also a card type.",
                 "card type   tally-bars: The records of one person as bars.",
                 "agent       counter: Counts the tally records of the places it is given.",
                 "orientation Tally-aware orientation. It adds to the orientation's instructions.",
                 "report type digest: A one-page digest of the tally.", "It works with thimble >=0.4.",
                 "thimble's kernels"):
        assert part in text
    assert f"ext-min 0.1.0, used in place from {FIXTURE.resolve()}" in said
    assert extensions.add(str(FIXTURE), ask=lambda _: "y", say=said.append) == ["ext-min"]
    assert extensions.linked("ext-min"), "a local folder is used in place"
    assert (extensions.source_path("ext-min") / "views" / "tally" / "reader.py").is_file()
    assert json.loads(extensions._record_file("ext-min").read_text())["kind"] == "folder"
    assert not (FIXTURE / extensions.ADDED).exists(), "thimble writes nothing into a folder used in place"
    assert extensions.remove("ext-min") and not extensions.source_path("ext-min").exists()
    assert (FIXTURE / "extension.json").is_file(), "removing it leaves the folder"
    assert not extensions.remove("ext-min")


async def test_an_added_extension_runs_in_every_workspace_and_its_view_where_it_fits(corpus, fit):
    _add()
    state = await extensions.refresh(CORPUS, wait=10)
    e = state["extensions"]["ext-min"]
    assert e["active"] and e["why"] == ""
    assert (extensions.workspace_path(CORPUS, "ext-min") / "views" / "tally" / "card.py").is_file()
    assert len(fit["asked"]) == 1 and "Each record of the tally files, counted by who made it." in fit["asked"][0]
    assert "tally/a.jsonl  " in fit["asked"][0] and '"who": "ana"' in fit["asked"][0]

    prop = views.read_proposal(CORPUS, "tally")
    assert prop["extension"] == "ext-min" and prop["orientation"] is False, "never an orientation's proposal"
    assert views.read_built(CORPUS, "tally")["ok"]
    row = extensions.public(CORPUS)["extensions"][0]
    assert row["views"] == [{"slug": "tally", "name": "Tally", "shown": True, "note": "Each record says who did a task.",
                             "on": True, "locked": False}]

    types = await cardtypes.refresh(CORPUS, warm=False)
    assert {"tally", "tally-bars"} <= set(types)
    bars = types["tally-bars"]
    assert bars["origin"] == "extension" and bars["page"] == "card.html" and bars["reader"].endswith("tally/reader.py")
    assert Path(bars["reader"]).is_relative_to(config.workspace_dir(CORPUS)), "a card's kernel sees only the workspace"
    text = cardtypes.prompt_text(CORPUS)
    assert "- `tally-bars`: The records of one person as bars." in text and "use `tally` to compare people" in text
    assert "thimble.onInit" in cardtypes.frame_document(CORPUS, "tally-bars")

    assert [r["id"] for r in extensions.report_types(CORPUS)] == ["digest"]
    assert "digest" in [p["id"] for p in report_types.presets(CORPUS)], "+ New offers the extension's report type"
    assert report_types.create_document_type(CORPUS, "digest")["preset"] == "digest"

    agents = extensions.agent_definitions(CORPUS)
    assert set(agents) == {"counter"}, "agents/orient.md is no agent"
    assert agents["counter"]["tools"] == ["Read", "Grep"] and "WebFetch" in agents["counter"]["disallowedTools"]
    assert agents["counter"]["model"] == "sonnet"

    default = prompts.render(orient_session.INSTRUCTIONS, {}).strip()
    instructions = orient_session.instructions_of(CORPUS)
    assert instructions == f"{default}\n\n#### ext-min\n\nRead every tally record in `tally/*.jsonl` before you draft."
    assert orient_session.instructions_of(CORPUS, "My own way.").startswith("My own way."), "the analyst's setting wins"


async def test_the_server_neither_writes_nor_serves_through_a_symlink_a_kernel_leaves(corpus, tmp_path):
    """A kernel writes the workspace, so a symlink it leaves where the server copies a file is replaced rather than
    written through, and a card type's page is read from the extension's folder in thimble's home."""
    secret = tmp_path / "outside" / "secret.txt"
    secret.parent.mkdir()
    secret.write_text("KEEP")
    _add()
    await extensions.refresh(CORPUS, wait=10)
    await cardtypes.refresh(CORPUS, warm=False)
    host = cardtypes.types_dir(CORPUS) / cardtypes.HOST_FILE
    host.unlink()
    host.symlink_to(secret)
    t = (await cardtypes.refresh(CORPUS, warm=False))["tally-bars"]
    assert secret.read_text() == "KEEP" and not host.is_symlink()
    page = Path(t["dir"]) / "card.html"
    page.unlink()
    page.symlink_to(secret)
    assert "KEEP" not in cardtypes.frame_document(CORPUS, "tally-bars")

    inv = config.workspace_dir(CORPUS) / "investigations" / "main"
    inv.mkdir(parents=True, exist_ok=True)
    (inv / "video.json").write_text("{}")
    d = report_types.types_dir(CORPUS) / "video"
    d.mkdir(parents=True)
    (d / "prompt.md").symlink_to(secret)
    report_types.list_types(CORPUS)
    assert secret.read_text() == "KEEP" and not (d / "prompt.md").is_symlink()


async def test_a_folder_used_in_place_cannot_link_to_files_outside_it(corpus, tmp_path, monkeypatch):
    """thimble reads a folder used in place where it is, so a link in it that leads outside it (here to the file that
    holds thimble's local API token) is a problem: add refuses the folder, and a link made after the add unloads it,
    so the file never reaches the orientation's prompt."""
    monkeypatch.setattr(orient_session, "send", lambda *a, **k: pytest.fail("nothing is sent"))
    secret = extensions.home() / "server.json"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('{"token": "not-for-agents"}')
    d = _copy(tmp_path, "linky")
    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").symlink_to(secret)
    with pytest.raises(extensions.AddError) as got:
        extensions.add(str(d), yes=True, say=lambda _: None)
    assert "agents/orient.md  is a link to a file outside the extension's folder" in str(got.value)
    assert "linky" not in extensions.added()

    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").write_text("Read every tally record.\n")
    (d / "views" / "tally" / "notes.md").symlink_to(d / "agents" / "orient.md")
    _add(d)
    assert (await extensions.refresh(CORPUS))["extensions"]["linky"]["active"], "a link inside the folder is fine"
    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").symlink_to(secret)
    e = (await extensions.refresh(CORPUS))["extensions"]["linky"]
    assert not e["active"] and "is a link to a file outside" in e["why"]
    assert "not-for-agents" not in json.dumps(extensions.orient_blocks(CORPUS))
    assert not extensions._own_file(d, "agents/orient.md")


def test_add_refuses_a_folder_in_thimble_s_own_folders(corpus, tmp_path):
    """Adding a folder uses it in place and first takes out what thimble held under that name, so one of thimble's own
    copies (in its extensions folder, or a workspace's) is refused and left as it was. So is any other folder of a
    workspace, which thimble's agents and kernels write, such as the workspace's own extension."""
    _add(_copy(tmp_path, "kept"))
    extensions.remove("kept")
    copy = extensions.extensions_dir() / "kept"
    shutil.copytree(tmp_path / "kept", copy)
    with pytest.raises(extensions.AddError, match="is in thimble's own folders"):
        extensions.add(str(copy), yes=True, say=lambda _: None)
    assert (copy / "extension.json").is_file() and not copy.is_symlink()
    for rel in (f"{extensions.WS_DIR}/kept", "extension"):
        inside = config.workspace_dir(CORPUS) / rel
        shutil.copytree(tmp_path / "kept", inside)
        with pytest.raises(extensions.AddError, match="is in thimble's own folders"):
            extensions.add(str(inside), yes=True, say=lambda _: None)
        assert (inside / "extension.json").is_file()
    assert not extensions.linked("kept")


async def test_the_add_question_and_settings_name_what_runs_outside_the_sandbox(corpus, tmp_path, monkeypatch):
    """An agent's MCP servers start outside the sandbox, so the add question lists each with its command, and Settings
    says so beside the agent. Whether the extension's code runs in a sandbox is the kernels' wrapper's to say."""
    d = _copy(tmp_path, "servers")
    body = (d / "agents" / "counter.md").read_text()
    (d / "agents" / "counter.md").write_text(body.replace("---\n", "---\nmcpServers:\n  db:\n    command: node\n"
                                                                  "    args: [db.js]\n", 1))
    said: list[str] = []
    extensions.add(str(d), yes=True, say=said.append)
    assert "It starts MCP servers outside the sandbox: db (node db.js)." in "\n".join(said)
    await extensions.refresh(CORPUS)
    assert extensions.agent_definitions(CORPUS)["counter"]["mcpServers"] == {"db": {"command": "node", "args": ["db.js"]}}
    monkeypatch.setattr(extensions, "kernels_wrapped", lambda c: False)
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "servers")
    assert "counter: network, no web, MCP servers outside the sandbox." in row["consent"]
    assert row["sandboxed"] is False
    monkeypatch.setattr(extensions, "kernels_wrapped", lambda c: True)
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "servers")
    assert row["sandboxed"] is True


def test_a_view_fit_that_failed_for_want_of_a_session_is_asked_again_once_one_runs(monkeypatch):
    """A decision that failed because no Claude Code session ran thimble here (view_fit.decide's `no_session`) stands
    while none runs, and is asked again at the next refresh once one does; another failure stands RETRY_S."""
    from datetime import datetime, timezone

    from app import module_bridge

    failed = {"key": "k", "error": "no Claude Code session runs thimble in this folder", "no_session": True,
              "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    monkeypatch.setattr(module_bridge, "live", lambda c: False)
    assert not extensions._stale(failed, "mini")
    monkeypatch.setattr(module_bridge, "live", lambda c: True)
    assert extensions._stale(failed, "mini") and not extensions._stale({**failed, "no_session": False}, "mini")
