# thimble-chat

thimble's analysis guidance in a plain Claude Code session, as a [mod](https://code.claude.com/docs/en/plugins/mods/overview).
You ask a question about the data in a folder. Claude answers with numbers computed by code, the mod draws each card as
a chart or table between the lines of the reply, and each citation is a link you can click to see the cited place. There is no thimble server, browser or background agent.

This is an exploration. It is not part of thimble's release, and it may change or break.

## Requirements

- Claude Code 2.1.287 or newer (`claude --version`)
- python3

## Install

    git clone -b explore/thimble-chat https://github.com/safety-research/thimble ~/thimble-chat-dev
    claude plugin marketplace add ~/thimble-chat-dev/mods
    cd <corpus folder> && claude plugin install thimble-chat@thimble-chat-dev --scope project

The marketplace path must end in `/mods`: adding the repository's top folder installs full thimble instead.
`--scope project` turns the mod on in that folder only. Run the last line in each folder you want it in.

Update: `git -C ~/thimble-chat-dev pull`, then start a new session or run `/reload-plugins` in an open one.

Remove:

    cd <corpus folder> && claude plugin uninstall thimble-chat --scope project
    claude plugin marketplace remove thimble-chat-dev

## Use

Run `claude` in the folder and ask a question about its files. Claude answers in one of two shapes: a card and a
one- or two-sentence takeaway when one chart or table answers the question, or short sections with cards between
paragraphs for a question that takes several steps, such as a why question.

- **Cards.** Claude computes every number with a Python script under `.thimble-chat/scripts/`, which ends by writing
  a card: a bar chart, line chart, timeline, table, quoted example records, or a diagram (boxes joined by arrows, its
  long edge labels as numbered notes under it). The card is written to the session's folder wherever the script runs,
  and the mod draws it where the reply places it: its question, its choices if it has any (such as `by  wiki  label`;
  picking one reruns the script with it), and the chart. The mark under the pointer is highlighted and its value shows
  at the right of the question. Colours follow Claude Code's theme (light, dark, daltonized, ANSI); chart colours keep
  3:1 contrast on light and dark backgrounds.
- **Citations.** Every citation `[[value|place]]` is drawn as an underlined link. A place can be file lines, a CSV row,
  a JSON value, a SQLite row, a card value or lines of a Bash output. The mod checks each one; a citation is red when
  the place does not exist or the value is not there. When a reply has red citations or a card that does not validate,
  a subagent forked from Claude corrects them out of the main conversation: a red citation shows a spinner while it
  works, each corrected sentence is redrawn in place and marked *(corrected)*, and Claude is told in a note you do not
  see. A citation the subagent could not fix stays red with "⚠ couldn't fix"; its hover and panel say why.
- **Panels.** The citation panel shows the cited lines with the value marked, or the card with the cited row marked.
  Panels dock on the right in the fullscreen view at 110 or more columns, and open above the prompt otherwise.
- **Side threads.** "? ask" on a card, `a` in the citation panel, or `/thimble-ask <question>` opens a side thread: a
  forked subagent answers in a panel, and nothing is added to the main conversation. `m` puts the thread's one-line
  result into the prompt, for you to send or not.
- **Verification scripts.** `w` in the citation panel has a forked subagent write a standalone script that recomputes
  the cited value from the raw files, without the answer's code. The mod runs the script, shows it and its output in
  the panel, and marks the citation ✓ if it recomputed the value or ✗ if not.

Commands: `/thimble-card <n>` (the last answer's n-th card in a panel), `/thimble-cite <n>` (the last answer's n-th citation),
`/thimble-check` (check the last answer again), `/thimble-ask <question>`, `/thimble-band` (a row above the prompt
listing the last answer's citations, opened with the digits 1-9), `/thimble-chat` (status).

The mod and Claude write only under `.thimble-chat/` in the folder: scripts, cards, answers, side threads,
verification scripts, corrections and saved Bash outputs.

Display: hover and clicks need Claude Code's fullscreen view (`/tui fullscreen`); without it the cards and citations are
drawn but do not respond to the mouse. iTerm2 shows the colours in full; macOS Terminal shows 256 colours. In
tmux, set `set -g mouse on`, and `CLAUDE_CODE_TMUX_TRUECOLOR=1` for full colour.

## Known limits

- Charts are text: eighth-block bars, braille lines and box-drawing diagrams, at most 120 columns wide. A diagram
  shows at most 40 nodes and 80 edges.
- cmd+click and option+click do not reach the mod (iTerm2 keeps them). Right-click is the second gesture; shift-, alt-
  and ctrl-click do the same where the terminal reports them.
- While the prompt holds a draft, a panel that opens does not take the keys: click it first.
- A hover tip shows on a neighbouring line, since a tip cannot be drawn outside its paragraph.
- A side thread's Bash outputs cannot be cited, and each follow-up starts a new subagent given the exchange so far.
- A number typed without any citation is not caught.
- Tried only in the terminal, not in the Desktop app.
- If thimble itself is installed, its plugin also loads in the folder. This mod was tried with it off: set
  `"thimble@thimble-local": false` (`"thimble@thimble": false` for a Dev install) under `enabledPlugins` in the
  folder's `.claude/settings.json`.

## Tests

From `mods/thimble-chat`:

    claude plugin validate .
    claude plugin test .
    python3 tests/test_helpers.py
    python3 tests/test_cards.py
    npx -p typescript tsc -p . --noEmit

`tsc` needs the type declarations Claude Code writes into `.claude-plugin/types/` when it loads the mod from a folder,
for example in a session started with `claude --plugin-dir .`.
