"""The names of the Claude Code sessions thimble starts (config.session_name): `thimble:<role> · <workspace>`, since
`claude agents` lists the sessions of every folder; a long name kept short and distinct. (0.9.0's `thimble` command is
`claude` itself and names main's session no more: test_launch.py.) The statusline and /thimble:agents name thimble's
agents by what they do (tray.py)."""
from __future__ import annotations

from pathlib import Path

from app import tray, config, dev

CORPUS = "mini"


def test_names_carry_the_workspace():
    assert config.session_name("main", "logs-2") == "thimble:main · logs-2"
    assert config.session_name("dev", None) == "thimble:dev", "a ticket of no workspace"
    assert dev.dev_session_name(CORPUS) == "thimble:dev · mini"
    assert dev.view_session_name(CORPUS, "board") == "thimble:view-board · mini"


def test_a_long_name_stays_within_the_limit_and_distinct():
    name = config.session_name("view-" + "x" * 200, "field-logs")
    assert len(name) == config.SESSION_NAME_MAX and name.endswith(" · field-logs"), "the role gives way to a short workspace"
    assert name != config.session_name("view-" + "x" * 199, "field-logs")
    ws = "b" * 50
    v2, v3 = (config.session_name(f"writer-final-report-{v}", ws) for v in ("v2", "v3"))
    assert v2 != v3 and v2.startswith("thimble:writer-final-report-v2 · "), "the role is kept whole while the workspace can give"
    assert max(len(v2), len(v3)) <= config.SESSION_NAME_MAX
    long_ws = "w" * 100
    names = {r: config.session_name(r, long_ws) for r in ("main", "writer", "writer-story", "orient", "critic")}
    assert all(n.startswith(f"thimble:{r} · ") and len(n) <= config.SESSION_NAME_MAX for r, n in names.items())
    assert len(set(names.values())) == len(names)
    assert names["main"] != config.session_name("main", "w" * 99), "two long workspaces with one start stay apart"
    both = config.session_name("view-" + "x" * 200, long_ws)
    assert len(both) == config.SESSION_NAME_MAX
    assert len(config.session_name("dev-" + "y" * 200, None)) == config.SESSION_NAME_MAX


def test_an_unreadable_sidecar_holds_no_name():
    """config.free_name skips only a readable sidecar's name."""
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "logs.corpus.json").write_text("{not json")
        assert config.free_name("logs", Path(d)) == "logs"


def test_role_drops_the_workspace_only_from_thimble_names():
    assert config.session_role("thimble:writer-story · logs") == "thimble:writer-story"
    assert config.session_role("thimble:orient") == "thimble:orient", "an earlier build's name"
    assert config.session_role("fork(thread:a · b)") == "fork(thread:a · b)"


async def test_the_statusline_shows_the_orientation_and_its_cards_and_the_listing_plain_words(monkeypatch):
    """thimble's statusline shows the orientation's state and its cards, the other agents being rows of Claude Code's
    own tray; /thimble:agents lists every running agent of thimble's by what it does, and nothing under the rows, since
    Claude Code's own tray row already says how to follow an agent."""
    rows = [{"name": "thimble:orientation", "label": "orientation", "state": "working", "role": "orientation"},
            {"name": "thimble:writer", "label": "writer: report", "state": "waiting for a permission", "role": "writer"},
            {"name": "fork(thread:probe)", "state": "idle"}]
    monkeypatch.setattr(tray, "_cards", lambda c: 7)
    assert tray.status_line(CORPUS, rows) == "thimble · orientation working · 7 cards"
    assert tray.status_line(CORPUS, rows[1:]) == "", "no orientation runs"
    assert tray.listing_text(rows).splitlines() == [f"{'orientation':<18}  working",
                                                     f"{'writer: report':<18}  waiting for you",
                                                     "fork(thread:probe)  done"]
    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: CORPUS)
    monkeypatch.setattr(tray, "agent_rows", lambda c: rows)
    got = await tray.agents_route(tray.AgentsQuery(cwd="/work", session="main-1", announce=True))
    assert got["line"] == "thimble · orientation working · 7 cards" and got["announce"] == ""


def test_the_orientation_waiting_names_its_critic_or_its_own_subagents(workspaces_tmp, monkeypatch):
    """Live check L13: the statusline said the orientation was waiting for its critique while it waited for a helper
    it had started and no critic ran. The row names the child it waits for: its critic, else its subagents."""
    from app import events, subagent_files as sf, subagents

    monkeypatch.setattr(events, "asking", lambda c: set())
    with subagents.update(CORPUS) as state:
        sf.registry(state)["o1"] = {"role": "orientation", "key": "orient", "status": "waiting", "started": 1}
        sf.registry(state)["h1"] = {"role": None, "type": "thimble:orient-helper", "parent": "o1", "status": "running",
                                    "started": 2}
    [row] = tray.subagent_rows(CORPUS)
    assert row["state"] == "waiting for its subagents"
    with subagents.update(CORPUS) as state:
        sf.registry(state)["k1"] = {"role": "critic", "key": "critique", "parent": "o1", "status": "running",
                                    "started": 3}
    assert tray.subagent_rows(CORPUS)[0]["state"] == "waiting for its critique"
