"""What each mode's models read, fingerprinted: every text the terminal plugin's prompt registry gives its readers
(plugin/prompts), and every prompt the workbench renders (browser/prompts) with the plugin's texts it reads as the
terminal does (the checker, the look, the fixer, a side thread's instructions, the label classifier and the notices
after a check), each by the sha256 of its words, in fixtures/renders.json.

A change to what a model reads changes a fingerprint, so the commit that makes it names the texts it changes in each
mode; a change that only moves words, such as a text that both modes come to share, changes none. When a change to the
words is meant, write the new fingerprints in browser/backend:
`THIMBLE_WRITE_RENDERS=1 .venv/bin/python -m pytest tests_public/test_renders.py`."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

from app import concepts, fixes, marks, prompts, threads

REPO = Path(__file__).resolve().parents[3]
PLUGIN_PROMPTS = REPO / "plugin" / "prompts"
LOOK_OF = REPO / "browser" / "backend" / "app" / "look_of.mjs"
FINGERPRINTS = Path(__file__).resolve().parent / "fixtures" / "renders.json"

# made-up values for the calls whose prompts are fingerprinted as a call sends them
MARKS = "1. [12] in: We saw [12] runs."
FIX = {"id": 3, "title": "Bar says rows", "words": ["make the bar say rows", "and bold"],
       "work": "/made-up/fixes/work/3"}
LOOK = {"lenses": ["explain", "heads"],
        "msgs": [{"kind": "answer", "text": "The clean stage drops about 400 trips a night.\n\nIt drops short trips.",
                  "turnNo": 2, "prompt": {"text": "what does the clean stage drop?", "by": "composer"}}],
        "coverage": "The session's calls above show what it read.",
        "state": {"glossed": ["docking test"], "headsGiven": ["The 400 counts every rule together"]}}
LABEL = {"id": "k1", "name": "Curt reply", "unit": "record", "kind": "prompt", "spec": "The reply is short and unfriendly.",
         "description": "", "labels": ["curt", "not curt"], "marks": "span",
         "examples": [{"ref": "runs/b.jsonl#L4", "text": "No.", "value": "curt", "note": "too short"}]}
LABEL_ITEMS = [("runs/a.jsonl#L1", "Do it now."), ("runs/a.jsonl#L2", "Thanks so much!")]
# made-up marks of a reply's check, one of each kind of result, for the notices main reads after it
NOTICE_ITEMS = [
    {"n": 1, "words": "15 of 40", "was": "15 of 40", "shown": "12 of 40", "status": "corrected",
     "sentence": "We saw [15 of 40] runs.", "reason": "The log shows 12."},
    {"n": 2, "words": "every run passed", "was": "every run passed", "shown": "every run", "status": "corrected",
     "narrowed": True, "sentence": "Then [every run passed]."},
    {"n": 3, "words": "a week", "was": "a week", "shown": "a week", "status": "corrected",
     "sentence": "They stayed [a week].", "rewrite": "Together they stayed [a week]."},
    {"n": 4, "words": "41", "status": "failed", "failedBy": "evidence", "sentence": "It failed [41] times.",
     "reason": "No line shows 41."},
    {"n": 5, "words": "agent-07", "status": "failed", "failedBy": "check", "sentence": "The last was [agent-07].",
     "note": "agent-02 merged it."},
]


def _terminal() -> dict[str, str]:
    """Each text of the plugin's registry as the terminal reads it, before its reader fills its slots: what prompts.ts
    gives its reader (plugin/prompts/node.mjs textOf, by the same composition)."""
    script = (f"import {{ TEXTS }} from {json.dumps((PLUGIN_PROMPTS / 'registry.mjs').as_uri())}\n"
              f"import {{ textOf }} from {json.dumps((PLUGIN_PROMPTS / 'node.mjs').as_uri())}\n"
              "const out = {}\nfor (const name of Object.keys(TEXTS)) out[name] = await textOf(name, 'terminal')\n"
              "process.stdout.write(JSON.stringify(out))")
    done = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, check=True)
    return json.loads(done.stdout)


def _browser() -> dict[str, str]:
    """Each prompt file of the workbench, includes pasted in and slots left in place, and the plugin's texts as the
    workbench's calls send them."""
    out = {rel: prompts.load(rel) for rel in sorted(
        str(p.relative_to(prompts.PROMPTS_DIR)) for p in prompts.PROMPTS_DIR.rglob("*.md"))}
    out["plugin:checker (marks.checker_prompt)"] = marks.checker_prompt(MARKS, "/made-up/shell", "/made-up/cards.tsv",
                                                                        "/made-up/corpus")
    out["plugin:fixer (fixes.first_message)"] = fixes.first_message(FIX, "the page")
    out["plugin:thread, thread (threads.fork_text)"] = threads.fork_text()
    out["plugin:notices (marks.notices)"] = "\n\n".join((
        marks._framed(marks.notices({"kind": "tell", "items": NOTICE_ITEMS})),
        marks._framed(marks.notices({"kind": "repair", "items": NOTICE_ITEMS[3:], "auto": True})),
        marks.repair_request(NOTICE_ITEMS[3], 4), marks.repair_request(NOTICE_ITEMS[4], 5, auto=True)))
    done = subprocess.run(["node", str(LOOK_OF)], input=json.dumps({"prompt": LOOK}).encode(), capture_output=True,
                          check=True)
    out["plugin:observer, lenses (look_of.mjs)"] = json.loads(done.stdout)["prompt"]
    inp = concepts.label_input(LABEL, LABEL_ITEMS)
    system, user = concepts.build_classify_prompt(inp)
    tool = concepts.labels_tool(inp["label"])
    out["plugin:labels (concepts.build_classify_prompt, labels_tool)"] = "\n\n".join(
        [system, user, tool.name, tool.description, json.dumps(tool.input_schema, sort_keys=True)])
    return out


def test_what_each_mode_reads_is_as_its_fingerprints_say(monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    texts = {**{f"terminal {k}": v for k, v in _terminal().items()},
             **{f"browser {k}": v for k, v in _browser().items()}}
    now = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in sorted(texts.items())}
    if os.environ.get("THIMBLE_WRITE_RENDERS"):
        FINGERPRINTS.write_text(json.dumps(now, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    pinned = json.loads(FINGERPRINTS.read_text("utf-8"))
    changed = sorted(k for k in now.keys() & pinned.keys() if now[k] != pinned[k])
    added, gone = sorted(now.keys() - pinned.keys()), sorted(pinned.keys() - now.keys())
    assert not (changed or added or gone), (
        f"what a model reads differs from {FINGERPRINTS.name}: changed {changed}, new {added}, gone {gone}. When the "
        "change is meant, write the new fingerprints (this test's note says how); else find what changed the words.")
