# thimble-cc-mod

thimble's analysis guidance in a plain Claude Code session, as a [mod](https://code.claude.com/docs/en/plugins/mods/overview).
You ask a question about the data in a folder. Claude answers with numbers computed by code, the mod draws each card as
a chart or table between the lines of the reply, and each citation is a link you can click to see the cited place. There is no thimble server, browser or background agent.

This is an exploration that ships with thimble as the second plugin of its marketplace. It may change or break.

## Requirements

- Claude Code 2.1.287 or newer (`claude --version`)
- python3

## Install

With thimble installed, run `thimble cc-mod on` in a folder; `thimble cc-mod off` undoes it. Both switch this mod
alone: the thimble plugin stays as it is, and thimble's own background sessions run without the mod.

Without installing thimble:

    git clone https://github.com/safety-research/thimble <dir>
    claude plugin marketplace add <dir>
    cd <folder> && claude plugin install thimble-cc-mod@thimble --scope project

Do not install the `thimble` plugin from that marketplace unless you ran thimble's installer: it needs the thimble
server. `--scope project` turns the mod on in that folder only.

Update: `git -C <dir> pull`, then `claude plugin marketplace update thimble`.

Remove: `claude plugin uninstall thimble-cc-mod --scope project` in the folder, then
`claude plugin marketplace remove thimble`.

## Use

Run `claude` in the folder and ask a question about its files. Claude answers in one of two shapes: a card and a
one- or two-sentence takeaway when one chart or table answers the question, or short sections with cards between
paragraphs for a question that takes several steps, such as a why question.

- **Cards.** Claude computes every number with a Python script under `.thimble-cc-mod/scripts/`, which ends by writing
  a card to the session's `.thimble-cc-mod/cards/`, wherever the script runs. The kinds are bar, line, timeline (times
  shown and cited short, as 18 Jun 21:26), table, example records and diagram (boxes joined by arrows in layers; a long
  node name wraps to two lines; an edge label stands on its own edge, or, when it is long or has no room there, is a
  numbered note under the drawing with its number on the edge). A card shows its question, its choices if it has any
  (picking one reruns the script), and the chart. The mark under the pointer is highlighted and its value shows
  beside the question. Colours follow Claude
  Code's theme; chart colours keep 3:1 contrast on light and dark backgrounds.
- **Citations.** Every citation `[[value|place]]` is an underlined link. A place can be file lines, a CSV row, a JSON
  value, a SQLite row, a card value or lines of a Bash output. The mod checks each one, and a citation is red when the
  place does not exist or the value is not there. A subagent forked from Claude repairs red citations and cards that
  cannot be drawn, outside the main conversation; the citation stays red with a spinner after it meanwhile. The
  subagent rewrites each sentence whole, the mod puts the fixed sentence in place of the old one without a mark, and
  Claude gets a note you do not see. A citation it could not fix stays red with ✗ after it, and its tip and panel say
  why.
- **Verification.** "verify" (in the menu, or `v` in the citation panel) has a forked subagent write a standalone
  script that recomputes the value from the raw files, with a spinner after the citation meanwhile. The mod runs the
  script and shows it and its output in the panel; the citation gets ✓ when the script recomputed the cited value, and
  ✗ and turns red when it recomputed another.
- **Side threads.** A side thread asks a forked subagent about anything on the screen; it answers in the panel and
  nothing is added to the main conversation (see Gestures for the ways to start one, and `/thimble-ask <question>`).
  A thread about a card may change the card in place when its values stay the same; otherwise it makes a new card,
  and the reply's citations of the card are checked again. Threads are saved under `.thimble-cc-mod/threads/` and
  listed across sessions by `/thimble-threads` or "all threads" (`t`) in a thread, where one reopens to continue.
  Each subagent the mod starts shows in the main chat as one dim line at most, named for what it does:
  "verification · correcting citations", "verification · checking <value>", "side thread · <the question's first
  words>". The mod stops each one once its answer is in, a side thread's also when the panel shows something else or
  closes, and any still running at /exit, so /exit exits.

## Gestures and the panel

One panel shows a citation, a card's script, a side thread, a target's menu or the threads list; a click only changes
what it shows. It closes by its own "close" button (`x`); Esc does not close it.

| Gesture | Does |
| --- | --- |
| click (a double-click is the same) | on a citation or an example record: its place in the panel. On a card's bar, point, row or node, or the card itself: a side thread about it |
| right-click | the menu in the panel: open, ask, verify, open the script, rerun (a letter key each); the target is shaded while it shows |
| "?" in a block's margin (shown on hover) | a side thread about that paragraph, code block or card; beside a heading, about its whole section |
| a card's title | a side thread about the card |
| "ask about this answer ›" under an answer | a side thread about the whole answer |
| drag in a paragraph with citations | selects and copies the text; "ask about this" beside the selection starts a side thread about it |

Clicks with a modifier (shift, ctrl, alt) and middle clicks are left to the terminal. Nothing a gesture does writes
into the main prompt. Paragraphs without citations are Claude Code's own Markdown, so their text selects and their
links open as in any reply.

If a gesture misbehaves, run `/thimble-cc-mod debug on` (or start Claude Code with `THIMBLE_CC_MOD_DEBUG=1`) and send
`.thimble-cc-mod/mouse.log`: one line per press and release the mod received, with its button, modifiers, gesture and
target, then what the mod did: the action, the panel it opened (or why it waits) and the subagents it stopped.
`/thimble-cc-mod debug off` stops it.

Commands: `/thimble-card <n>` (the last answer's n-th card in the panel), `/thimble-cite <n>` (its n-th citation),
`/thimble-check` (check the last answer again), `/thimble-ask <question>`, `/thimble-threads` (every side thread),
`/thimble-band` (a row above the prompt listing the last answer's citations, opened with the digits 1-9),
`/thimble-cc-mod` (status).

The mod and Claude write only under `.thimble-cc-mod/` in the folder: scripts, cards, answers, side threads,
verification scripts, corrections and saved Bash outputs.

Display: the mouse needs Claude Code's fullscreen view (`/tui fullscreen`); without it cards and citations are drawn
but do not respond. Below 144 columns Claude Code keeps the panel a click opens undrawn, since it does not count a
click on the reply as asking for one: a row above the prompt says the panel is ready, and its "open panel" button
opens it. The buttons ("?", a card's title, "ask about this answer ›") are the person's own presses and open the panel
at any width. iTerm2 shows the colours in full; macOS Terminal shows 256 colours. In tmux, set
`set -g mouse on`, and `CLAUDE_CODE_TMUX_TRUECOLOR=1` for full colour.

## Known limits

- Charts are text: eighth-block bars, braille lines and box-drawing diagrams, at most 120 columns wide. A diagram
  shows at most 40 nodes and 80 edges, but past about 8 edges its lines cross into a tangle, so the prompt asks
  Claude to split a larger graph into two cards.
- macOS Terminal and iTerm2 may send ctrl+click as a plain right-click, which opens the menu.
- A click on the transcript's bottom row while "Jump to bottom" shows goes to that button.
- In the fullscreen view at 110 or more columns the panel docks on the right and narrows the transcript.
- While the prompt holds a draft, a panel that opens does not take the keys: click it first.
- A hover tip shows on a neighbouring line, since a tip cannot be drawn outside its paragraph.
- A side thread's Bash outputs cannot be cited, and each follow-up starts a new subagent given the exchange so far.
- A number typed without any citation is not caught.
- Tried only in the terminal, not in the Desktop app.

## Tests

From `mods/thimble-cc-mod`:

    claude plugin validate .
    claude plugin test .
    python3 tests/test_helpers.py
    python3 tests/test_cards.py
    python3 tests/test_guidance.py
    npx -p typescript tsc -p . --noEmit

`tsc` needs the type declarations Claude Code writes into `.claude-plugin/types/` when it loads the mod from a folder,
for example in a session started with `claude --plugin-dir .`.
