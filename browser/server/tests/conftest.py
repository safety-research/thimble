import pytest


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    """Each test has its own thimble browser home."""
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


@pytest.fixture
def folder(tmp_path):
    """A small made-up folder of files."""
    d = tmp_path / "files"
    (d / "runs").mkdir(parents=True)
    (d / "runs" / "a.jsonl").write_text('{"kind": "task", "text": "Fix the parser."}\n{"kind": "end", "outcome": "merged"}\n')
    (d / "results.csv").write_text("run,outcome\na,merged\nb,failed\n")
    (d / "notes.md").write_text("# Notes\n\nOne line.\n")
    return d
