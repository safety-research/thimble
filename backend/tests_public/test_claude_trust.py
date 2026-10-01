"""thimble's reading of Claude Code's trust (claude_changes.trusted) agrees with the rule `claude --bg` applies to the
folder it starts in: an entry without the trust never ends the search upward, the root of a git repository does, and a
worktree counts as its repository's main checkout. The doctor line (cli.untrusted) and the gate before a background
session starts (bg_session.trusted) follow it."""
from __future__ import annotations

import json
from pathlib import Path

from app import bg_session, claude_changes, cli, config

T, F = {"hasTrustDialogAccepted": True}, {"hasTrustDialogAccepted": False}
# what Claude Code writes for each folder it runs in, a work folder below a trusted one included
RAN_HERE = {**F, "allowedTools": [], "lastAPIDuration": 1200}


def projects(**entries: dict) -> dict:
    return {"projects": {k: v for k, v in entries.items()}}


def checkout(path: Path) -> Path:
    (path / ".git").mkdir(parents=True)
    return path


def worktree(repo: Path, path: Path, name: str = "wt") -> Path:
    """`git worktree add <path>` of `repo`, as git lays it out."""
    meta = repo / ".git" / "worktrees" / name
    meta.mkdir(parents=True)
    (meta / "commondir").write_text("../..\n")
    (meta / "gitdir").write_text(f"{path / '.git'}\n")
    path.mkdir(parents=True)
    (path / ".git").write_text(f"gitdir: {meta}\n")
    return path


def test_entries_without_the_trust_do_not_hide_a_trusted_folder_above(tmp_path):
    parent = tmp_path / "Developer"
    plain = parent / "plain" / "sub"
    plain.mkdir(parents=True)
    assert claude_changes.trusted(plain, projects(**{str(parent): T}))
    assert claude_changes.trusted(plain, projects(**{str(parent): T, str(plain): RAN_HERE}))
    assert claude_changes.trusted(plain, projects(**{str(parent): T, str(plain.parent): F}))
    assert not claude_changes.trusted(plain, projects(**{str(plain): RAN_HERE}))
    assert not claude_changes.trusted(plain, {"projects": "not a mapping"})


def test_a_trusted_folder_above_a_git_checkout_does_not_trust_the_checkout(tmp_path):
    """A Dev install cloned into a trusted folder: the clone's own entry decides, whether false or missing."""
    parent = tmp_path / "Developer"
    tree = checkout(parent / "thimble")
    work = tree / "workspaces" / "c" / "orient" / "work"
    work.mkdir(parents=True)
    for data in (projects(**{str(parent): T}), projects(**{str(parent): T, str(tree): F})):
        assert not claude_changes.trusted(tree, data)
        assert not claude_changes.trusted(work, data)
    data = projects(**{str(parent): T, str(tree): T, str(work): RAN_HERE})
    assert claude_changes.trusted(tree, data) and claude_changes.trusted(work, data)


def test_a_worktree_counts_as_its_main_checkout(tmp_path):
    """A code ticket's worktree, outside the checkout it was cut from, is trusted by that checkout's entry, and a
    trusted folder above the worktree does not reach into it."""
    tree = checkout(tmp_path / "Developer" / "thimble")
    above = tmp_path / "home"
    wt = worktree(tree, above / ".thimble" / "dev" / "t1")
    (wt / "frontend").mkdir()
    assert not claude_changes.trusted(wt / "frontend", projects(**{str(above): T}))
    assert claude_changes.trusted(wt / "frontend", projects(**{str(tree): T}))


def test_a_folder_reached_through_a_symlink_counts_by_real_paths(tmp_path):
    """An entry for a symlinked folder trusts what the link leads to, and a link inside a trusted folder that leads out
    of it is not trusted by that folder."""
    data_disk = tmp_path / "disk"
    (data_disk / "thimble" / "workspaces").mkdir(parents=True)
    link = tmp_path / "home" / "Developer"
    link.parent.mkdir()
    link.symlink_to(data_disk)
    ws = link / "thimble" / "workspaces"
    assert claude_changes.trusted(ws, projects(**{str(link): T}))
    trusted_folder = tmp_path / "trusted"
    trusted_folder.mkdir()
    (trusted_folder / "out").symlink_to(data_disk / "thimble")
    assert not claude_changes.trusted(trusted_folder / "out" / "workspaces", projects(**{str(trusted_folder): T}))


def test_thimble_s_work_folders_stay_trusted_below_a_trusted_workspaces_folder(tmp_path, monkeypatch):
    """Claude Code writes an entry without the trust for every work folder a background session ran in; the workspaces
    folder's entry still covers them, and the next session starts."""
    ws = tmp_path / "home" / "workspaces"
    work = [ws / "c" / "orient" / "work", ws / "c" / "critique" / "993cc1f5" / "work", ws / "c" / "writers" / "report",
            ws / "c" / "views-work" / "timeline"]
    for w in work:
        w.mkdir(parents=True)
    data = projects(**{str(ws): T}, **{str(w): RAN_HERE for w in work})
    assert all(claude_changes.trusted(w, data) for w in work)
    cfg = tmp_path / ".claude.json"
    cfg.write_text(json.dumps(data))
    monkeypatch.setattr(bg_session, "claude_json", lambda: cfg)
    monkeypatch.setattr(config, "WORKSPACES_DIR", ws)
    assert bg_session.trusted("c") and cli.untrusted(ws) is None


def test_doctor_and_the_session_gate_follow_the_checkout_s_own_entry(tmp_path, monkeypatch):
    """The case of a Dev install in a trusted folder whose own entry is false: doctor says the workspaces folder is not
    trusted and no background session starts, until the install's own entry holds the trust."""
    parent = tmp_path / "Developer"
    tree = checkout(parent / "thimble")
    ws = tree / "workspaces"
    (ws / "c").mkdir(parents=True)
    cfg = tmp_path / ".claude.json"
    cfg.write_text(json.dumps(projects(**{str(parent): T, str(tree): F})))
    monkeypatch.setattr(bg_session, "claude_json", lambda: cfg)
    monkeypatch.setattr(config, "WORKSPACES_DIR", ws)
    assert cli.untrusted(ws) == ws and not bg_session.trusted("c")
    claude_changes._set_trust(tree, cfg, True)
    assert cli.untrusted(ws) is None and bg_session.trusted("c")


def test_a_yes_writes_the_install_s_own_entry_even_where_a_folder_above_trusts_it(tmp_path, monkeypatch):
    """`install.sh --trust-workspaces` leaves the install trusted by its own entry, which a later change to the entry
    above cannot take away; an entry already true is left as it is and not recorded as thimble's."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thimble-home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.delenv("THIMBLE_WORKSPACES_DIR", raising=False)
    parent = tmp_path / "apps"
    tree = parent / "thimble"
    tree.mkdir(parents=True)
    cfg = claude_changes.global_config()
    cfg.parent.mkdir()
    cfg.write_text(json.dumps(projects(**{str(parent): T})))
    record = tmp_path / "thimble-home" / claude_changes.TRUST_FILE
    assert claude_changes.question(tree) == "" and "is trusted" in claude_changes.install_trust(tree)
    assert str(tree) not in json.loads(cfg.read_text())["projects"]
    claude_changes.install_trust(tree, "yes")
    assert json.loads(cfg.read_text())["projects"][str(tree)] == T and json.loads(record.read_text())["added"] is True
    record.unlink()
    claude_changes.install_trust(tree, "yes")
    assert json.loads(record.read_text())["added"] is False
