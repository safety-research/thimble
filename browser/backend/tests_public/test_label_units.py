"""apply_label's `unit` for files: records (the default), files (one value per file) or runs (one per run directory). A
prompt label over whole files reads as much of each as fits its model's context, and a run that reads some only in
part counts them (concepts.read_cut), in tokens, in the tool's result and on the label's run.

Called through tools.call as a browser chat running as the analyst, over the three transcripts of `mini`
(agents/agent-0{1,2,3}.jsonl). The prompt kind's classifier is scripted at concepts.classify_structured; the code kind
runs in this process."""
from __future__ import annotations

import contextlib
import io
import os

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


async def _code_inproc(c: str, kernel: str, code: str, timeout_s: float | None = None):
    """The labels kernel's run of a code label's wrapper, in this process."""
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {"__name__": "wrapper"})  # noqa: S102 — the code the labels kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], 1, "ok"


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


async def test_a_code_label_over_files_gets_each_transcript_whole(monkeypatch):
    monkeypatch.setattr(notebook, "execute_on", _code_inproc)
    rule = ("def label(unit):\n"
            "    assert unit['path'] and isinstance(unit['data'], list) and len(unit['data']) == len(unit['records'])\n"
            "    return ('ends in an error' if any(r.get('is_api_error_message') for r in unit['data']) else 'no', 1.0)\n")
    text = await apply(name="api error", predicate={"kind": "code", "text": rule}, values=["ends in an error", "no"],
                       unit="files")
    assert "over 3 file(s)" in text, text
    assert values("api error") == {FILES[0]: "no", FILES[1]: "no", FILES[2]: "ends in an error"}


async def test_a_label_applied_again_keeps_its_unit_unless_the_call_names_one(classify):
    await apply(name="ran a command", predicate=PROMPT, unit="files")
    again = await apply(name="ran a command", predicate=PROMPT)
    assert label("ran a command")["unit"] == "agent" and "over 3 file(s)" in again
    assert tools.hint("apply_label-unchanged") in again, "the same predicate over the same files runs nothing again"
    await apply(name="ran a command", predicate={**PROMPT, "text": "The agent ran a shell command, such as a build."})
    assert label("ran a command")["unit"] == "agent" and set(values("ran a command")) == set(FILES), "a new predicate, still per file"
    by_record = await apply(name="ran a command", predicate=PROMPT, unit="records")
    assert label("ran a command")["unit"] == "record" and "over 60 record(s)" in by_record
    assert all("#L" in ref for ref in values("ran a command"))


async def test_a_label_over_records_is_as_before(classify):
    text = await apply(name="ran a command", predicate=PROMPT)
    k = label("ran a command")
    assert k["unit"] == "record" and k["marks"] == "record" and "over 60 record(s)" in text
    assert "agents/agent-01.jsonl#L11" in values("ran a command")


async def test_unit_is_for_files_alone():
    r = await tools.call(CORPUS, "apply_label", {"scope": "canvas", "name": "x", "predicate": PROMPT, "unit": "files"},
                         actor="analyst", notebook=None, terminal=False)
    assert r.is_error
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "x", "predicate": PROMPT, "unit": "lines"},
                         actor="analyst", notebook=None, terminal=False)
    assert r.is_error


def test_a_whole_file_is_read_as_far_as_the_label_model_s_context_holds():
    long_ = (config.LONG_CONTEXT_TOKENS - concepts.READ_RESERVE_TOKENS) * concepts.CHARS_PER_TOKEN
    short = (config.CONTEXT_TOKENS - concepts.READ_RESERVE_TOKENS) * concepts.CHARS_PER_TOKEN
    assert config.context_tokens("claude-opus-5-5") == config.context_tokens("opus") == config.LONG_CONTEXT_TOKENS
    assert config.context_tokens("claude-opus-5-5[1m]") == config.LONG_CONTEXT_TOKENS
    assert config.context_tokens("claude-haiku-4-5-20251001") == config.CONTEXT_TOKENS
    assert concepts.labels_model(CORPUS)["model"] == "claude-opus-5-5", "the labels row's model by default"
    assert concepts.whole_read_chars(CORPUS, {}) == long_ > 10 * concepts.UNIT_TEXT_MAX
    assert concepts.whole_read_chars(CORPUS, {"model": "claude-haiku-4-5-20251001"}) == short, "the label's own model first"


async def test_a_batch_longer_than_a_200k_window_runs_on_the_model_s_1m_window(monkeypatch):
    asked: list[tuple[str, str]] = []

    async def structured(prompt, *, model, refusal, **kw):
        asked.append((model, (refusal or {}).get("model", "")))
        return model_mod.CallResult(status="ok", output={"labels": []})

    monkeypatch.setattr(model_mod, "structured", structured)
    k = concepts.new_concept("ran a command", PROMPT["text"], unit="agent")
    big = "x" * ((config.CONTEXT_TOKENS - concepts.READ_RESERVE_TOKENS) * concepts.CHARS_PER_TOKEN + 1)
    await concepts.labels_task(CORPUS, concepts.label_input(k, [(FILES[0], "a short file")]))
    await concepts.labels_task(CORPUS, concepts.label_input(k, [(FILES[1], big)]))
    assert asked[0][0] == "claude-opus-5-5" and not asked[0][0].endswith("[1m]")
    assert asked[1][0] == "claude-opus-5-5[1m]" and asked[1][1].endswith("[1m]"), asked


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


async def test_a_cut_file_s_tokens_are_estimated_when_its_call_counts_none(monkeypatch, classify):
    cap = _read_small(monkeypatch, 1200)
    await apply(name="ran a command", predicate=PROMPT, unit="files")
    cut = label("ran a command")["applications"][-1]["cut"]
    assert cut["n"] == 2 and cut["tokens"] == -(-(cap + len("\n…[truncated]")) // concepts.CHARS_PER_TOKEN)


def test_the_cut_line_says_tokens_and_how_many_of_how_many():
    cut = concepts.read_cut(["a", "b", "c"], [900_000, 912_000, 905_000], 0, 776, "agent")
    assert cut["line"] == "3 of 776 files were longer than the model reads; it read the first ~905k tokens of each"
    one = concepts.read_cut(["runs/r1"], [1_200_000], 0, None, "run")
    assert one["line"].startswith("1 run was longer than the model reads") and "~1.2M tokens of it" in one["line"]
    json_doc = concepts.read_cut(["d.json"], [880_000], 1, 4, "agent")
    assert "shortened" in json_doc["line"] and "~880k tokens" in json_doc["line"]
    many = concepts.read_cut([f"f{i}" for i in range(concepts.CUT_REFS_KEPT + 5)], [10] * 5, 0, None, "agent")
    assert many["n"] == concepts.CUT_REFS_KEPT + 5 and len(many["refs"]) == concepts.CUT_REFS_KEPT
