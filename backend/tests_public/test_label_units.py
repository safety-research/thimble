"""apply_label's `unit` for files: records (the default), files (one value per file) or runs (one per run directory). A
prompt label over whole files reads as much of each as fits its model's context, and a run that reads some only in
part counts them (concepts.read_cut), in tokens, in the tool's result and on the label's run.

Called through tools.call as a browser chat running as the analyst, over the three transcripts of `mini`
(agents/agent-0{1,2,3}.jsonl). The prompt kind's classifier is scripted at concepts.classify_structured; the code kind
runs in this process."""
from __future__ import annotations


import pytest

from app import concepts, config, notebook, tools
from app import model as model_mod

CORPUS = "mini"
FILES = ["agents/agent-01.jsonl", "agents/agent-02.jsonl", "agents/agent-03.jsonl"]


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


class Classify:
    """Scripted concepts.classify_structured: `yes` for a text that holds a Bash call, each call's items kept, and the
    call's usage when `usage` is set (as the CLI reports it)."""

    def __init__(self, usage: dict | None = None):
        self.calls: list[list[tuple[str, str]]] = []
        self.usage = usage

    async def __call__(self, c, concept, items, comment=True, on_retry=None):
        self.calls.append(list(items))
        labels = [{"i": n, "label": "yes" if '"Bash"' in t else "no", "confidence": 0.9} for n, (_r, t) in enumerate(items, 1)]
        return model_mod.CallResult(status="ok", output={"labels": labels}, usage=self.usage, attempts=1)


@pytest.fixture()
def classify(monkeypatch) -> Classify:
    fake = Classify()
    monkeypatch.setattr(concepts, "classify_structured", fake)
    return fake


async def apply(**args) -> str:
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "paths": ["agents/*.jsonl"], **args}, actor="analyst",
                         notebook=None, terminal=False)
    assert not r.is_error, r.text
    return r.text


def label(name: str) -> dict:
    k = concepts.find_concept(config.workspace_dir(CORPUS), name)
    assert k is not None
    return k


def values(name: str) -> dict[str, str]:
    return {r["ref"]: r["label"] for r in concepts.read_labels(config.workspace_dir(CORPUS), label(name)["id"])}


PROMPT = {"kind": "prompt", "text": "The agent ran a shell command."}


async def test_a_prompt_label_over_files_gives_each_transcript_one_value_from_its_whole_text(classify):
    text = await apply(name="ran a command", predicate=PROMPT, unit="files")
    k = label("ran a command")
    assert k["unit"] == "agent" and k["marks"] == "file"
    assert "over 3 file(s)" in text, text
    assert set(values("ran a command")) == set(FILES), "one value per file, not per record"
    asked = dict(item for call in classify.calls for item in call)
    assert set(asked) == set(FILES) and all("…[truncated]" not in t for t in asked.values()), "each file read whole"
    assert "longer than the model reads" not in text and not k["applications"][-1].get("cut")


def _read_small(monkeypatch, tokens: int) -> int:
    """The label model's context made to hold `tokens` of a file, and a call's batch fewer characters than that, as a
    real context holds many more than BATCH_CHARS; the characters read of a file."""
    monkeypatch.setattr(concepts, "UNIT_TEXT_MAX", 100)
    monkeypatch.setattr(concepts, "READ_RESERVE_TOKENS", config.LONG_CONTEXT_TOKENS - tokens)
    monkeypatch.setattr(concepts, "BATCH_CHARS", tokens * concepts.CHARS_PER_TOKEN - 600)
    return tokens * concepts.CHARS_PER_TOKEN


async def test_a_file_longer_than_the_model_reads_is_cut_counted_in_tokens_and_said(monkeypatch):
    fake = Classify(usage={"input_tokens": 1180, "output_tokens": 40, "cache_read_input_tokens": 20})
    monkeypatch.setattr(concepts, "classify_structured", fake)
    cap = _read_small(monkeypatch, 1200)
    text = await apply(name="ran a command", predicate=PROMPT, unit="files")
    asked = dict(item for call in fake.calls for item in call)
    cut_files = [p for p, t in asked.items() if t.endswith("…[truncated]")]
    assert cut_files == FILES[:2], "agent-01 and agent-02 run past 3,600 characters, agent-03 does not"
    assert all(len(asked[p]) <= cap + len("\n…[truncated]") for p in cut_files)
    assert all(len(call) == 1 for call in fake.calls if any(t.endswith("…[truncated]") for _r, t in call)), "a cut file goes alone"
    cut = label("ran a command")["applications"][-1]["cut"]
    assert cut["n"] == 2 and cut["of"] == 3 and cut["refs"] == FILES[:2]
    assert cut["tokens"] == 1200, "the input tokens its call counted, the cached ones included"
    assert cut["line"] in text and "tokens" in cut["line"] and "character" not in cut["line"], text
    # the label keeps the count with its run, so the same apply again says it, until a run reads every file whole
    again = await apply(name="ran a command", predicate=PROMPT)
    assert tools.hint("apply_label-unchanged") in again and cut["line"] in again
    monkeypatch.setattr(concepts, "READ_RESERVE_TOKENS", config.LONG_CONTEXT_TOKENS - 10_000)
    whole = await apply(name="ran a command", predicate={**PROMPT, "text": "The agent ran any shell command."})
    assert "longer than the model reads" not in whole and not label("ran a command")["applications"][-1].get("cut")
