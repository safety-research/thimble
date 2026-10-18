---
name: squeeze
description: Make a long text shorter on the dimensions that matter for this text and this reader, with each squeezed line tied to the spans of the original it came from. Use when the person asks for a shorter, simpler or more focused version of a reply, a report, a run's summary or an answer about data.
---

# Squeeze

A squeeze is a short version of something long: a reply, a report, a summary of an agent's run, an answer about a dataset. The person reads the squeezed version first. The original stays one key away, and each squeezed line leads back to the sentences it came from.

The original comes cut into numbered spans: `[3.2]` is the second sentence of the third paragraph (or item, heading, row). You choose the dimensions, write a few versions, and say for each line which spans it came from.

## Principles

**Choose the dimensions for this text.** Length is often one of them, but ask what a reader of THIS text would want to turn up or down. Some examples: the story of how the work went, the background a newcomer needs, which agents or runs, how much of the numbers, the decisions that wait on the person. Choose one to three. Name each one in the reader's words, give its levels from most squeezed to fullest, and say in one line why it matters here. Do not add a dimension that the text has nothing behind.

**Put first the dimension that makes it shorter.** "Shorter" and "fuller" move along it. The other dimensions change what the version is about, not only its size.

**Keep the promise of a level's name.** If a level is called "one line", write one line. If it is called "headline", write one sentence. A short version of 6 long lines is not short. One idea goes in each line, in about 25 words or fewer.

**Start with what the person needs to act on.** The first line answers the question that was asked: what happened, what was found, or what needs a decision. Keep the numbers, the names and the outcome. Leave out the path to the outcome, unless the path is the point.

**Say nothing that the original does not say.** A squeezed line can merge, reorder and shorten. It cannot add. Every number, name and claim in it must be in the spans it cites. If a shorter wording would need a new claim (a total nobody computed, a "most" nobody counted), keep the longer wording.

**Keep the hedges.** "About", "in the sample", "2 of 3 runs", "I did not read the other files": if the original says it, the squeeze keeps it. A dropped hedge changes the claim.

**Cite every span a line uses.** Put each span a line came from in `from`, not only the first. This link lets the person check a line against the original and see what a version dropped.

**Name what you leave out.** Each version names what it dropped, in a few words for each part ("the three theories it tried", "counts per agent"), with the spans. The person sees these names and can bring back any part.

**Write plain lines.** Use short sentences and the original's own terms. Put identifiers in `code`. Do not put headings or bullets in a line.

## Example 1: an agent's report on a code change

The person asked: "test_checkout_total fails on CI now and then. Find out why and fix it." The report has 41 lines in 6 parts: the headline, the root cause, the fix with its diff, the checks, the debugging story and the decisions that are still open.

Dimensions chosen:
- `length`: one line, short, most of it. Why: a run of 2,143 steps needs a one-line answer and also a full account.
- `story`: hidden, in brief. Why: most of the run was a detour, so the story is optional.

The version shown first, at `{"length": 1, "story": 0}`:

```json
{"lines": [
  {"text": "Fixed: `test_checkout_total` and `test_apply_coupon` shared one module-scoped `cart` fixture, so a coupon could leak into the total.", "from": ["1.1", "2.1-2.3"]},
  {"text": "The fix is one line in `tests/conftest.py`; 200 runs in a row pass.", "from": ["3.1", "4.1"]},
  {"text": "Open: merge it, and say whether the date-helper revert should stay.", "from": ["6.1-6.2"]}],
 "out": [{"what": "the three theories it tried", "from": ["5.1-5.6"]}, {"what": "the diff", "from": ["3.2"]}]}
```

## Example 2: an answer about a dataset

The person asked: "How did activity in the support logs change after the March release?" The answer has 30 lines. It has counts per week, per team and per kind of ticket, and it says that one of the four log files was not read.

Dimensions chosen:
- `length`: the finding, the finding with its numbers.
- `scope`: overall, per team. Why: the overall trend hides that one team's tickets doubled.

The version shown first, at `{"length": 0, "scope": 0}`:

```json
{"lines": [
  {"text": "Tickets rose from about 310 to 520 a week after the release, mostly login errors.", "from": ["1.1", "2.3", "3.1"]},
  {"text": "This rests on 3 of the 4 log files; `archive.jsonl` was not read.", "from": ["7.1"]}],
 "out": [{"what": "the weekly counts", "from": ["2.1-2.6"]}, {"what": "the per-team split", "from": ["4.1-5.3"]}]}
```

The second line stays in even the shortest version, because without it the first line claims more than was read.

## When you are main

Usually the person presses `s`, and a quiet call writes the squeeze with this page as its guide. When the person asks for a squeeze in words, write the same JSON yourself (the dimensions, `first`, and the versions), save it to a file, and run `lean verb squeeze <original> --from <file>`. Use `lean verb squeeze <original>` alone to see the spans and their ids first. The command checks each line's spans and numbers, and it draws the result for the person.
