---
name: thimble
description: Use when you read, count or explain what is in files for an analyst (agent transcripts, logs, CSV or JSONL records, databases, diffs, docs). The `thimble` command keeps where each value came from, saves what you make as a card, and says what you did not read.
---

# thimble

thimble is a harness for Claude Code, a plugin for making sense of what happened in a corpus of files. Every part of it
serves one overarching goal: augment the analyst's judgment through clear communication and verifiable analyses. You
work with the `thimble` command, which you run with Bash in the folder of files. `thimble` alone lists its commands.

## Communicating

Everything you write for the analyst, in the chat or on a card, is there to serve their understanding and judgment.
They read your outputs once, quickly, in the middle of other work. Every unclear sentence and every verbose reply costs
them valuable time and attention.

- **Write for *this* analyst.** Infer what this particular person knows and what they want from all previous messages.
  Use their terminology whenever possible. Use simple, concise, straightforward language that a bright fifteen-year-old
  could follow. Write about 80% of the way to ASD-STE100 Simplified Technical English: short sentences, common words,
  one term for one thing, and one action per instruction. Write a date month first, as in "Jun 18" or "Jun 18 13:05".
  When you need a term or a concept they have not used, explain it the first time, since a name you made up or a field
  name from the data may mean nothing to them.
- **Say what you mean in literal words.** A metaphor or a flourish, such as "a smoking gun" for a decisive record or a
  "load-bearing" observation, only makes the analyst expend more cognitive effort trying to read your outputs.
- **Answer directly.** Answer the question they asked, with the one or two numbers it rests on, each with its base, as
  in "12 of the 40 runs". There is no need to mention every detail or caveat. Anything that does not change their
  understanding, such as how you worked or a restatement of the question, only delays the answer.
- **Pair a pattern with representative examples.** When describing general trends or patterns in the corpus, it is
  often useful to pair them with representative examples. However, do not provide so many examples as to overwhelm the
  analyst.
- **Keep each answer atomic.** One card or one paragraph answers one question. When something needs explaining, walk
  them through it from first principles, one step per card or paragraph, in order, so the analyst can check each step
  and see exactly where they disagree. Present one thing at a time, and ask for one thing at a time.

```
Analyst   What are most of the refund requests about?
Good      Most refund requests name one product, the X200 charger, [290](r2#product=X200@n) of all 410 refund requests
          in March and April. I defined the "product named" label [↗](r1) to classify which product each request is
          about. A typical X200 refund request reads ["stopped working after two days"](tickets/march.jsonl#L88).
Bad       The refund-intent cluster (n=410, 33.1%, 95% CI 30.5-35.7%) is dominated by the X200 signal (70.7%), peaking
          on 2026-03-14 at 09:12:07.
Bad       Most refund requests are about the X200 (290). One says "stopped working after two days."
```

The first bad reply names things the analyst never said, "refund-intent cluster" and "X200 signal", and gives six
numbers where one answers the question. The second gives a count without its base, says nothing about how the requests
were sorted, and quotes "one" without saying one of what.

## Computing and citing

The analyst never sees your shell output, so the work your answer rests on has to be where they can check it.

- **Compute every number over every record with `thimble run`.** It runs your Python over the files as a query, and
  keeps the query's code, the files it read, its output, and the records behind each output row, under an id such as
  r3. A number read off a chart, a sample or your own reading is a number the analyst cannot check. A later query reads
  an earlier one's output with `use("r3")`, so nothing is computed twice.
- **Cite each number and quote your answer rests on.** A citation opens its source in one click. Write it as a
  Markdown link whose words are the number or the quoted words, as in `[352](r3#outcome=approved@n) of the 410` or
  `["this test is flaky"](runs/41.jsonl#L88)`, and `[↗](<ref>)` when there are no words to link. Ids appear only
  inside refs: in prose, name a card by its question and a record by what it shows. When you are not sure where a
  value came from, run `thimble resolve` on it before you use it.
- **Draw a shape in a sentence only when the sentence claims one.** `[~](r3@n)` draws column `n` of r3's output in
  place. It shows a trend, a burst or a spread that the numbers alone hide. Next to a single count it takes the
  analyst's attention and shows nothing, so one in a message is the most that helps.
- **Say what you did not read.** Words such as "only", "all", "stopped", "from then on" and "then" are claims about
  every record or about order, and one record the other way makes the answer false and makes the analyst doubt the
  rest. `thimble coverage` lists what this session computed over, read, searched and never opened. When a file you did
  not read could change the answer, say so.

```
Analyst   How many refund requests were approved?
Good      [352](r3#outcome=approved@n) of the 410 refund requests were approved.
Bad       352 of the 410 refund requests were approved, see the approvals card.
Bad       352 of the 410 refund requests were approved [352](r3#outcome=approved@n).
```

A link shows its words where it stands. So the second bad answer reads "352 of the 410 refund requests were approved
352.", and the first gives the analyst nothing to open.

## Cards

A card is how you show the analyst a piece of work. Every card has three parts, the question, the content and the
takeaway. The question says what the card is for, the content shows the evidence (e.g., a chart, a table, or
representative example), and the takeaway answers the question in a sentence or two. The analyst should be able to
read the question and the takeaway in seconds and then check the takeaway against the content.

**Your cards are where your work goes, and the chat is where you talk with the analyst.** Save a card when the work is
more than a number or two, such as a chart, a table or a map, and answer a quick question that needs no computation in
the chat, without a card. thimble draws the card under your reply, so do not repeat its content in the reply.

**A card is a short program.** Save it with `thimble save NAME --from FILE`, a JSON file with the question as `title`,
the takeaway as `text` (its numbers cited), the content as `program`, and the query outputs it draws as `data`, as in
`"data": {"days": "r1"}`. A part drawn from a row of that data opens the records behind it when the analyst selects
it. The parts are in `../../draw/TOOLKIT.md` from this skill's folder: read it before your first card. thimble adds
its card guidance beside your first data command. `thimble save` checks each citation and binding and lists each
problem: fix it and save again under the same name. When you read or judged records in a way no tool saw, say so under
`declared`.

## Labels

A label is a semantic category derived from the records by a classifier, such as "asks for a refund". `thimble label
NAME --in GLOB` defines it and applies it to every record of that scope. Its predicate decides each record in one of
three ways: `--regex` matches the text, `--code` is a Python function that returns a value and a confidence, and
`--prompt` has a model judge each record against your definition. The result is a count per value and a label card,
where the analyst reads the definition, opens the records of each value and checks a sample. What they say a record is
counts in place of the label's value.

**Whenever you sort records into categories, use `thimble label`.** It runs many model calls in parallel, so the answer
reaches the analyst quickly, and it applies the category to exactly the scope you give it. The analyst can inspect the
definition and its records, while a category made inside your own code reads to them as a fact they cannot check.

**Use a regex or code when matching is enough, and a prompt for judgment.** Write a prompt's definition as one or two
sentences that two careful readers would apply the same way. Give values the analyst would recognize, with the
positive one first (`--values`). Try a new label on a few records with `--limit`, read them with `thimble rows GLOB
--label NAME=VALUE`, and make sure it also catches other ways of saying or doing the same thing, before you run it on
everything. A takeaway that counts by a label names it and says whether a rule or a model made it. In a query,
`use("NAME")` gives each record's `_ref` and value.

**Once a label defines an outcome, use that definition everywhere.** Decide each outcome by what the analyst asked
about: a command that exits with 0 has only run. Two definitions give the analyst two answers to one question and
leave them unsure of both.

```
Analyst   What do customers complain about?
Good      1  thimble rows "tickets/*.jsonl" -n 25, to see how customers describe what went wrong
          2  thimble label complaint --in "tickets/*.jsonl" --values broken,late,billing,other --limit 25
               --prompt "The main thing the customer is unhappy about."
          3  reads the 25, sees late deliveries with a wrong charge split between late and billing, and makes the
             definition exact: "... late means the order came after the promised date or never came. billing means a
             charge, a refund amount or an invoice is wrong. When both happened, choose billing."
          4  the label again with the new definition and no --limit, then thimble label complaint --wait
          5  Most complaints are about a broken product, [1,210](r4#complaint=broken@n) of the 4,120 tickets. I sorted
             the tickets with a label, "complaint", in which a model reads each ticket and picks its main complaint.
Bad       1  a query with cats = {"broken": "broke|defect", "late": "late|delay", "billing": "charge|refund|invoice"}
          2  Most complaints are about billing, 1,871 of the 4,120 tickets.
```

The bad answer counts a ticket under every category whose words it contains, and the analyst cannot see the rule that
made the count.

## Example

```bash
thimble sources
thimble run "saves per day" <<'PY'
df = load("revisions.jsonl", fields=["time", "label"])
df["day"] = df.time.str[:10]
tally(df, "day")
PY
thimble save saves-per-day --from card.json
thimble resolve "obj:saves-per-day#/days/19/n" -n 3
thimble coverage
```

`tally(df, by)` counts and keeps each group's records. `thimble resolve` shows a value's chain: the card, r1 with its
code, the 6,543 records of revisions.jsonl, and the first of them. In a transcript each record is one line, and its
blocks (its words, each tool call, each result) are `<file>#L<n>.b<k>`.
