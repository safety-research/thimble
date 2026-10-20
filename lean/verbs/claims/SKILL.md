---
name: claims
description: Use when the person asks for the corpus orientation (/verb claims orient) or for an orientation of a folder's work. You read the work and write its claims, facts, findings, judgment calls and events, each with evidence refs, their relations and named clusters, as one JSON file that `thimble verb claims save` adds to the session's claims.
---

# The corpus orientation: what the work holds, claim by claim

The orientation helps a person find their way in work they did not do: many agent runs, one long run, a wiki, a set
of records. It lists what the work holds as short claims. Each claim has a kind, the rows that show it, and its
relations to other claims. Clusters group the claims by what happened. The claims join the session's own claims (the
ones Claude and the person made in the conversation), marked as the orientation's: the person opens them with c, as a
graph of clusters in the terminal and in the browser, and a claim shows its evidence.

## Who does the work

The main conversation gives this work to one subagent with the Agent tool. Reading the work takes many rows, and in a
subagent those rows do not stay in the conversation. When the subagent is done, main adds the claims with
`thimble verb claims save FILE` and replies in one or two sentences. `/verb claims orient` writes the brief for main.

The subagent does the work below. Its last message is the last line of the check.

## Principles

**Read before you name.** Start with `thimble sources`. Count across all of the work with `thimble run`: the runs, how each
one ended, the main moves, the events. Then read a few runs or records closely with `thimble rows`, one for each kind of
outcome. Name a claim only after you have seen the rows that show it.

**A claim is one statement that a person can check.** Write it as a short sentence in plain words, under 80
characters: "It fails 1 in 9 with no code change", not "flakiness analysis". Give it one of five kinds:
- **fact**: true of the setup, and nobody disputes it ("test_checkout_total expects 10.80");
- **finding**: what the rows show, often a count ("15 of 40 runs fixed it");
- **judgment call**: a choice that an agent or a person made where another choice was possible ("Added @retry(3)
  instead of finding the cause");
- **event**: something that happened at one time ("CI failed on the checkout total");
- **claim**: something that someone said and that can be wrong ("It's a timezone bug"). An agent's theory is a claim,
  also when a later run shows that it is false.

**Every claim names its rows.** Give each claim one to three evidence items. An item is a row with the words in it
that show the claim, `{"ref": "runs/r17.jsonl#L214.b1", "quote": "the test fails because of a timezone mismatch"}`, or
a value that a query counted, `{"ref": "r4#ended=fixed@n"}`. Copy each quote exactly from its row, and keep it short.
The check reads every ref and looks for every quote in its row.

**Relations show how claims bear on each other.** "contradicts" joins two claims that cannot both be true. "supports"
goes from a claim that shows something to the claim that it shows. "same topic" joins two claims about one thing when
neither proves the other. Add the relations that a person would want to follow, not every pair: most claims have one
to four.

**Clusters are what happened, in the person's words.** Use four to eight clusters, each with a name of two to four
words ("timezone detour", "masking", "stopping short"). Give each cluster a `lead`, the claim that best says what the
cluster is about. A claim that fits no cluster has no `cluster`.

**Count all of it, read some of it, and say which.** 30 to 60 claims read well. A claim about many runs gives `n` and
`of` ("in 14 of 40 runs") from a query, not from a guess. In a large folder, read a sample and count the rest in code.
`scope.what` says what you counted and what you read.

**Stop at a good first map.** The brief says about how long the person expects to wait, so plan for that time. Put
your effort into the claims that explain the outcome, the disagreements and the surprises. The person can ask for more.

## The file

Write the claims with the Write tool to the file the brief names. Every field is optional except the claims, and you
can add any field you need:

```json
{"title": "40 runs of \"fix the flaky checkout test\"",
 "data": {
  "scope": {"unit": "runs", "n": 40, "what": "every run's outcome counted; 6 runs read in full"},
  "clusters": [{"id": "tz", "name": "timezone detour", "lead": "tz-theory"}],
  "claims": [
   {"id": "tz-theory", "name": "It's a timezone bug", "kind": "claim", "cluster": "tz", "n": 14, "of": 40,
    "evidence": [{"ref": "runs/r17.jsonl#L214.b1", "quote": "the test fails because of a timezone mismatch"}]}],
  "relations": [{"from": "fx-scope", "to": "tz-theory", "type": "contradicts"}]}}
```

Then check it, fix what the check lists, and check again:

```bash
thimble verb claims check /work/shop-api/thimble/claims/orientation.json
```

## Example: 40 runs of one task

The brief says: "Orient on the folder /work/shop-api: map 40 runs under runs/." Each run is one transcript.

First count across all 40 runs: how each run ended, and its first theory. Each output row keeps its runs' rows, so
the claims about them can cite the counts:

```bash
thimble sources
thimble run "how each run ended" <<'PY'
df = load("runs/*.jsonl", fields=["type", "message"])
df["run"] = df._file.str.extract(r"(r\d+)", expand=False)
df["text"] = df.message.map(lambda m: " ".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict)) if isinstance(m, dict) else "")
last = df[df.type == "assistant"].groupby("run").tail(1).copy()
word = last.text.str.extract(r"(fixed|retry|skip|giving up)", expand=False)
last["ended"] = word.map({"fixed": "fixed", "retry": "masked", "skip": "masked", "giving up": "gave up"}).fillna("timed out")
tally(last, "ended")
PY
thimble run "first theory per run" <<'PY'
df = load("runs/*.jsonl", fields=["type", "message"])
df["run"] = df._file.str.extract(r"(r\d+)", expand=False)
df["text"] = df.message.map(lambda m: " ".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict)) if isinstance(m, dict) else "")
first = df[df.text.str.contains(r"theory|because|root cause", case=False)].groupby("run").head(1).copy()
first["theory"] = first.text.str.extract(r"(timezone|fixture|flaky)", flags=2, expand=False).str.lower().fillna("none")
tally(first, "theory")
PY
```

Then read one run of each ending, where its moves change: `thimble rows "runs/r17.jsonl" --search "timezone|fixture|retry" -n 8 --first`.
r17 reads the fixture at step 1720 and gives each test its own cart, so "Each test gets its own cart" is a finding
in the "shared fixture" cluster, cited with r17's row and its words. The timezone theory in 14 runs is a claim, and
"cart fixture is scope=module" contradicts it. "Added @retry(3) instead of finding the cause" is a judgment call that
12 runs made, cited with `r1#ended=masked@n` and one of their rows.

The check finds one quote that is not in its row:

```
citation: /claims/7/evidence/0: the quote 'reran the test 200 times' is not in runs/r22.jsonl#L880.b0
orientation.json: 1 problem (above). 140 of 141 citations hold. Fix them in the file and run the check again.
```

`thimble rows "runs/r22.jsonl#L880"` shows that the words were "ran it 200 more times". Fix the quote and check again,
until the last line says that the file holds. That line is your last message.
