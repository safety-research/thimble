"""Labels over whole runs: each run folder is one unit however deep its matched files lie (bug hunt 2, C6).

A run's folder is the outermost folder below the corpus root that holds files itself (corpus.run_dir): a file in a run's
sub-folder belongs to the run, and a folder that holds only run folders is not a run. The classifier is scripted at
concepts.classify_structured (no model call, no Claude Code session)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import call_result, concepts, config

CORPUS = "nested"
RUNS = ("alpha-run", "beta-run", "sweeps/gamma-run")  # `sweeps` holds only a run folder
SCOPE = dict(scope="files", values=None, comment=False, filter=False, created_by="test", chat=None, group=None,
             card=False, unit="run")


def _write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, "utf-8")


def _turn(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    """A corpus of three made-up runs, each with a prompt and a transcript at its top and reports in sub-folders."""
    root = tmp_path / "data" / CORPUS
    _write(root, "manifest.json", json.dumps({"name": CORPUS}))
    for run in RUNS:
        _write(root, f"{run}/prompt.md", f"# The task of {run}\n")
        _write(root, f"{run}/transcript.jsonl", _turn(f"{run} starts") + _turn(f"{run} ends"))
    _write(root, "alpha-run/docs/report/notes.md", "alpha notes\n")
    _write(root, "beta-run/candidates/v-1/report/notes.md", "beta notes\n")
    _write(root, "beta-run/candidates/v-1/README.md", "beta variant\n")
    _write(root, "sweeps/gamma-run/final/report/notes.md", "gamma notes\n")
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    return root.resolve()


@pytest.fixture()
def asked(monkeypatch) -> list[list[tuple[str, str]]]:
    """The items of each classifier batch, every one answered `yes`."""
    batches: list[list[tuple[str, str]]] = []

    async def call(c, concept, items, comment=True, on_retry=None):
        batches.append(list(items))
        return call_result.CallResult(status="ok", output={"labels": [
            {"i": n, "label": "yes", "confidence": 0.9, "rationale": "r"} for n in range(1, len(items) + 1)]})

    monkeypatch.setattr(concepts, "classify_structured", call)
    return batches


async def _apply(name: str, paths: list[str], limit: int | None = None) -> dict:
    s = await concepts.apply_scoped(CORPUS, name=name, kind="prompt", text="The run reached its goal.", paths=paths,
                                    limit=limit, **SCOPE)
    return await concepts.wait_apply(CORPUS, s["concept"], 60) if s["partial"] else s


async def test_a_label_over_runs_gives_each_run_folder_one_value_however_deep_its_files_lie(corpus, asked,
                                                                                              workspaces_tmp):
    """Bug hunt 2, C6: with paths such as `*/*/report/*.md`, each matched file's own folder (`…/docs/report`,
    `…/candidates/v-1`) was a run. The units are the run folders, in a full run and in a trial of one."""
    s = await _apply("run reached its goal", ["*/*/report/*.md", "*/*/README.md"])
    assert {ref for batch in asked for ref, _t in batch} == set(RUNS) and s["total"] == 3
    assert {r["ref"] for r in concepts.read_labels(workspaces_tmp / CORPUS, s["concept"])} == set(RUNS)

    asked.clear()
    await _apply("run reached its goal (one)", ["*/*/report/*.md"], limit=1)
    assert len(asked) == 1 and [ref for ref, _t in asked[0]] in ([r] for r in RUNS), asked
