"""The names of the Claude Code sessions thimble starts (config.session_name): `thimble:<role> · <workspace>`, since
`claude agents` lists the sessions of every folder; a long name kept short and distinct, and main's name as launch-args
prints it (cli.main_name) and the launcher passes it. The statusline and /thimble:agents name thimble's agents by what
they do (tray.py)."""
from __future__ import annotations



from app import config, dev

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


def test_role_drops_the_workspace_only_from_thimble_names():
    assert config.session_role("thimble:writer-story · logs") == "thimble:writer-story"
    assert config.session_role("thimble:orient") == "thimble:orient", "an earlier build's name"
    assert config.session_role("fork(thread:a · b)") == "fork(thread:a · b)"
