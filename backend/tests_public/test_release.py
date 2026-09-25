"""scripts/release.sh, built without the UI into a temporary folder: the zip carries what an install runs (the
screenshot script main's `screenshot` tool needs among it) and the docs the readme links, and every other link of the
readme points at GitHub, so none is broken in an unzipped install."""
from __future__ import annotations

import re
import shutil
import subprocess
import zipfile

import pytest

from app import config


@pytest.mark.skipif(not shutil.which("zip") or not shutil.which("git") or not (config.REPO_ROOT / ".git").exists(),
                    reason="release.sh needs zip and a git checkout")
def test_the_zip_ships_the_screenshot_script_and_no_broken_readme_link(tmp_path):
    out = subprocess.run(["bash", str(config.REPO_ROOT / "scripts" / "release.sh"), "--skip-frontend", "--out",
                          str(tmp_path)], capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    [zip_path] = list(tmp_path.glob("thimble-*.zip"))
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        top = names[0].split("/")[0]
        files = {n[len(top) + 1:] for n in names if not n.endswith("/")}
        readme = z.read(f"{top}/README.md").decode()
    assert {"scripts/ui_shot.mjs", "scripts/view_shot.mjs", "INSTALL.md", "LICENSE"} <= files
    assert "THIRD_PARTY_NOTICES" not in files, "the notices describe frontend/dist, which a --skip-frontend zip lacks"
    assert not any(f.startswith("scripts/dev/") for f in files)
    for target in re.findall(r"\]\(([^)\s]+)\)", readme) + re.findall(r'src="([^"]+)"', readme):
        path = target.split("#", 1)[0]
        assert not path or re.match(r"^[a-z][a-z0-9+.-]*:", target) or path in files, target
