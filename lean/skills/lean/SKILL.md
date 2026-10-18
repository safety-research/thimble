---
name: lean
description: Use when you read, count or explain what is in files for a person (agent transcripts, logs, CSV or JSONL records, databases, diffs, docs). The `lean` command keeps where each value came from, saves what you make as an object, and says what you did not read.
---

# Where each value comes from

The person must be able to trust what you show them and check it quickly. So each value you show should lead back to the rows it came from. The `lean` command keeps this record for you. Run it with Bash in the folder of files. `lean` alone lists its commands.

## Principles

**Compute with code that is kept.** Count, group and compare in `lean q`. It keeps your code, the files it read and its output, and a later query reads that output with `use("q3")`, so a result is never computed twice. When you count by group, each output row also keeps its source rows, so the person can open the rows behind any number. `tally(df, by)` keeps them exactly. A plain `groupby` usually works too, and the output says how sure the match is.

**Cite what you show.** Write a number as a link to the value it came from, as in `[6,543 saves](q1#day=2026-06-18@n)`. Write a quote as a link to its row, as in `["PRECISION ALERT"](revisions.jsonl#L4410)`. A ref is a stable id, so it still works when the analysis runs again. If you are not sure where a value came from, run `lean resolve` on it before you use it.

A sparkline draws a series in your sentence: write `[~](q3@n)`, and the person sees column `n` of q3's output, in its row order, drawn in place, and opens its rows like any citation. It helps only when the sentence claims a shape that the numbers alone hide: a trend, a burst or a spread. For example: `Messages fell after June 16 [~](q3@n), from [1,546](q3#day=2026-06-16@n) to [5](q3#day=2026-06-22@n).` Next to a single count, or in a short reply, a sparkline is decoration that takes the person's attention. So use at most one in a message, and none in a short reply.

**Save what the person will keep as an object.** When a result is worth more than one reply (a chart, a table, a map, a short summary), save it with `lean save`. An object is a program, its data and its lineage. Put query refs in its data, not copied numbers: the kernel fills in each value and keeps the rows behind it. Add any field that helps. If you read or judged rows in a way that no tool saw, say so under `declared`, in your own words. A long object is easier to read and to change as a file: write its JSON with the Write tool and run `lean save NAME --from FILE`.

**Know what you did not read.** "All", "every" and "typical" are claims about files you may not have opened. `lean coverage` shows what this session computed over, read, searched and did not touch. If a file you did not read could change the answer, tell the person.

**Fix what does not hold.** `lean save` checks each citation and each binding. It saves the object anyway and lists each problem in its output. Fix the problem and save again. The object keeps each version.

## What the person sees

An object you save is drawn for the person under your reply, in the terminal, from its `program`. So the reply does
not need to repeat what the object shows: say what it means and what to look at.

**Make a card its title, its chart and its takeaway.** The title states the claim, and one line under the chart says
what to see. Label marks in place (a bar part's `label`, a station's name) rather than in a legend, and leave sources
and ids out: the detail view shows where each value comes from.

**A card is a small program, and its form is yours.** Use any layout, zoom, filter or interaction that helps the
claim. The helpers in `../../draw/TOOLKIT.md` (from this skill's base folder; read it before your first card) are
conveniences, not a form to fill. One program draws in the terminal and the browser. Under a reply the person sees
about half a screen; the detail view (`k.mode === 'detail'`) has more room.

**Values keep their rows by themselves.** Bind query outputs in the card's data (`"data": {"days": "q1"}`). A part you
draw from a row of it (the row, a copy, or `row: d` in a region's meta) opens its source rows and real examples when the
person selects it, with no ref written. A value the program computes has no rows: say what it rests on.

**Interaction is state.** `k.on(key | 'press:<id>' | 'brush', fn, label)` returns the new state, and the card draws
again from `k.state`, the same in both surfaces. In a handler, `k.ask({label, rows})` sends the person's next question
to the card's thread with those rows. Add an interaction only when it answers a likely next question.

A card that fails draws one line with what to fix: fix it and save again under the same name.

**Suggest the verbs that help, if any.** Under the object the person sees a row of 2–3 verbs and `? all`. An object
may name them itself: `"hints": ["squeeze", "trace"]`. Leave it out when you have no reason to choose.

When the person asks while an object is open, your context says which object and which part they had selected, with
its refs. "This" usually means that part.

The kernel shows the person nothing else by itself. They see only what you write and the objects you save.

## Example: a count and the rows behind it (a wiki's edit log)

The person asks: "When did the agents edit the wiki most?"

```bash
lean sources
lean q "saves per day" <<'PY'
df = load("revisions.jsonl", fields=["time", "label"])
df["day"] = df.time.str[:10]
tally(df, "day")
PY
```

The output ends with "Each output row keeps its source rows" and a citation you can copy. Save the result, with its peak cited in the words:

```bash
lean save saves-per-day <<'JSON'
{"title": "Saves per day", "question": "When did the agents edit the wiki most?",
 "data": {"days": "q1"},
 "text": "June 18 had the most saves: [6,543](q1#day=2026-06-18@n).",
 "program": "..."}
JSON
lean resolve "obj:saves-per-day#/days/19/n" -n 3
lean coverage
```

`lean resolve` shows the chain: the object, query q1 with its code, the 6,543 rows of revisions.jsonl, and the first of them. `lean coverage` shows that events.jsonl, labels.jsonl and pages.jsonl were not read. If they could change the answer, say so.

## Example: one agent's run in a swarm (transcripts)

The person asks: "Which agents ran the tests, and how did agent-09 do it?"

A transcript's rows are its records, one per line. The blocks of a record (its words, each tool call, each result) are `<file>#L<n>.b<k>`. Count across all runs in code, then read one run to show what the count means:

```bash
lean q "test runs per agent" <<'PY'
df = load("runs/sweep1-fable-emergent_prs/agents/*.jsonl", fields=["type", "message"])
calls = df[df.type == "assistant"].copy()
calls["cmd"] = calls.message.map(lambda m: " ".join(str(b.get("input", {}).get("command", ""))
    for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_use"))
calls["agent"] = calls._file.str.extract(r"(agent-\d+)", expand=False)
tally(calls[calls.cmd.str.contains("pytest")], "agent")
PY
lean rows "runs/sweep1-fable-emergent_prs/agents/agent-09.jsonl" --search pytest -n 3 --first
```

Then save the table with one example, and say what you read by hand:

```bash
lean save test-runs <<'JSON'
{"title": "Test runs per agent", "data": {"agents": "q2",
  "example": {"ref": "runs/sweep1-fable-emergent_prs/agents/agent-09.jsonl#L212.b1", "quote": "pytest pandas/tests"}},
 "declared": {"read": "agent-09's run from L200 to L240, around its first merge"}}
JSON
```

A label is the same move: a query that gives rows a value, by a rule or by values you wrote after reading them, and keeps it with `keep("name", values)`. A later query reads it with `use("name")`, and its lineage names the query that made that version.
