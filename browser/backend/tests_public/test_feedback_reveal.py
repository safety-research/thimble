"""feedback.reveal_command: the command that shows a problem report in the server machine's file manager. In WSL
(WSL_DISTRO_NAME) it is wslview, which opens the folder in Windows' Explorer, ahead of xdg-open; without wslview, or
outside WSL, it is as on any Linux. The paths are made up."""
from __future__ import annotations

import sys
from pathlib import Path

from app import feedback


def test_in_wsl_a_report_s_folder_opens_with_wslview(monkeypatch, tmp_path):
    for name in ("wslview", "xdg-open"):
        (tmp_path / name).write_text("#!/bin/sh\n")
        (tmp_path / name).chmod(0o755)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setenv("WSL_DISTRO_NAME", "Made-Up")
    bundle = Path("/home/t/reports/thimble-report.zip")
    assert feedback.reveal_command(bundle) == ["wslview", "/home/t/reports"]
    (tmp_path / "wslview").unlink()
    assert feedback.reveal_command(bundle) == ["xdg-open", "/home/t/reports"]
    (tmp_path / "wslview").write_text("#!/bin/sh\n")
    (tmp_path / "wslview").chmod(0o755)
    monkeypatch.delenv("WSL_DISTRO_NAME")
    assert feedback.reveal_command(bundle) == ["xdg-open", "/home/t/reports"]
