# thimble-cc-mod changelog

## 0.6.1-dev.1

The terminal mode after Matt's review of 0.6.0 (2026-10-06). The panels now look like Claude Code's own panels, cards
have a full border again, links are blue, and the model's Markdown is drawn as Claude Code draws it. The rows above the
prompt, the right-click menu, the index layout of home and the video player are gone. `views/SPEC.md`, "The visual
system", has the new rules.

### The chat

- **No rows above the prompt.** A thread shows in the `↳ thread` row under the turn it was asked in, and a view in a new
  `↳ view · Wiki Pages · building` row under the reply that proposed it (`built`, `failed`, or `proposed` with a
  `build` control). Coverage is in home's Files section and `/thimble-coverage`.
- **"New" is the word `new` in green**, wherever it shows: a `↳` row, home, the threads tree, `show all threads`. Bold
  no longer means new.
- **Text fills the terminal's width.** The 72-column measure is gone. Cards keep their cap of 120 columns.
- **The model's Markdown as written:** `**bold**` is bold, headings are bold, inline code is coloured. Headings sit on
  the text column with the prose.
- **Citations are blue and underlined.** The one under the pointer is inverse, and its tip (its place and status in
  plain words) sits on a quiet box under it. The `?` beside a passage is blue; once a thread is asked about a passage,
  a blue `↳` stays beside it, and a click on it opens that thread.

### Cards

- **Every card has a full round border** in the rule grey, with a blank row under its title. This applies in the
  chat, the card pane, the citation panel and reports.
- **Bars** with no colour field are drawn in the first palette hue. The bar under the pointer turns the text colour and
  its label is inverse. The readout at the right of the title is plain.
- **Tables:** the column names are bold, with a rule under each. Markdown tables in a reply get the same header.
- **Timelines:** each event's time starts at the card's edge, under the axis's start time, then a dot in colour, the
  words and a blue `↗`.
- **Examples:** thimble's note, then the record's words in quotation marks and italic, then `↗ place` right after
  them. There is a blank row between records.
- **Label cards** are bar cards of the label's counts. Every card that read a label has the row
  `label  edit purpose ↗`, the name blue and underlined; a click opens the label panel, where the records and the agree
  buttons now are.
- Readouts name places in words (`events.jsonl line 3`), and diagram arrows are `↓ ↑`.

### Panels

- **Claude Code's panel style:** a title in the accent colour and bold with a dim subtitle, the selected tab inverse, a
  bordered search box, bold section headings, `❯` and the accent on the selected row, metadata dim at the right, and a
  dim italic row of key hints at the end. Every panel's path row ends with `show all threads` and `N new`.
- **Actions are at the bottom** of a panel, after a rule, where their result appears: `verify  ask about it`,
  `run on the sample`, `ask for a change`, `script  run again`. There is no close button; `✕` and `x` close the pane.
- **A right-click does what a click does.** The menu is gone.
- **The citation panel:** the cited value as the title, blue and underlined; its status in plain words
  (`found in revisions.jsonl line 10566`, `found on the card, but a script got 5883`); then `from`, `command` and
  `source`, with the cited value underlined in the source sentence. No `why` or `made by` rows. Commands and scripts
  are coloured as Claude Code colours code, and a cited card is drawn in its border.
- **Threads are one panel:** the tree under `main` with `├ └` guides, then the selected thread's questions and answers,
  then the `ask` field.
- **Home** has one layout, a single column. The title is `Home` alone. Card groups say what they hold
  (`answer to "…"`, `in the report "…"`); the newest is open and the others fold. Files are listed by folder, and
  folders fold.
- **The file browser:** folders fold, an open folder shows its first 20 files, files are coloured by their type, and the
  selected file's first lines show under it. No bar chart over the tree or over a file's table.
- **The label panel** follows the browser's label editor: editable fields for the type, the scope, the prompt (or
  pattern or code), the values and the sample size; the counts; `▸ examples` and `▸ cards`, folded; and
  `run on the sample  run on all N` at the bottom. The labels list has a `describe a new label` field, whose words go
  to main.
- **The views pane** lists one row per view and the selected view's description. `ask for a change` sends the
  analyst's words to the view's builder (new prompt `prompt/view-change.md`). `build again` and `review again` are gone.
- **Reports** are drawn as the chat draws a reply: headings bold, prose full width, cards in their border, everything
  at one left edge. The stats row and the highlight field are gone (highlights are still asked for in the chat).
- **Coverage** no longer says how many records a label judged.
- **Transcripts:** the time dim at the left, the speaker's name bold after a coloured dot, and the text indented under
  the name.

### Removed

- The video player and the video report: `/thimble-play`, `▶ play` in a reply's footer, `prompt/reports/video.md`.
- The right-click menu, the stacked and index layouts of home, and the rows above the prompt.

### Prompt changes

- `prompt/chat.md`: a proposed view "waits under your reply until they build it" (was: in the row above the prompt);
  no video among the report forms; a label card has "a link to the label, where the analyst reads its records and can
  agree or disagree with them" (was: a few records to agree or disagree with in place).
- `prompt/view-build.md`: "and no bold" (was: "and no bold (bold marks only what is new)").
- `prompt/reports/writer.md`: the example line is "Wrote the document, six sections and four cards."
- `prompt/view-change.md`: new, for `ask for a change`.
- The label tool's description and answer say the card links to the label.
