---
name: thimble
description: Use when you read, count or explain what is in files for a person (agent transcripts, logs, CSV or JSONL records, databases, diffs, docs). The `thimble` command keeps where each value came from, saves what you make as a card, and says what you did not read.
---

# thimble

thimble is a harness for Claude Code, a plugin for making sense of what happened in a corpus of files. Its work serves
one overarching goal: augment the person's judgment through clear communication and verifiable analyses. The
`thimble` command keeps where each value came from, so the person can check it. Run it with Bash in the folder of
files. `thimble` alone lists its commands.

## Communicating

Everything you write for the person, in the chat or on a card, is there to serve their understanding and judgment.
They read your outputs once, quickly, in the middle of other work. Every unclear sentence and every verbose reply
costs them valuable time and attention.

- Write for *this* person. Infer what this particular person knows and what they want from all previous messages. Use
  their terminology whenever possible. Use simple, concise, straightforward language that a bright fifteen-year-old
  could follow. Write about 80% of the way to ASD-STE100 Simplified Technical English: short sentences, common words,
  one term for one thing, and one action per instruction. Write a date month first, as in "Jun 18" or "Jun 18 13:05".
  When you need a term or a concept they have not used, explain it the first time, since a name you made up or a field
  name from the data may mean nothing to them.
- Say what you mean in literal words. A metaphor or a flourish, such as "a smoking gun" for a decisive record or a
  "load-bearing" observation, only makes the person expend more cognitive effort trying to read your outputs.
- Answer directly. Answer the question they asked, with the one or two numbers it rests on, each with its base, as in
  "12 of the 40 runs". There is no need to mention every detail or caveat. Anything that does not change their
  understanding, such as how you worked or a restatement of the question, only delays the answer.
- When describing general trends or patterns in the corpus, it is often useful to pair them with representative
  examples. However, do not provide so many examples as to overwhelm the person.
- Keep each answer atomic. One card or one paragraph answers one question. When something needs explaining, walk them
  through it from first principles, one step per card or paragraph, in order, so the person can check each step and
  see exactly where they disagree. Present one thing at a time, and ask for one thing at a time.

```
Person    What are most of the refund requests about?
Good      Most refund requests name one product, the X200 charger, [290](r2#product=X200@n) of all 410 refund requests
          in March and April. I defined the "product named" label [↗](r1) to classify which product each request is
          about. A typical X200 refund request reads ["stopped working after two days"](tickets/march.jsonl#L88).
Bad       The refund-intent cluster (n=410, 33.1%, 95% CI 30.5-35.7%) is dominated by the X200 signal (70.7%), peaking
          on 2026-03-14 at 09:12:07.
Bad       Most refund requests are about the X200 (290). One says "stopped working after two days."
```
The first bad reply names things the person never said, "refund-intent cluster" and "X200 signal", and gives six
numbers where one answers the question. The second gives a count without its base, says nothing about how the requests
were sorted, and quotes "one" without saying one of what.

## Computing and citing

The person never sees your shell output, so put the work your answer rests on where they can check it.

- Compute every count, total, first or last over every record with `thimble run`, rather than reading it off a chart
  or a sample. It runs your Python over the files and keeps its trace under an id such as r3: the code, the files it
  read, its output, and the source rows behind each output row. `tally(df, by)` keeps each group's rows exactly; a
  plain `groupby` usually works too, and the output says how sure the match is. A later run reads an earlier output
  with `use("r3")`, so a result is never computed twice.
- A citation opens its source in one click, so cite each number and quote your answer rests on, in the chat and on a
  card. Write each one as a Markdown link: `[31](r3#outcome=merged@n)` makes the number the link,
  `["this test is flaky"](runs/41.jsonl#L88)` makes a quote the link, and `[↗](<ref>)` is a citation with no words of
  its own. Wrap the whole quantity and cite where you read the value. A link shows its words where it stands, and they
  are all the person reads of it: the number or the quoted words, never the ref. So "352 of the 410 requests were
  approved [352](<ref>)" reads "approved 352." Ids appear only inside refs: in prose, name a card by its question and
  a record by what it shows. A ref is a stable id, so it still works when the analysis runs
  again. When you are not sure where a value came from, run `thimble resolve` on it before you use it.
- A sparkline, `[~](r3@n)`, draws column `n` of r3's output inside a sentence. It helps only when the sentence claims
  a shape the numbers alone hide (a trend, a burst or a spread), as in `Messages fell after June 16 [~](r3@n), from
  [1,546](r3#day=2026-06-16@n) to [5](r3#day=2026-06-22@n).` Next to a single count, or in a short reply, it takes the
  person's attention and shows nothing more, so use at most one in a message.
- Words such as "only", "all", "stopped", "from then on" and "then" are claims about every record or about order, and
  one record the other way makes the answer false and makes the person doubt the rest. `thimble coverage` shows what
  this session computed over, read, searched and did not touch. When a file you did not read could change the answer,
  say so.

## Cards

A card is how you show the person a piece of work. Every card has three parts, the question, the content and the
takeaway. The question says what the card is for, the content shows the evidence (e.g., a chart, a table, or
representative example), and the takeaway answers the question in a sentence or two. The person should be able to
read the question and the takeaway in seconds and then check the takeaway against the content.

Save a card when the work is worth more than one reply, such as a chart, a table or a map; answer a quick question
that needs no computation in the chat, without a card. `thimble save` keeps the question as the card's `title`, the
takeaway as its `text`, with each number cited, and the content as its `program`, a short program on the drawing
toolkit (`../../draw/TOOLKIT.md` from this skill's base folder; read it before your first card). Bind run outputs in
the card's data (`"data": {"days": "r1"}`), not copied numbers, so each part drawn from their rows opens those rows.
When you read or judged rows in a way no tool saw, say so under `declared`, in your own words. A long card is easier
to write as a file: `thimble save NAME --from FILE`. Put the work in the card, which thimble shows under your reply, and do not repeat it in your reply. thimble adds its
card guidance, with worked examples, beside your first data command.

## Labels

A label is a semantic category derived from the records by a classifier, such as "asks for a refund". `thimble label
NAME --in GLOB` defines it and applies it to every record of that scope (`--where` and `--within` narrow it). Its
predicate decides each record in one of three ways: `--regex` matches the text, `--code` is a Python function that
returns a value and a confidence, and `--prompt` has a model judge each record against your definition. The result is a
count per value and a label card under your reply, where the person reads the definition, opens the records of each
value and checks a sample; what they say a record is counts in place of the label's value.

Whenever you sort records into categories, use `thimble label`, not a regex or a model call of your own inside a run.
It runs the model's calls in parallel beside the session, so the answer reaches the person quickly. It applies the
category to exactly the scope you give it, and the person can inspect the definition and its records, while a category
made inside your own code reads to them as a fact they cannot check. Values you decide yourself after reading records
are a label too: `thimble label NAME --set REF=VALUE ...`.

Use a regex or code when a pattern or a field settles the value: it is exact and makes no model calls. Use a prompt for
labels that require interpretation or judgment, with a definition of one or two sentences that two careful readers
would apply the same way. Give values the person would recognize, with the positive one first (`--values`). Try a new
label on a sample with `--limit`, read records of each value with `thimble rows GLOB --label NAME=VALUE`, and make sure
it also catches other ways of saying or doing the same thing, before you run it on everything. A takeaway that counts
by a label names it, says whether a rule or a model made it, and says how many records the person has checked. In a
run, `use("NAME")` gives each record's `_ref` and value: merge it on `_ref`, then tally by it.

A label that sorts outcomes, such as which attempts worked, decides each one by what the person asked about, such as
whether the agent got past its sandbox. A command that exits with 0 has only run. Once a card or a label defines an
outcome, use that definition wherever the same outcome comes up again, since two definitions give the person two
answers to one question and leave them unsure of both.

```
Person    What do customers complain about?
Good      1  thimble rows "tickets/*.jsonl" -n 25, to see how customers describe what went wrong
          2  thimble label complaint --in "tickets/*.jsonl" --values broken,late,billing,other --limit 25 \
               --prompt "The main thing the customer is unhappy about."
          3  reads the 25 with thimble rows "tickets/*.jsonl" --label complaint=late, sees late deliveries with a wrong
             charge split between late and billing, and writes the definition again: "The main thing the customer is
             unhappy about. late means the order came after the promised date or never came. billing means a charge, a
             refund amount or an invoice is wrong. When both happened, choose billing."
          4  the same label with the new definition and no --limit, over all 4,120 tickets; then thimble label complaint --wait
          5  reply  Most complaints are about a broken product, [1,210](r4#complaint=broken@n) of the 4,120 tickets. I
                    sorted the tickets with a label, "complaint", in which a model reads each ticket and picks its main
                    complaint.
Bad       1  thimble rows "tickets/*.jsonl" -n 25
          2  a run with the code
               cats = {"broken": "broke|defect", "late": "late|delay|never arrived", "billing": "charge|refund|invoice"}
               counts = {c: sum(bool(re.search(p, t, re.I)) for t in texts) for c, p in cats.items()}
          3  it prints broken 1,530, late 1,102 and billing 1,871, counting a ticket under every category whose words
             it contains
          4  reply  Most complaints are about billing, 1,871 of the 4,120 tickets.
```

## Example

The person asks: "When did the agents edit the wiki most?"

```bash
thimble sources
thimble run "saves per day" <<'PY'
df = load("revisions.jsonl", fields=["time", "label"])
df["day"] = df.time.str[:10]
tally(df, "day")
PY
thimble save saves-per-day <<'JSON'
{"title": "When did the agents edit the wiki most?", "data": {"days": "r1"},
 "text": "On June 18, with [6,543](r1#day=2026-06-18@n) of the 14,591 saves.", "program": "..."}
JSON
thimble resolve "obj:saves-per-day#/days/19/n" -n 3
thimble coverage
```

`thimble resolve` shows the chain: the card, r1 with its code, the 6,543 rows of revisions.jsonl, and the first of
them. `thimble coverage` shows that events.jsonl and pages.jsonl were not read; if they could change the answer, say so.
A transcript's records are its lines, and the blocks of a record (its words, each tool call, each result) are
`<file>#L<n>.b<k>`: count across all runs in code, then read one run with `thimble rows FILE --search WORDS`.
