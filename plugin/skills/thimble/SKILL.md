---
name: thimble
description: Use when you read, count or explain what is in files for an analyst, such as agent transcripts, logs, CSV or JSONL records, databases, code, diffs and docs. The `thimble` command keeps where each value came from, saves what you make as a card, and says what you did not read.
---

# thimble

thimble is a Claude Code plugin for making sense of a folder of files, such as agent transcripts, logs, records, code and docs. Its goal is to help the analyst judge what happened, with answers that are clear and that they can check. It gives you four features.

- **Queries** keep the code and the records behind every number you compute.
- **Citations** link a number, a quote or a line of code to its source, which the analyst opens in one click.
- **Cards** show a finding as a chart, a table or a diagram under your reply.
- **Labels** sort records into categories that the analyst can inspect and correct.

You use them through the `thimble` command, which you run with Bash in the folder of files. The last section describes its commands.

## Communicating

The analyst reads your replies once, quickly, in the middle of other work. Three principles help them most.

**Write for this analyst.** Infer from their messages what they know, what they want and what they will ask next, and shape your answer for them. Use their words. When you need a term they have not used, such as a field name or a name you made up, explain it the first time.

**Answer directly.** Start with the answer to the question they asked, in plain and literal words. Leave out what does not change their understanding, such as how you worked, a restatement of the question, or a caveat that does not change the conclusion. Write about 80% of the way to ASD-STE100 Simplified Technical English, with short sentences, common words and one term for one thing.

**An example can make a pattern concrete.** When counts alone would leave the analyst unsure what the records behind a pattern look like, one representative record, quoted and cited, can show them. A short factual answer needs none.

```
Analyst   What are most of the refund requests about?
Good      Most refund requests name one product, the X200 charger, [290](r2#product=X200@n) of all 410 refund requests
          in March and April. I sorted the requests by [the product each one names](r1). A typical X200 refund request
          reads ["stopped working after two days"](tickets/march.jsonl#L88).
Bad       The refund-intent cluster (n=410, 33.1%, 95% CI 30.5-35.7%) is dominated by the X200 signal (70.7%), peaking
          on 2026-03-14 at 09:12:07.
Bad       Most refund requests are about the X200 (290). One says "stopped working after two days."
```

The first bad reply uses words the analyst never used and gives six numbers where one answers the question. The second gives a count without its base and quotes "one" without saying one of what.

## Citing

The analyst never sees your shell output, so cite what your answer rests on. A citation opens its source in one click, and the analyst can check a claim without asking you. Put the link on the words of the claim itself.

- A number links to its value in a query's result, as in `[352](r3#outcome=approved@n) of the 410`, which points at column n of the line where outcome is approved in the result of query r3. Compute every number you cite with `thimble run` over every record, so that its citation opens the records behind it.
- A quote or a record links to its line in the file, as in `["this test is flaky"](runs/41.jsonl#L88)`. In a transcript, one block of a line (its words, a tool call or a result) is `#L88.b2`.
- Code links to its lines, as in `[drops the session after 30 seconds](server/auth.py#L88-94)`.
- A shape links to a column of a query, as in `[~](r3@n)`, which draws that column in place. Use it when the sentence claims a trend, a burst or a spread that the numbers alone hide, and at most once in a message.

Name cards and records by what they show, not by their ids.

```
Analyst   How many refund requests were approved?
Good      [352](r3#outcome=approved@n) of the 410 refund requests were approved.
Bad       352 of the 410 refund requests were approved [352](r3#outcome=approved@n).

Analyst   Why do some users get logged out after a few minutes?
Good      The check that ends a session [reads the timeout as seconds](server/auth.py#L88-94), but the setting
          [gives it in minutes](config/app.yaml#L12), so a 30-minute timeout ends after 30 seconds.
Bad       The bug is in [server/auth.py:88](server/auth.py#L88) and [config/app.yaml:12](config/app.yaml#L12).
```

A link shows its words where it stands, so the first bad answer reads "were approved 352." The second links two places without saying what either one shows.

## Cards

Some answers are much faster to see than to read, such as a pattern, a comparison, a sequence or how parts connect. Show such an answer in a card, as a chart, a table or a diagram, without being asked. Answer a question that a number or two settles in the chat, without a card. thimble draws the card under your reply, so do not repeat its content there.

A card is a short program that draws from your query outputs, and each part of it opens the records behind it. A card can combine several parts, such as a chart beside the records that explain it, and it can be interactive, with a knob the analyst turns or a key that changes what it shows. The card guide documents the toolkit and has a few examples. thimble gives it to you beside your first data command.

## Labels

A label sorts the records of a scope into a few values, such as whether a ticket asks for money back. The analyst can read its definition, open the records of each value and correct a record. When you sort records into categories, use a label, because a category made inside your own code reads to the analyst as a fact they cannot check.

Use a rule (a regex or code) when matching decides the value, and a model (a prompt) when it takes judgment. Make sure a rule also catches other ways of saying or doing the same thing. Write a model's definition as one or two sentences that two careful readers would apply the same way, and try it on a few records first. Once a label defines an outcome, use it everywhere, so the analyst gets one answer to one question.

```
Analyst   How many tickets ask for money back?
Good      1  thimble label refund --in "tickets/*.jsonl" --regex "refund|money back|chargeback|reimburse"
          2  thimble rows "tickets/*.jsonl" --label refund=no --search "back|return" -n 10, to find requests the rule
             missed
          3  [612](r4#refund=yes@n) of the 4,120 tickets ask for money back. I found them with a label, "refund", a
             rule that matches words such as "refund", "money back" and "chargeback".
Bad       1  a query that counts the tickets whose text holds "refund"
          2  540 of the 4,120 tickets ask for a refund.
```

The bad answer misses the tickets that ask for money back without the word "refund", and the analyst cannot see the rule behind the count.

## The thimble command

`thimble` alone lists its commands.

- `thimble run "ABOUT"` runs the Python you give it on stdin over the files, as a query. It keeps the code, the files it read, its output and the records behind each line of its result, under an id such as r3. The query's output is the value of its last line, such as `tally(df, "day")`. You see what it prints, but a card cannot draw that. In a query, `load(file, fields=[...])` reads a file, `tally(df, by)` counts and keeps each group's records, `use("r3")` reads an earlier query's output so nothing is computed twice, and `use("NAME")` gives a label's value and `_ref` for each record.
- `thimble rows` lists the files and the saved cards. With a file it shows rows, which `--where`, `--search`, `--label NAME=VALUE` and `-n` narrow. With a ref it shows that row, or a value's chain down to its records. Use it when you are not sure where a value came from.
- `thimble save NAME --from FILE` saves a card. The card guide describes the file.
- `thimble label NAME --in GLOB` defines a label and applies it, with one of `--regex RE`, `--code FILE` (a Python `label(unit)` that returns a value, or a value and a confidence) or `--prompt "DEFINITION"`. `--values` gives the values, the positive first. `--limit N` tries it on N records, and the same command without `--limit` labels the rest. A prompt label makes a model call for each 50 records, so try it with `--limit` first, and use `thimble label NAME --wait` to wait for its calls. When the analyst corrects a record, their value counts in place of the label's.
- `thimble coverage` lists the files whose lines you saw and the files you only computed over, searched or never touched.
- `thimble fix` changes thimble itself. Use it when the analyst asks you to fix or change thimble, or to report a problem with it (a failure line's f and F ask for this too). `thimble fix new "TITLE"` makes a copy of thimble in a worktree and prints its path; work there, never in the data folder. Reproduce the problem first on made-up data with the same shape: a CSV of 4 rows with `;` between its fields, not the analyst's file. Run the plugin's tests in the worktree, then `thimble fix use SLUG` loads the fix into the analyst's thimble. To share it, write the issue in thimble's own terms and give it to `thimble fix draft SLUG --from FILE`. The draft can go public, so it holds no file contents, names, paths or values from the analyst's session; the analyst reads the exact text before anything is sent. `--kind report` writes an issue with no change. The analyst may ask for a change in plain words ("thimble should show …") or with `/thimble:fix`: both are this same flow.

```bash
thimble rows
thimble run "saves per day" <<'PY'
df = load("revisions.jsonl", fields=["time", "label"])
df["day"] = df.time.str[:10]
tally(df, "day")
PY
thimble save saves-per-day --from card.json
thimble rows "obj:saves-per-day#/days/19/n" -n 3
```

The last command follows a value of the card down to its records: the card, r1 with its code, the 6,543 records of revisions.jsonl behind that day, and the first three of them.
