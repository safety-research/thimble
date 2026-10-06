# Linked sessions

thimble's worked example of a view over agent-team transcripts (plugin/viewers/linked-sessions), ported to the mod:
sample/ and labels.json are thimble's; reader.py is thimble's with the `rows` query added; view.json is the terminal
spec (views/SPEC.md) and rows.json the runner's output on the sample. This file says what thimble's HTML view shows
and how the terminal view draws each part of it.

## The data and the reader on its sample

`python3 helper/viewhost.py viewers/linked-sessions shown --root viewers/linked-sessions/sample`

| | |
|---|---|
| claimed files (`runs/*.jsonl`, `runs/*/sessions-index.json`) | 20, 182,261 bytes, every one read to the end |
| problems | 1 unreadable line: `runs/r2/f7982219-….jsonl#L34`, not a JSON object (the cut-off last line) |
| hidden files | none |
| derived fields declared in view.json | 34 (runs 4, sessions 9, steps 19, moments 2) |
| runs / sessions / calls / messages | 3 / 17 / 316 / 36 (17 prompts, 16 results, 3 texts) |
| calls by outcome | ok 278, error 31, denied 7 |
| calls by tool | Bash 109, Read 74, Edit 68, Grep 31, WebSearch 20, Task 14 |
| calls by file type | .py 103, test .py 51, test .json 21, .md 6, .toml 3, no file 132 |
| calls by duration | under 1 s 190, 1–10 s 101, over 10 s 25 |
| labels on (Test runs, Pagination) | pytest 66, pagination 15, no label 236 (thimble's own view shows the same three counts) |
| label filter Test runs = pytest | 66 calls in 15 sessions |
| one session (r1 webhooks) | 25 calls, 27 transcript items |

The index builds in about 25 ms.

## What thimble's HTML view shows

- **Header.** The task every lead was given ("Upgrade invoicer from Brambleway API v2 to v3."), then
  `3 runs · 17 sessions · 316 calls · 12–13 Sept 2026`. Above the view thimble draws `20 files · 1 line could not be
  read`.
- **Control row.** A search box (messages, commands, paths) and one dropdown chip per field: Run, Agent, Tool, Outcome,
  File type, Duration. Each menu lists the field's values with counts that hold every other filter. A count line
  `316 of 316 calls · 32 files`.
- **Colour.** A Colour menu picks what colours the call marks: a field (tool by default) or the labels that are on.
  Its legend lists each value with its count; a click shows a value alone, a shift-click hides it. Beside it the
  glyph legend: Error 31, Denied 7, Spawned, Returned, Waiting on subagents.
- **Lanes (overview).** A table with one row per session, grouped under a row per run (`Run 1 nested team · 7 sessions ·
  started 12 Sept 14:02 · ran 44:10`), each subagent indented under the session that spawned it with tree lines. Columns
  SESSION, CALLS, ERRORS, then a time axis on the run's clock (0–50 min). In each lane: the session's span as a light
  bar, each tool call a tick in its colour, an error with a red mark under it, a denial with an amber mark, a dotted
  line where the session waits on subagents, a circle where a subagent returned, and a vertical line from the Task call
  to the child's lane. A context strip above the lanes shows the whole span; a drag on it sets the window the lanes
  show (zoom). Each row has a checkbox; ticking up to four sessions or runs opens Compare.
- **Open session (zoom and details).** A click on a lane opens the session beside the lanes (below them in a narrow
  pane): its name and file chip, `Run 1 · nested team`, `25 calls · ran 14:20 · 3 errors`, a "Spawned by lead · Task
  07:06" chip and chips for its subagents, and Previous error / Next error. Under it the transcript, one row per item
  (time, tool or kind, input, outcome and duration; a Read shows its size, an Edit its old and new lines, a Grep its
  matched files), and the selected call's details: tool, status chip (`error · exit 1`), the command, Call 6 of 25,
  Started, Duration, Result, Same command next, Labels, Output, Files, and "Run 1 at 09:48": what each other session
  of the run was doing at that moment (starts at, returned at, waiting on, or its last call). Fields | Raw switches the
  details to the tool_use and tool_result lines as the file holds them.
- **Compare.** Two to four sessions or runs side by side: their lanes aligned on run clock or on session start (with
  or without subagents), then per group a bar table: calls by tool, outcomes, time (wall clock, summed over sessions,
  in tool calls, waiting on subagents), files touched (edits and reads) and the errors in time order.
- **Labels.** The Colour menu lists every label over these files with a switch; turning one on colours the calls by
  its values. The label filter keeps the calls (and the sessions above them) it holds for. Only the analyst toggles
  labels.

## The terminal view

`records(index, {"op": "rows"})` gives 3 `runs`, 17 `sessions`, 375 `steps` and 1,553 `moments`. A step is one item of
a session's transcript as thimble's `session` query gives it (17 prompts, 316 calls, 3 texts, 9 waits on subagents, 14
returns, 16 results), each call with its facts read back from its two lines. A moment is what another session of the
run was doing at a call's time, thimble's `moment` query answered for every call, so a call's detail lists them.
Sessions are named by agent and run; their keys (hex agent ids and uuids) never show. A session's `refs` are its
records' lines and a call's its tool_use and tool_result lines, so Test runs marks 66 calls in 15 sessions, as in
thimble.

| thimble's page | view.json |
|---|---|
| Overview: the lanes table, one row per session grouped by run, SESSION CALLS ERRORS, the run's clock, a context strip | Sessions: a `histogram` of every call on the runs' clock, coloured by tool, over `lanes` of sessions: each subagent under the session that spawned it with tree lines, a heading per run (`group: run`) with the run's calls and errors, each session's calls and errors beside its name (`meta`), its span as a rule, each call a mark in its tool's colour |
| Error and denial marks | `outcome` flags `error` and `denied`: a red `×` and an amber `!` in the lanes, counted under the axis (a click keeps them), red and amber wherever the outcome shows |
| Zoom: a drag on the context strip sets the window | a click on the strip halves the window around it; the lanes redraw it on the zoomed clock |
| Filter: search, Run, Agent, Tool, Outcome, File type, Duration | `filter.fields` run, agent, tool, outcome, file type, duration band, counted under each other; search over the call, its result and its files; the labels. A filter keeps only the lanes with a call left, and the sessions above them |
| An open session: name, run, calls, ran, errors, spawned by, subagents, its transcript | the `sessions` detail: agent and run; spawned by and the Task call (links), depth, start, end, ran, calls, errors, denied; its prompt; its transcript (`related` steps as a transcript, each call's outcome named beside its tool when flagged); its subagents |
| A call: tool, status, command, call n of m, started, duration, result, same command next, output, files, "Run 1 at 09:48" | the `steps` detail: tool, outcome, duration band; session and run (links), time, duration, call n of m, exit code, same command next, the subagent a Task call spawned (a link), files, matched files; input and output; the run at that moment (`related` moments: each other session and what it was doing) |
| Compare: sessions or runs side by side | Compare: the runs' calls as bars stacked by agent, over the sessions grouped by agent, so each agent's sessions in the three runs stand side by side; Calls: calls by tool over a table of every call |
| `20 files · 1 line could not be read` | "1 unreadable line" (r2's lead transcript ends in a cut-off line) and "20 files ▸", which lists the 34 fields the reader made |

Drawn at 96 columns, as it opens:

```
Linked sessions  3 runs · 17 sessions · 316 calls · 31 errors      1 unreadable line  20 files ▸
 Sessions   Calls   Compare
⌕ search   filter ▸ run · agent · tool · outcome · file type · duration band · labels  316 steps
────────────────────────────────────────────────────────────────────────────────────────────────
                            16 ┤  ▆   ▃  ▅    █ ▁ ▁   ▃ ▁ ▁
                             0 ┤ ▆██▆▇█▇██▆█▅▆█▆███▅█▅█▄█▇█▅▄▇▆▃▃▄▅▂▂▅▂▅▃▂▅▄▄▂▅▂▃▂▂▂▄▃▂▁▂▂▁▂▂▂▂▃
                                 0 s                        26 m 17 s                  52 m 33 s
                                 ● Bash 109  ● Read 74  ● Edit 68  ● Grep 31  ● WebSearch 20

agent               calls errors
r1 · nested team      149     15
  lead                 18      1 ●◆──────◆────────────────────────×──●───────────●●●●!
  ├ survey             19      1  ─◆×●◆◆●
  ├ client-port        35      3         ●◆◆×●●──────────●×◆●×◆●●●─
  │ ├ pagination       21      3              ●●×●×●●●◆●◆
  │ └ auth-headers     14      1              ●!●×●◆
  ├ webhooks           25      3         ─◆●●×●!●●●×●●●×●●●
  └ test-runner        17      3                                     ×●●●×●●×─●●●●

r2 · flat team         88     12
  lead                 16      1 ●◆●●─────────────────────────────────────×─●────────────────●●!
  ├ client-port        35      5    ●●◆●─●●●×─●×──●─●●!●●─●×─●×──●×─●●●●─●●
  ├ webhooks           20      2    ●●●●●─●●●─●×●!×──●●●●
  └ test-runner        17      4                                            ×●●●●×─●●●×●●×─●─●

r3 · with reviewer     79      4
  lead                 15      0 ●◆─────◆────────────────●─────●─●────────●●─●!─
  ├ survey             12      0  ●●◆●●●
  ├ client-port        22      3        ─●●─●×●●●●─●●●●×─×──●●●●●●
  ├ webhooks           15      1        ─●●●─×●─●─●─●─●●●
  ├ reviewer            7      0                         ●●─●●●
  └ reviewer            8      0                                 ─●●●●─●●●
                                 └──────────────────────────────────────────────────────────────
```

Not drawn: the dotted line while a session waits on its subagents and the circle where one returns (the transcript
lists each wait and return), the vertical line from a Task call to its child's lane (the child sits under its parent),
checkboxes to compare up to four sessions (the Compare tab sets all of them side by side), and Previous error / Next
error (the outcome filter keeps the errors, and ↑ ↓ step through them).

## Reader queries thimble's page uses

All go through `records(index, query)`; the selection fields are the same in every op.

| op | query | answer used for |
|---|---|---|
| overview (default) | `filters` {field: [values hidden]}, `search`, `range` [s, s] of duration, `files` (path words), `hide` [`label\nvalue` or `none`], `win` [s, s] | runs, sessions (`depth`, `parent`, `start`, `end`, `waits`, `spawn`, counts), calls (`time`, `duration`, `tool`, `outcome`, `m` marks, `ref`), `fields` with counts, `classes` and `none` |
| session | `id` plus the selection | transcript `items` (prompt, call, text, wait, return, result) with refs |
| moment | `run`, `t`, `session` | what the other sessions were doing at a call's time |
| compare | `ids` (runs or sessions), `subs` | groups with tools, outcomes, time measures, files, errors |
| raw | `refs` | the tool_use and tool_result lines as the file holds them |

Note that `filters` lists the values a facet hides, not the ones it keeps. `resolve` answers `<file>#L<n>` with
`target {session, call | message}` and `view:linked-sessions/<run | session key>` with `target {run | session}`.
