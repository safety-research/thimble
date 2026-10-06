# thimble-cc-mod

A single-agent thimble inside Claude Code, as a [mod](https://code.claude.com/docs/en/plugins/mods/overview). You
ask a question about the files in a folder. Claude computes every number with a script, and the mod draws each result
as a card (chart, table, timeline, diagram or example records) between the lines of the reply. Every citation is a
link to the place it cites, checked by the mod and repaired when it is wrong. There is no thimble server, browser or
background agent. This is an exploration and may change or break.

## Install on a Mac without thimble

Needs Claude Code 2.1.289 or newer (`claude --version`) and python3 (`xcode-select --install` provides it).

    git clone https://github.com/safety-research/thimble ~/thimble-cc-mod
    claude plugin marketplace add ~/thimble-cc-mod
    cd <folder with the data>
    claude plugin install thimble-cc-mod@thimble --scope project
    claude

`--scope project` turns the mod on in that folder only. In Claude Code, run `/tui fullscreen` once: the mouse works
only in the fullscreen view. Do not install the `thimble` plugin from this marketplace; it needs thimble's server.

Update, then restart `claude`:

    git -C ~/thimble-cc-mod pull
    claude plugin marketplace update thimble
    claude plugin update thimble-cc-mod@thimble --scope project    # in the folder

Remove:

    claude plugin uninstall thimble-cc-mod@thimble --scope project    # in the folder
    claude plugin marketplace remove thimble

## With thimble installed

`thimble cc-mod on` in a folder turns the mod on there, `thimble cc-mod off` turns it off, and `thimble cc-mod status`
shows the state of both plugins. It uses the mod that came with the installed thimble. Sessions started with `thimble`
run without the mod; plain `claude` in the folder uses it.

## What it does

- **Cards.** Claude writes a Python script under `.thimble-cc-mod/scripts/` that computes the answer and writes a
  card. A card shows its question, its choices if it has any (picking one reruns the script) and the chart. The mark
  under the pointer is highlighted and its value shown.
- **Citations.** `[[value|place]]` is an underlined link to file lines, a CSV row, a JSON value, a SQLite row, a card
  value or a Bash output. A citation whose place does not exist or does not hold the value is red. A fork of the
  conversation repairs it while ◌ shows, and the fixed sentence replaces the old one in place. A citation the
  fork could not fix keeps a ×, and its panel says why.
- **Verification.** "verify" (in the menu, or `v` in a citation's panel) has a fork write a script that recomputes
  the value from the raw files. The mod runs it and shows the script and its output: ✓ when it recomputed the cited
  value, × and red when it got another.
- **Side threads.** Ask about anything on screen. A fork answers in the panel, and Claude gets a hidden one-line note,
  so you can refer to the thread later. Threads are saved under `.thimble-cc-mod/threads/` and reopen from
  `/thimble-threads`. A thread asked from inside another thread hangs under it (see the panel's way under Gestures).
- **Play.** "▶ play" under an answer plays it in the panel as an animated report built from its own text and cards:
  each card is drawn in while the sentences around it appear, and the value a sentence cites is lit on the card.
- **Forks.** Every agent the mod starts (repairs, verifications, side threads, report writers, highlighters, view
  builders, reviewers) is a fork that inherits the main conversation. None posts a notice in the main chat: the panel
  shows the result and Claude gets a hidden note. The mod stops each fork once its answer is in.

The mod and Claude write only under `.thimble-cc-mod/` in the folder.

How the mod draws, its grid, type, colour and symbols, each with one meaning, is written in `views/SPEC.md`
("The visual system"): bold marks only what is new, red only a problem, a palette hue only a value of a category.

## Gestures

One panel shows everything: a citation's place, a card's script, a side thread, a menu, a view or a report. A click
changes what it shows; Claude Code's close mark, or the `x` key, closes it. The panel draws no key hints: its keys
(`b` back, `t` threads, `x` close, and the letters of a view's controls) work once it has the keyboard.

| Gesture | Does |
| --- | --- |
| click (double-click is the same) | a citation or example record: its place. A card's mark, row or node, or the card: a side thread about it |
| right-click | a menu: open, ask, verify, open the script, rerun |
| "?" in a block's margin (on hover) | a side thread about that paragraph, code block or card; beside a heading, about its section |
| a card's title | a side thread about the card |
| "ask about this answer ›" | a side thread about the whole answer |
| drag-select in a paragraph with citations | copies the text; "ask about this" starts a side thread about the selection |

The panel's top row is its path: `‹ back`, the steps from home to what the panel shows
(`home › thread "…" › citation …`, each crumb a click away, home opening the home panel), and `threads`, which
counts the threads answering and those with answers not yet read. A citation, record or card opened from inside the
panel keeps what the panel showed one step back; one opened from main starts the breadcrumb over, and back still leads
to what the panel showed before. A citation opened from a thread has a "follow-up" field whose question goes on in that
thread. A thread keeps answering when the panel moves on or closes: its step shows `◌` while it answers and `new`, in bold, when
its answer waits unread, and its "stop" ends it. When it answers while the panel does not show it, main's chat gets one
row at that moment, under its latest row (`↳ thread · "<question>" · answered`, `new` in bold until read; a click opens the
thread), and a row above the prompt counts the threads with answers unread until they are read (a click opens the
thread, or the home panel when several have news). Claude reads neither row, only the hidden note. The threads tree
(`/thimble-threads`) draws every thread, this session's and earlier ones, under the thread it was asked from, with what
it is doing and its unread answers. The answers read and the rows are kept in `.thimble-cc-mod/signals.json`, so
`claude --resume` shows them again.

## Home

The home panel lists everything made in the folder: views (built, building, proposed), reports, side threads (those
with new answers first), cards grouped by the question that made them, labels with their counts, and the files with
what this session read of them. A click on an item opens it in the panel, after `home` on the breadcrumb, so back
returns to the list. It opens from the breadcrumb's first step, from the row above the prompt when several threads have
new answers, and by `/thimble-home [stacked|index]`. The sections are stacked, each with its first items and "… N
more"; the header switches to an index, every section in two columns, a section opening whole under them. The panel
stays live while it shows: counts, states and new answers change as they come.

Modifier clicks and middle clicks are left to the terminal. Nothing a gesture does writes into the prompt. Below 144
columns a click does not open the panel by itself; a row above the prompt offers "open panel".

## Views

Ask for a view ("a view of the agents' sessions, linked by who spawned whom"). Claude proposes one with thimble's
fields (what it shows and why, files, unit, overview, zoom, filter, details). A builder fork writes its reader and spec
from thimble's view prompt and three worked examples (`viewers/`), and the mod runs thimble's checks and sends failures
back to a new builder. The view opens in the panel when the checks pass; a reviewer fork then reads it and may send
problems back. A view has a compact header, one filter row, an overview of every row (a click on it narrows the
rows), the records, and the selected row's details. `/thimble-view <name>` opens one; `/thimble-views` lists them with
their checks and review. The spec format is in `views/SPEC.md`. The checks fail a view whose rows take more than
10 MB, since the panel holds every row at once.

## Files

`/thimble-files` opens the file browser in the panel: every file of the folder by folder, with its kind (transcript,
records, table, json, text, markdown, code, binary, ...), its records and its size. A click on a file opens it in the
modes its kind offers, as tabs: Transcript (who speaks, when, what they said, a tool call folded to one line), Table
(the records' keys as columns: a click on a column sorts, a bar narrows) and Raw (the lines with their numbers;
markdown under its headings). Every tab has search, filters and the labels of `.thimble-cc-mod/labels.json` marked on
its records; a record's "↗ line" opens its whole lines, "?" beside it starts a side thread about it, and "‹ files" (or
←) goes back to the tree. "in files" under a citation of a file, and "open in files" in a record's menu, open the file
at that record. `/thimble-files <path>[:<line>]` opens one file directly. `helper/files.py` writes these as views under
`.thimble-cc-mod/files/`, again only when the file changed. A view holds 4,000 lines of a file at a time ("‹ earlier"
and "later ›" page through a longer one) and cuts long text, so search reads what the view holds; a label reads whole
lines, and a record's citation opens the rest.

## Reports

Ask for a report ("write up what happened in the wiki"). A writer fork writes it to `.thimble-cc-mod/reports/` and
checks its citations; the panel shows it being written, then draws it. The default is a document with contents,
callouts and toggles. Slides, an interactive story and a video are written only when asked for; a video plays in the
panel and is filmed to an MP4 when ffmpeg and a Python with Playwright and its Chromium are available (`python3`, or
the Python `THIMBLE_CC_MOD_PYTHON` names); without them the panel does not mention a film. A slide fits the panel: a
card taller than its room shows its first rows, and the line under it opens the card whole. The types are one registry
(`TYPES` in `hooks/report.ts`, guidance in `prompt/reports/`). In a report, "?" beside a passage starts a side thread
about it, "verify" beside a heading checks every citation of that section, and the "highlight" field marks the
passages a phrase applies to. "open as report" under an answer turns the answer into a document at once.

## Coverage, labels and the orientation

- **Coverage.** The mod counts what this session's agents (main, its forks and any subagent) have read of the corpus:
  the records each Read, Bash or Grep result showed, and the files a script or command only went over (Python's opens
  are noted through a `sitecustomize` the mod puts on `PYTHONPATH`). A line above the prompt says it ("read 2 of 4
  files · 0.4% of records · 1 never opened"); `/thimble-coverage` or its "details" opens the panel with each file, the
  lines read and what was never opened. Claude gets the line with each prompt. When an answer speaks for the whole
  corpus while a kind of file was never opened, or had no record read, the mod sends Claude what it missed, once per
  prompt of yours (`/thimble-coverage check off` turns that off), and Claude answers it in a turn of its own. Main's
  chat shows one dim line of it (`› coverage check · events.jsonl never opened · pages.jsonl only counted`); ctrl+o
  shows the row as Claude Code draws it. Claude Code gives a plugin no prompt of its own that the chat does not show in
  full, so a subagent on a small model carries the check: it says the line back, and its hand-back, which starts
  Claude's turn, takes the check along as context the chat does not show. Where no subagent can start, the check goes
  with your next prompt instead.
- **Labels.** Claude's `label` tool sorts the records of some files into values, as thimble's labels do: a prompt (a
  model reads each record, in batches), a regex or code; a trial on a sample first, then every record. Its answer is a
  label card in the reply: the count of each value as bars in the values' colours, and a few records with their words
  and the model's reason, each with "agree" and "disagree" (with more than two values, disagree shows the others to
  pick from). A verdict is kept as the label's correction, which wins and teaches the next run, and the card is made
  again with the same records. The panel shows the same and more: the definition, what the model calls recovered from
  in one dim line, the records of each value, and the field that runs it again with a new definition. A card whose
  script read a label (`label(name)` in `tcard`) shows it on a line under its question, its values after dots in their
  colours ("changed since" when the label changed after the card was made), and draws its bars, series, cells, events
  and examples in the colours of their values; a press on that line opens the label in the panel. Record text whose
  UTF-8 was once saved as Windows-1252 ("mÃ¶chten") is shown as written ("möchten"). The card comes from a script
  under `.thimble-cc-mod/scripts/`. Labels are kept in `.thimble-cc-mod/labels.json`, which the views read.
  `/thimble-label` defines and applies one with the tool's arguments, and lists or opens them (see Orientation and
  labels by command). `THIMBLE_CC_MOD_LABEL_MODEL` picks the model (default `claude-opus-5-5`, low effort).
- **Orientation.** `/thimble-orient`, or Claude's `orient` tool when you ask for an orientation, starts a fork that
  surveys every file and writes a short document, shown in the panel as a report. Its tool results carry the coverage
  line while files remain unopened; if it ends with a file unopened or a kind of file with no record read, a second
  fork reads what it missed and revises the document. Its switches are thimble's Start gate's, all on by default:
  `deck` (five to eight cards in the document; off, a document without cards), `views` (it proposes up to four views,
  built as Claude's are), `critique` (a fork that did not do the analysis reviews the document against the records and
  revises it) and `report` (the writer then writes a fuller report from the document and its cards). The document ends
  with what was read of each file, each range a citation. One orientation runs at a time.

## Orientation and labels by command

The analyst's commands and Claude's tools take the same arguments under the same names, and the guidance names them
too. They follow thimble's `start_orientation` and `apply_label`; thimble's own spellings (`final_notebook`,
`propose_views`, `generate_report`, `files`, `trial`) are read as well. Arguments are words, `key=value` (quote a value
with spaces) and `--flag` / `--no-flag`. The command answers with one line of what it understood, or refuses an
option it does not know and lists those it takes.

    /thimble-orient [brief words] [brief="…"] [deck|views|critique|report=on|off] [--no-deck] [--report] …
    /thimble-label                                   the labels, in the panel (or: list)
    /thimble-label open <name>                       one label (its name alone opens it too)
    /thimble-label <name> kind=prompt|regex|code definition="…" paths=a.jsonl,b/*.jsonl [values=yes,no]
                   [field=body] [within="other label=value"] [limit=30 | --trial | --all]
    /thimble-label <name> regex="…" …                kind and definition at once (prompt= and code= too)

A label's run goes on in the panel and Claude is told its counts when it ends. A label of this folder named with only
`limit=` or `--all` runs again as it was defined; named with some of its parts, those parts change.

The commands are `/thimble-orient` and `/thimble-label`, not `/thimble:orient` and `/thimble:label`: Claude Code
names a plugin's skills and markdown commands `/<plugin>:<name>`, which for this mod is `/thimble-cc-mod:orient`, and a
mod's own commands (`$.command.register`) take letters, digits, `_` and `-` only. A typed `/thimble:orient` that no
plugin serves is "Unknown command" before any hook sees it, and a plugin named `thimble` would collide with thimble's.

## Commands

`/thimble-card <n>` and `/thimble-cite <n>` (the last answer's n-th card or citation), `/thimble-check`,
`/thimble-ask <question>`, `/thimble-play`, `/thimble-home [stacked|index]`, `/thimble-threads`,
`/thimble-report [type] <request>`,
`/thimble-reports`, `/thimble-view <name>`, `/thimble-views [build] <name>`, `/thimble-files [path[:line]]`,
`/thimble-band`, `/thimble-coverage [check on|off]`, `/thimble-label [list | open <name> | <name> …]`,
`/thimble-orient [brief] [switches]`, `/thimble-cc-mod`
(status; `/thimble-cc-mod debug on` writes `.thimble-cc-mod/mouse.log` when a gesture misbehaves).

## Known limits

- Tried only in the terminal, not the Desktop app. iTerm2 shows full colour, macOS Terminal 256 colours; in tmux set
  `mouse on` and `CLAUDE_CODE_TMUX_TRUECOLOR=1`. macOS terminals may send ctrl+click as a right-click.
- Charts are text, at most 120 columns wide. A diagram with more than about 8 edges becomes hard to read, so Claude
  splits larger graphs into two cards.
- While the prompt holds a draft, a panel that opens does not take keys until it is clicked.
- A number typed without a citation is not caught.
- The coverage count is an estimate. A record counts as read when its start, or the start of one of its long text
  fields, appears in a call's output; a script that prints values it parsed, without their text, counts its files as
  only counted by code. Python started with `-S` or `-I`, and other languages' scripts, are noted only by the files
  their command names.

## Tests

From `mods/thimble-cc-mod`:

    claude plugin validate .
    claude plugin test .
    for t in tests/test_*.py; do python3 "$t"; done
    npx -p typescript tsc -p . --noEmit

`tsc` needs the types Claude Code writes into `.claude-plugin/types/` when it loads the mod, for example in a session
started with `claude --plugin-dir .`.
