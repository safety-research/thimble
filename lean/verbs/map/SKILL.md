---
name: map
description: Use when the person asks to map, lay out or see the shape of some work - one long agent run, many runs of a task, a sweep or a swarm, a dataset, a report or a code change - or presses m. You find the threads, stations and links in the rows, count them with `thimble q`, and save the map with `thimble save`; `k.map` draws it, and every station keeps its rows.
---

# Map: lay the work out by its own structure

The person wants to see the shape of the work: the order of moves in a long run, where many runs split and how they
ended, what a dataset holds. You find that structure in the rows, count it in code, and save it as an object. The
drawing is `k.map` (see `../../draw/TOOLKIT.md`), so you write the map, not its cells.

Under your reply the person sees the calm form: one row for one run, the main split and the endings for many runs, one
strip for a dataset. `m`, or opening the object, shows the full map. There each station, lane and group can be
selected, and it shows its rows and the threads that pass it. `m` on a selected station or lane maps those threads on
their own.

## What a map holds

- A **thread** moves through the work: one agent's run, each run of a sweep, each agent of a swarm. It has an `id`,
  `stops` (the stations it passes, in order), and any fields worth coloring by, such as `outcome` or `model`.
- A **station** is a move or a place: "reads the board", "reruns the test with no change", "LIVE COORDINATION pages".
  It has an `id`, a short `label` (and a `short` one of a word or two for tight spots), a `note` that says what happened
  there or how you matched it (the map already shows its steps), and a `ref` to its rows.
- A **link** is a relation the order of stops does not show: a revert that goes back, a note one agent wrote and
  others read.
- **Groups** gather stations into regions, for a dataset or a report, where nothing moves.

Every field is optional, and any field you add is kept. A query's output fits as it is: `"moves": "q2"`, where each
row has a thread, a station, `start` and `end`, and keeps its source rows.

## Principles

**Find the structure the work already has.** Read before you choose stations. A long run has phases. Many runs share
moves and split at a few of them. A dataset falls into kinds. Name stations by what happened, in the person's words,
not by tool names.

**Few stations, each one you can check.** Five to twelve stations read well. Write each as a rule in code ("runs pytest
after an edit", "posts REVIEW WANTED") or as step ranges you chose after reading, and apply it with `thimble q`. Fold
rare moves into a neighbor. Mark the stations that tell the story `"key": true`: the calm form shows those and the
endings.

**Every station names its rows.** A move's rows come with it when your query keeps `_refs` per row. A station can name
a query value, `"ref": "q3#kind=probe"`. When the person selects a station, they see its rows and step through the
threads that pass it. A station with no rows is a claim nobody can open.

**Count all of them.** A map of 40 runs says something about all 40. Compute stations over every thread in code. If
you mapped a sample, say so in the title.

**End where the threads end, and color by the question.** Give each run its ending (merged, closed, timed out) as its
last station, marked `"end": true`. Set `"lens"` to the thread field the person asked about; lanes split and color by
it. When they ask a new question of the map ("which runs masked the flake?"), compute that field in a query and save
a new version with it as the lens.

**The reply says what the map means.** One or two sentences: the shape, and what is surprising. The map holds the order,
the steps and the counts, and its full form lists every station with its count, so the reply needs no list or table
of the stations.

## Saving a map

```bash
thimble save NAME <<'JSON'
{"title": "...", "question": "the person's question",
 "program": "return k.frame(k.map(data), { title: data.title })",
 "data": {"title": "...", "unit": "runs", "threads": "q4", "moves": "q5", "stations": [...], "lens": "outcome"}}
JSON
```

The program is one line. Write your own around `k.map(data, o)` when the map needs words or parts beside it.

## Example: one long run (an agent's transcript)

The person asks: "What did agent-05 do, start to finish?" You read the run with `thimble rows`, then give its tool calls
phases as step ranges you chose after reading:

```bash
thimble q "agent-05's tool calls in phases" <<'PY'
df = load("agents/agent-05.jsonl", fields=["type", "message"])
calls = df[df.type == "assistant"].copy()
calls["tools"] = calls.message.map(lambda m: [b for b in (m or {}).get("content", []) if isinstance(b, dict) and b.get("type") == "tool_use"])
calls = calls[calls.tools.str.len() > 0].reset_index(drop=True)
calls["step"] = calls.index + 1
phases = [("orient", 1, 12), ("fix-a", 13, 103), ("review", 104, 106), ("fix-b", 107, 132), ("merge", 133, 133), ("tidy", 134, 143)]
calls["station"] = calls.step.map(lambda s: next(p for p, a, b in phases if a <= s <= b))
moves = calls.groupby("station", sort=False).agg(start=("step", "min"), end=("step", "max"), _refs=("_ref", list)).reset_index()
moves["thread"] = "agent-05"
moves
PY
thimble save agent-05-map <<'JSON'
{"title": "agent-05 · 143 tool calls", "program": "return k.frame(k.map(data), { title: data.title })",
 "data": {"title": "agent-05 · 143 tool calls", "unit": "calls", "threads": [{"id": "agent-05", "steps": 143}], "moves": "q1",
  "stations": [{"id": "orient", "label": "reads the board"}, {"id": "fix-a", "label": "fixes PR #66708", "note": "edits, runs pytest 6 times"},
   {"id": "review", "label": "reviews #66534"}, {"id": "fix-b", "label": "fixes PR #66763"}, {"id": "merge", "label": "merges", "mark": "✓"},
   {"id": "tidy", "label": "cleans up"}]}}
JSON
```

Under the reply: `reads the board ─ fixes PR #66708 ────── reviews #66534 ─ fixes PR #66763 ─ merges ✓ ─ cleans up`,
each stop as wide as its share of the calls.

## Example: many runs (a sweep, or a swarm)

The person asks: "How did the 40 runs of this task go?" One query gives each run its moves by rules in code, over all
40 transcripts; another gives each run its outcome:

```bash
thimble q "the moves of every run" <<'PY'
df = load("runs/*.jsonl", fields=["type", "message"])
...                                    # one row per (run, station, start, end), with _refs
moves
PY
thimble save runs-map <<'JSON'
{"title": "fix the flaky test · 40 runs", "program": "return k.frame(k.map(data), { title: data.title })",
 "data": {"title": "fix the flaky test · 40 runs", "unit": "runs", "lens": "outcome", "threads": "q2", "moves": "q1",
  "stations": [{"id": "tz", "label": "theory: timezone", "key": true, "note": "first theory mentions dates or timezones"},
   {"id": "fixture", "label": "theory: shared fixture", "key": true}, {"id": "rerun", "label": "reruns with no change"},
   {"id": "fixed", "label": "fixed", "end": true}, {"id": "masked", "label": "masked with @retry", "end": true}]}}
JSON
```

The calm form shows all 40 runs forking into the key stations and ending in their endings, each lane counted. The full
map shows every station; lanes split by outcome, and a bundle that has no room stays one striped lane with a count per
outcome. A swarm is the same with agents as threads; a note one agent wrote and others read is a link.

## Example: a dataset, a report or a code change

Nothing moves here, so there are no threads: stations are the kinds of things it holds, in groups.

```bash
thimble q "saves per kind of page" <<'PY'
df = load("revisions.jsonl", fields=["page", "label"])
df["kind"] = df.page.map(kind_of)       # your rule, written after reading pages
tally(df, "kind")
PY
thimble save wiki-map <<'JSON'
{"title": "what the wiki holds · 14,591 saves", "program": "return k.frame(k.map(data), { title: data.title })",
 "data": {"title": "what the wiki holds · 14,591 saves", "unit": "saves",
  "groups": [{"id": "coord", "label": "coordination pages"}, {"id": "links", "label": "link-reference pages"}],
  "stations": [{"id": "live", "label": "LIVE COORDINATION pages", "group": "coord", "n": "q1#kind=live@n", "ref": "q1#kind=live"}]}}
JSON
```

The calm form is one strip of the groups to scale; the full map is a box per group, a dot sized by each station's
count. A code change is the same: regions of the diff (formatting, core logic, tests), each sized by lines changed.
