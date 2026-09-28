"""Uninstall with terminal-first mode on (bg_session.py): it puts back the statusline and the trust thimble set before
it removes anything."""
from __future__ import annotations

import json

from app import bg_session, config

CORPUS = "mini"


def test_uninstall_puts_back_the_statusline_and_the_trust_before_it_removes_anything(tmp_path, monkeypatch):
    """`thimble uninstall` runs `python -m app.claude_changes undo` with the tree's Python, before any removal: every
    corpus folder's statusline is the analyst's own again and every work folder's trust is taken back."""
    import subprocess

    from app import cc_settings, claude_changes

    home = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / ".claude.json").write_text(json.dumps({"projects": {}}))
    corpus = tmp_path / "corpus-copy"
    local = corpus / ".claude" / "settings.local.json"
    local.parent.mkdir(parents=True)
    local.write_text(json.dumps({"statusLine": {"type": "command", "command": "my-line"}}))
    cc_settings.set_statusline(corpus, "thimble-agents --statusline --chain my-line")
    claude_changes.consent()
    work = (config.WORKSPACES_DIR / CORPUS / "writers" / "report").resolve()
    work.mkdir(parents=True)
    assert bg_session.trust_workspaces(work, {config.CONFIG_DIR_ENV: str(cfg)})
    user = tmp_path / "user"
    user.mkdir()
    env = {"HOME": str(user), "THIMBLE_HOME": str(home), "PATH": "/usr/bin:/bin"}
    r = subprocess.run(["bash", str(config.REPO_ROOT / "plugin" / "bin" / "thimble"), "uninstall", "--yes", "--keep-home"],
                       capture_output=True, text=True, env=env, timeout=60)
    assert "put back what terminal-first changed in Claude Code's files" in r.stdout, r.stdout + r.stderr
    assert json.loads(local.read_text())["statusLine"] == {"type": "command", "command": "my-line"}
    assert str(work) not in json.loads((cfg / ".claude.json").read_text())["projects"]
    assert claude_changes.statuslines() == {} and json.loads((home / claude_changes.TRUST_FILE).read_text()) == {}
    assert r.stdout.index("put back what terminal-first") < r.stdout.index("is kept (--keep-home)")
