"""The product tour's first-launch state lives in thimble's own home (THIMBLE_HOME/tour.json), never in Claude Code's
config: unseen on a new install, seen once the page records the offer, for every workspace."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from app import main


def test_the_tour_is_offered_once_per_install_and_recorded_in_thimble_home(claude_global_config):
    home = Path(os.environ["THIMBLE_HOME"])
    claude_before = claude_global_config.read_text()
    c = TestClient(main.create_app())
    assert c.get("/api/tour").json() == {"seen": False}
    assert not (home / "tour.json").exists()
    assert c.post("/api/tour/seen").json() == {"seen": True}
    assert c.get("/api/tour").json() == {"seen": True}
    assert json.loads((home / "tour.json").read_text())["seen"]
    # a new app on the same home (a restarted server) still knows
    assert TestClient(main.create_app()).get("/api/tour").json() == {"seen": True}
    assert claude_global_config.read_text() == claude_before


def test_the_tour_sets_up_its_example_workspace_from_the_shipped_sample_and_reuses_it(data_tmp):
    """With no demo installed, the tour's workspace is set up on the spot from plugin/viewers/timeline, with no
    network: example-timeline on a copy of its sample in THIMBLE_HOME/examples, its view built. A second call reuses it."""
    from app import config, views

    home = Path(os.environ["THIMBLE_HOME"])
    c = TestClient(main.create_app())
    first = c.post("/api/tour/workspace")
    assert first.status_code == 200 and first.json() == {"name": "example-timeline"}
    folder = home / "examples" / "example-timeline"
    assert sorted(p.name for p in folder.iterdir()) == sorted(p.name for p in (views.EXAMPLES_DIR / "timeline" / "sample").iterdir())
    assert Path(config.corpus_dir("example-timeline")) == folder.resolve()
    view = config.workspace_path("example-timeline") / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR / "timeline" / views.VIEW_JSON
    built = json.loads(view.read_text())["built"]
    assert built
    again = c.post("/api/tour/workspace")
    assert again.json() == {"name": "example-timeline"}
    assert json.loads(view.read_text())["built"] == built, "reused, not installed again"
