# Repository

thimble's worked example of a view over several agent teams' runs on one library, read as a code forge shows them
(plugin/viewers/repository), ported to the mod: sample/ and labels.json are thimble's; reader.py is thimble's with the
`rows` query added; view.json is the terminal spec (views/SPEC.md) and rows.json the runner's output on the sample. This
file says what thimble's HTML view shows and how the terminal view draws each part of it.

## The data and the reader on its sample

`python3 helper/viewhost.py viewers/repository shown --root viewers/repository/sample`

| | |
|---|---|
| claimed files (`runs/*.json`, `runs/*.jsonl`, `runs/*.csv`) | 31, 77,256 bytes, every one read to the end |
| problems | 1 unreadable line: `runs/r4/events.jsonl#L70`, not a JSON object (cut off when the run stopped) |
| hidden files | none |
| derived fields declared in view.json | 45 (runs 7, pull requests 16, issues 11, discussions 2, agents 5, events 4) |
| runs | 4: r1 and r2 write events.jsonl, r3 an export (CSV tables and reviews.json), r4 events.jsonl in schema 2 |
| units | 35 pull requests, 36 issues, 12 discussions, 16 agents |
| pull requests by state | merged 28, closed 4, open 3 |
| pull requests by area | parser 10, schedules 9, durations 7, docs 5, formatting 4 |
| flags | merged by its author 19, pushed after its last approval 3, waiting for approvals 3, merged over a change request 1 |
| issues by state / origin | fixed 28, open 8 / backlog 32, found during the run 4 |
| per run (agents · approvals, merged of opened, median hours to merge) | r1 3 · 1, 7 of 8, 22m · r2 3 · 2, 5 of 7, 1h 07m · r3 5 · 1, 9 of 11, 16m · r4 5 · 2, 7 of 9, 1h 02m |
| labels on (Clock change, Tests), pull requests tab | clock change 11, tests 11, no label 150 records |
| label filter Clock change | 6 pull requests, 6 issues, 1 discussion, 8 agents |
| one pull request (r3 #15) | 4 records: opened, pushed (1 commit, +1 −3 in brindle/schedules.py), approved, merged |

The index builds in about 30 ms. thimble's screenshot of an earlier sample showed Clock change 10, Tests 11, no label
151; the mod's labels read a CSV row whole, as thimble's do.

## What thimble's HTML view shows

- **Head.** A Runs menu (one run, several, or All runs) and Combined | Compare. Tabs with counts: Pull requests 35,
  Issues 36, Discussions 12, Agents 16. Above the view thimble draws `31 files · 1 line could not be read`.
- **Runs panel.** A table with a row per run: RUN, SETUP (`3 agents · 1 approval`), the tab's measure as a bar
  (`7 of 8` merged) and TO MERGE (median). A click on a row picks that run, as a legend does.
- **Activity panel.** Records per 10 minutes over hours since each run started, stacked by the colour field (the
  action by default) or by the label values that are on, with a Colour menu and its legend.
- **Filters.** Search, then the tab's dropdowns: Author, Reviewer, Review, Participant, Activity, Area, Close reason,
  Flag on pull requests; each takes one value or several and lists the count each value would give.
- **List (overview).** The forge's list: a state switch (`35 All · 3 Open · 28 Merged · 4 Closed`), Sort, then one row
  per unit: state icon, title, run chip, area label, label pills for the label values that mark its records,
  `#15 opened by elm · open for 1h 53m · closes #8`, flag chips, the diff size (`+1 −0` and five blocks), reviewer
  avatars with their latest verdict, a strip of the unit's records on the run's time axis, and the comment count.
- **A unit's page (zoom and details).** A pull request opens beside or in place of the list: title and number, a
  state pill and `gale merged 1 commit 5m after gale opened this`, the run's setup chip. Tabs Conversation, Commits,
  Files changed (and Raw). The conversation is a time-ordered thread: an author box per opening, comment, review and
  post, one-line entries for pushes and merges, each with its time since the run started (`+1:04`) and a file chip that
  opens the cited line. The side column: Reviewers with their verdicts, Labels, Closes (the issue, linked), Timing
  (opened, first review, merged, commits, changed), Flags, and the same issue in every other run. Commits list each
  commit with author, message and size; Files changed shows the unified diffs per file with old and new line numbers.
  An issue's page shows its comments and the pull requests that fix it; a discussion every post; an agent its sign-off
  note, its activity and its review partners.
- **Compare.** Pull requests or issues issue by issue: a row per backlog issue, a column per run, each cell the run's
  pull requests for it with state and time to merge. Discussions and agents compare run by run; the Agents tab adds a
  review-partner matrix per run (who reviewed whose pull requests, approvals shaded, change requests counted).
- **Labels.** Each unit carries `view:repository/<key>` and each record its file ref; a unit whose records a label
  marks shows the label's pill. The Colour menu turns labels on and off (the analyst only) and colours the activity and
  the strips by them.

## The terminal view

`records(index, {"op": "rows"})` gives 4 `runs`, the units as thimble keys them (35 `pulls`, 36 `issues`, 12
`discussions`, 16 `agents`) and 330 `events`, the records of their stories, each a line "what it did: its words" (a
push with its size and diff). Every unit carries `issue`, the backlog issue it is about (the same in every run),
`twins`, the same unit in the other runs, and `refs`, the lines it gathers, so the label Clock change keeps 6 pull
requests, 6 issues, 1 discussion and 8 agents, as in thimble. A pull request's and an issue's `line` is the forge's
line under its title, short (`#15 by elm · open for 1h 53m · closes #8`), its flags drawn beside it as chips. An issue's story
holds the merge that fixed it as `fixed`, which the Activity tab leaves out so merges count once.

| thimble's page | view.json |
|---|---|
| Overview: the Runs panel (each run's setup and its pull requests, merged of opened) | Pull requests: `bars` by run stacked by state, `7 of 8` merged at each bar's end; a click on a run keeps its pull requests, on a state those in it |
| The forge's list: state, title, run, area, `#15 opened by elm · …`, flags, diff size, reviewers' verdicts | a `list` grouped by run: its state as the glyph at its left edge, the title in bold, its area as a chip, its size right-aligned and its reviewers with their verdicts; under it, dim, the forge's short line and its flags as chips (`tags`), merged over a change request in the error colour and pushed after its last approval in the warning colour (`flag`), which also mark the row `×` and `!` |
| Filters: Author, Reviewer, Review, Area, Close reason, Flag | `filter.fields` state, area, author, reviewers (a reviewer with a verdict, `hazel ✓`), flags, close reason; search over the title, description, line and files; the labels |
| A pull request's page: state, who merged it when, setup; conversation; reviewers, labels, closes, timing, flags, elsewhere | the `pulls` detail: state, area, run, setup; author (a link to the agent), merged by, closes (a link to the issue), opened, first review, to merge, reviewers, commits, changed, flags; its description; its conversation (`related` events as a transcript); the same issue in other runs (a table of their pull requests, each a link) |
| Compare: pull requests issue by issue, a column per run | Issues: `bars` by backlog issue stacked by fixed and open (`4 of 4` fixed), over the issues grouped by backlog issue, a row per run with its setup, state, pull requests (`#9 merged after 20m · #10 closed`) and time to fix |
| Discussions, Agents | Discussions: by run over a list with author, posts and mentions, the first post under each; Agents: pull requests opened per run over a table of each agent's counts, its detail its sign-off, the authors it reviewed, its pull requests and its activity |
| The Activity panel: records per 10 minutes over hours since each run started, by action | Activity: a `histogram` of every record on the runs' clocks, coloured by action, over `lanes` per run with its setup beside it, and the records grouped by run |
| `31 files · 1 line could not be read` | "1 unreadable line" (`runs/r4/events.jsonl#L70`, cut off when the run stopped) and "31 files ▸", which lists the 45 fields the reader made |

Drawn at 96 columns, as it opens:

```
Repository  4 runs · 35 pull requests · 28 merged · 36 issues      1 unreadable line  31 files ▸
 Pull requests   Issues   Discussions   Agents   Activity
⌕ search   filter ▸ state · area · author · reviewers · flags · close reason · labels   35 pulls
────────────────────────────────────────────────────────────────────────────────────────────────
r1   ████████████████████████████████████                7 of 8
r2   ████████████████████████████████                    5 of 7
r3   ██████████████████████████████████████████████████ 9 of 11
r4   █████████████████████████████████████████           7 of 9
● merged 28  ● closed 4  ● open 3

▾ r1  8
  ● Treat 'next <weekday>' as never today               parser       +1 −1  birch ✓
      #9 by ash · merged in 20m · closes #1   merged by its author
  ● Parse week designators alongside other units        durations    +9 −1  cedar ✓
      #10 by birch · merged by cedar in 28m · closes #2
  × Keep wall-clock time across DST in biweekly rules   schedules    +8 −2  birch ✓, ash ✗
      #11 by cedar · merged in 1h 04m · closes #3   merged over a change request   +2
  ● Say 'in 3 hours' for times later today              formatting   +3 −0  cedar ✓
      #12 by ash · merged in 22m · closes #4   merged by its author
  ● Reject impossible calendar dates                    parser       +3 −1  ash ✓
      #13 by birch · merged in 31m · closes #6   merged by its author
  ● Apply tz to date-only input                         parser       +3 −1  cedar ✓
      #15 by ash · merged in 21m · closes #14   merged by its author
  ● Document strict mode                                docs         +8 −0  ash ✓
```

Not drawn: the records strip under each forge row, the diff as its own component with line numbers (a push's diff
shows in its record's words), the tabbed unit page (Conversation, Commits, Files changed; the detail shows the facts,
then the conversation), and the review-partner matrix (an agent's detail lists the authors it reviewed).

## Reader queries thimble's page uses

| op | query | answer used for |
|---|---|---|
| view (default) | `tab` pulls, issues, discussions or agents; `runs`; `compare`; `q`; `range` [h, h]; `filters` {filter: value or [values]}; `colour`; `labels` (false to colour by a field while labels are on); `hide`; `sort`; `offset` | `tabs` counts, `runs` rows with measures, `facets` with counts, `total` and a page of `items` (100), `activity` {bin, hours, rows [run, bin, key, n]}, `colour` legend, `classes`, `grid` (compare), `pairs` (agents) |
| unit | `key` (`r3/pull/15`, `r1/issues/7`, `r3/discussions/1`, `r4/agents/moss`), `colour`, `labels`, `hide` | the unit's facts, `records` in time order with text, diffs and refs, `commits`, `elsewhere`, `issue`, `links` |
| raw | `key` | the lines the unit's records come from, grouped by file |

`resolve` answers `<file>#L<n>` with `target {key, ref}` (the record in its unit) and `view:repository/<key>` with the
unit or the run.
