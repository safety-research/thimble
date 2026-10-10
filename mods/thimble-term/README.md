# thimble-term

thimble's terminal-mode renderer: a Claude Code plugin of function hooks that draws thimble's work in the terminal.
`thimble mode terminal` once in a folder, then `thimble`, starts Claude Code with thimble's plugin and this one
(`--plugin-dir <tree>/mods/thimble-term`), with no server, no port and no browser. Browser mode does not load it.

It only draws. It registers no model tools, agents, guidance or commands, and it keeps no data except what is on
screen; the one call it changes is main's Agent call for a side thread's fork, which runs with the thread's question as
its description, so that Claude Code's agent tray and exit dialog name the thread by it (its prompt keeps
`thread:<name>`, by which thimble knows the fork): what it draws comes from `thimble state`, and every change it makes goes through `thimble act`. The one file it
writes is the workspace's `terminal/chat.json` (`hooks/kept.ts`): what main's chat drew under each of its rows (the
turn's cards, the answer's footer, the `↳` rows), by the row's uuid, which Claude Code keeps across `--continue` and
`--resume`, so a resumed session draws it again. It writes to
main only when the analyst asks it to: a code label's run and a card's `run again` (code runs only in main's Bash) and a
new label described in the labels list go to main as the analyst's prompt, and a document's `as slides` or `as a story`
runs `/thimble:write`. It is idle in any session whose `THIMBLE_WS` does not name a workspace with `mode: "terminal"` in
its `trusted/launch.json`.

## What it draws

Its look is [SPEC.md](SPEC.md) ("The visual system"): one left edge, links blue and underlined, `new` in green,
Claude Code's panel chrome, no right-click menu.

- **Main's replies.** The model's Markdown as Claude Code draws it (bold bold, headings bold, inline code colored). The
  prose and the cards share one left edge, column 2, Claude Code's own (the ⏺ row's text), and one width: the
  terminal's, less 2 and the margin, with no measure; the cards follow the text and each other border to border. Each citation, `[[value|ref]]` or
  the Markdown link main writes for the terminal, is a link, blue and underlined; red when its place does not exist or
  does not hold its value (`thimble state resolve`); in a card's takeaway, `◌` after it while thimble's links check
  runs, `✓` once it found the value, a red `×` when it found another. The citation under the pointer shows its status in
  plain words on a quiet box (`found in README.md line 3`, `found on the card; its value is not checked`, `not found: …
  does not exist`, and why). The blue `?` beside a passage, in the ⏺'s column (over the ⏺ on the reply's first row),
  asks a side thread about it (a heading's about its whole section, a card's about the card); once one was asked, a
  blue `↳` stays there and opens it. While main streams,
  citations show as links and a card's line as `◌ <its question>`, never `[[…]]`; a citation typed into the prompt is
  blue and underlined too. A chip, a citation that names only its place (`[[card:<id>]]`, `[↗](<ref>)`), reads as its
  place's short name in brackets in the link color, `[ card ]` or `[ events.jsonl line 12 ]`, alike in replies, thread
  answers, documents, takeaways and previews; its tip names the place in full. Every cut is at a word (`hooks/lib.ts` `cut`). Main's end token, `(shown in the dashboard)`, is not
  shown. Off the terminal a cited block is
  Markdown, each citation a link to its file and a problem marked `×`.
- **The footer** under a turn's answer (its last part that cites or embeds a card), one blank row below it: `N citations
  · N cards` dim, `· N problems` in red, `ask about this answer ›`. None for the prompts thimble-term gives main itself.
  There is no `open as report`: thimble keeps one document per type, so an answer would replace the report; main's
  `/thimble:write` writes one.
- **Cards.** Each card a turn of main added or changed (`add_card`, `edit_card`, `apply_label`, `thimble-run card`) is
  drawn once, under the turn's last reply, in its last state. Every card, wherever it is drawn (under a reply, the card
  pane, the citation panel, a document), has a full round border; inside it, the title in bold (in inverse under the
  pointer, a press asks a side thread), one blank row, then the plot or body directly; below the plot the readout (the
  value under the pointer, or the card's state), the label rows (the label's name a link with `↗`, which opens its
  panel; its values in their colors, `changed since` once the label changed after the card ran), the params and the
  takeaway. A card that read a label colors its marks by the label's values. A label card is a bar card of the label's
  counts: its records are in the label panel. A card that cannot be read is one red line (`× card 2 cannot be drawn:
  …`). Claude Code's tool rows stay its own, folded, and no hex id is drawn, in the row or in ctrl+o's detailed view: a
  thimble tool's row names a card by its question (cut at a word, without straight quotation marks Claude Code would
  escape) and a citation by its words, a label tool's result its name and counts, and a side thread's fork row and the
  notice that it finished the thread by its first question, and so does the fork's prompt in ctrl+o; a tool's words draw
  their straight quotation marks curly, which Claude Code does not escape; thimble's tool results keep their card ids, which main
  cites. A bar card keeps the order its chart's label axis sorts, and a bar chart with its values written on its bars is a bar card too; a bar chart with a color field has one row per label, its series stacked in their hues and its key below, and timestamps as labels read as the browser's axis writes them (`May 24`). A table, a timeline, a diagram, an example and a label draw
  directly; a simple bar or line chart draws as text; any other chart as a table of its rows; a note, a custom card, a
  code card and a card type's card as their words.
- **Rows under main's replies.** `↳ thread · "<the turn's question>" · answered` when a side thread's turn ends while the
  panel shows something else (`failed` in red, `new` in green until it is read; a stop, the analyst's or the end of the
  Claude Code session, is not news; main's own `↳ thread` line about that thread is then not drawn; main's
  `↳ The writer …` line is drawn once per writer run, the first time), and `↳ view ·
  <name> · building|built|proposed` under the answer that proposed a view (`failed` in red, `new` once built until
  opened).
- **One row above the prompt**, a toast: what is new in the workspace since home was last opened (`2 new cards`, `new` in
  green), `open ›` opening home, gone once it is opened. Side threads have their `↳` rows and thimble's agents Claude
  Code's agent tray, so no row repeats them.
- **One panel**, on Claude Code's panel chrome: one title row, the path from home, its earlier steps dim and a click
  away and the current step last in the accent color and bold (`home › Threads`; on home, `show all threads` and
  `N new` at the right; no `‹ back`, b goes back), a dim subtitle, a rule, the actions at the bottom after a second rule, and a dim italic row of key hints (`b to go back` only where there is a way back),
  which goes on to a second row where it does not fit, never cut. Claude Code's
  pane title says what it shows (`Citation`, `Threads`, `Label: …`, a card's question, a document's title). Its views:
  home (one column: views, documents, threads, cards by group with the newest open, labels, files by folder and the
  orientation's coverage line); a card with how its last run ended, `run again` (main runs `thimble-run card`), and its
  code with what it printed; a citation (its value as a link with `◌` or a red `×`, its status in plain words, the
  sentence it stands in, its lines with the value marked (the whole line where it shows none), a file's as a window
  that ↑↓ and the wheel scroll through the whole file, or the card it names with the cited mark lit, a `follow-up`
  field when opened from a side thread); the threads (a tree with a root per place, `main` or `report "…"`, the selected
  thread under it with what it is about above its chat: a card in its frame, a file's cited lines, a passage's words,
  cut to 6 rows and `… N more`; a new thread shows it above its field too; `stop` while it answers, `hand back to main` once it answered, the ask field); a label; the documents and one document (a report with its
  contents, a deck or a story one slide or beat at a time, the retell controls; its comments, a check's, Claude's or the
  analyst's, under the passages they are on, ↑↓ to choose one, `r` to resolve it, `v` to show the resolved ones; `e`
  to edit a report as Markdown, its cards as their lines, saved as the browser's editor saves it); the file browser, after the
  browser's Files (folders that nest and fold, each folder's count and size, a `●` in a label's hue after each file a
  label that is on labeled; `f` to find by name and by words, `thimble state find` and `grep`, what it found in place of
  the tree with each matching line and its match lit; the chosen file's preview in the mode it opens in) and a file (the
  modes that fit it, as the browser offers them: `Table` for records and CSV rows, `Transcript`, `Text`, `JSON` one record
  at a time, `Raw`; the chosen record's place and `?`; `f` to find in the file, `thimble state findin`; the labels that are on marking the records they labeled in their
  values' hues, `thimble state marks`; a database's tables and a table's rows, `thimble state tables` and `rows`); an
  agent;
  and the views (a view built in terminal mode drawn by its program, `view.term.js` on the terminal view kit, which
  thimble's view host runs sandboxed while the view shows: docs/terminal-views.md; a view built in browser mode as one
  line that says so).
- **The label panel**, as Matt laid it out: `name:` its name in the accent and bold after a `●` in its color, `type:`
  (`prompt  regex  code`, the one in use on the selection background, the others a click away), `scope:` (its files, a
  field, and how many records), for a label over files `in files:` (`on  off`, o, `thimble act label-show`), then a
  rule; the prompt (or pattern, or code) whole in a field to edit, on the same
  column (`hooks/field.tsx`: a click gives it the keyboard, Enter saves it, `thimble act label`); `run on a sample` and
  `run on all N`, which save what was typed first and run it (`thimble act label-run`), and `stop` (s) while it runs
  (`thimble act label-stop`), `rename` (n) and `delete` (k), whose undo the labels list then offers (u, `thimble act
  label-undelete`); then `▸ counts` (with the values to edit, and each value's `color`, the eighteen label colors
  around the color wheel by the names show_label takes, and `filter`, `thimble act label-show` and `label-filter`),
  `▸ examples` (the held-out agreement; each record under its value, `agree` or another value, `thimble act verdict`;
  `… N more` per value, `thimble state label --rows`; a JSON record's other fields on one dim row cut at whole pairs) and
  `▸ cards` (the cards that use it, each a click away), folded. A label's values take their classes' colors wherever
  they show (`hooks/labels.ts`, `paint.ts` `LABEL_HUES` and `PICKED_HUES`).
  Nothing else shows until it is opened. A code label's code runs only in main's Bash: its run asks main to run the
  `thimble-run label` command it gives.
- **Side threads.** The `?` beside a passage or a card, a press on a card's title or mark, a selection's "ask", or `ask
  about this answer ›` opens the ask field, which posts the thread (`thimble act thread`, with the thread it was asked
  from as its parent, and a document's passage as its anchor); main forks `thread:<name>`, as for the browser's.
- **`/thimble`** opens the home panel, with no model turn; `/thimble threads`, `/thimble cite [n]` (the n-th citation of
  the last reply), `/thimble card [n|id]`, `/thimble files [path[:line]]` and `/thimble documents` open those.

## What it reads and changes

`hooks/data.ts` runs the `thimble` command beside the plugin in thimble's tree (`<tree>/plugin/bin/thimble`;
`THIMBLE_TERM_CLI` names a stand-in for tests and the live check). Each surface prints the JSON of the server's GET
route for it:

| Call | Read as |
| --- | --- |
| `thimble state home --cwd <dir>` | the workspace's counts: `cards`, `labels`, `docs`, `threads`, `views`, `files` (a number or a list each); `views`, each with its `status` (built, building, proposed, failed), `ts` and claimed `files`; and the orientation's `coverage` line |
| `thimble state cards --cwd <dir> --since <iso>` | the canvas route's `{groups, cells}`, the cells changed since |
| `thimble state card --cwd <dir> <id>` | the cell route's cell |
| `thimble state labels --cwd <dir>` / `label --cwd <dir> <id> [--rows <json>]` | the concepts route's list / one concept, with a page of its rows per value (`rows`, as `/rows?text=1` answers; `--rows {"<value>": n}` n of that value) after the records the analyst gave that value, how many records have each value (`totals`) and the value its scope's filter keeps (`filter`) |
| `thimble state docs --cwd <dir>` / `doc --cwd <dir> <slug>` | the document types route's `{slug: {exists, title, …}}` / one document |
| `thimble state threads --cwd <dir>` / `thread --cwd <dir> <id> [--after n]` | the chats route's metas (each with `answers` and `seen`, or `unread`) / `{meta, events}` past `n` |
| `thimble state agents --cwd <dir>` | the agents route's `{rows}` |
| `thimble state files --cwd <dir> [path] [--start n]` | the sources route's list / a page of a file's records |
| `thimble state turns --cwd <dir> <path> [--start n] [--line n]` | a page of a whole-file JSON transcript's turns, parsed from the whole file (GET /source/turns), or none with `none` saying why, for its Transcript tab |
| `thimble state opens --cwd <dir> <paths json>` | `{path: "transcript"}` for each listed file of plain text that opens as a transcript, which the type column shows |
| `thimble state resolve --cwd <dir> <refs json>` | `{ref: resolution}` (the ref route's answer, or `{error}`) for a list of refs |
| `thimble state ui --cwd <dir> --after <n>` | the `ui.jsonl` records past `n` |
| `thimble act thread --cwd <dir> {anchor, anchor_text?, message}` | a new side thread: `{ok, thread}` |
| `thimble act thread-message --cwd <dir> {thread, message}` | a question in a thread |
| `thimble act verdict --cwd <dir> {label, ref, value}` | the analyst's value for a record |
| `thimble act label --cwd <dir> {label, name?, kind?, body?, glob?, values?}` | the label panel's edit, saved as the browser's label editor saves it |
| `thimble act label-show --cwd <dir> {label, on?, values?, colors?}` | a label over files on or off in Files and the views, or its values given colors by name, as the Labels pane and show_label do |
| `thimble act label-filter --cwd <dir> {label, value?}` | the label's scope's filter set to `value`, or cleared when it names the label and no value is given |
| `thimble act label-delete --cwd <dir> {label}` / `label-undelete --cwd <dir> {label}` | a label deleted with its marks, card and filters / its delete undone while it is the last change |
| `thimble act label-run --cwd <dir> {label, limit?}` | a run on a sample (`limit`) or on every record; it answers once the run ends, so the renderer starts it beside the session (`$.process.spawn`), which it ends with; a code label's answer is the `thimble-run label` command (`deferred`) |
| `thimble act label-stop --cwd <dir> {label}` | stop a run `label-run` started, after its current record (the run's process watches for the stop file this writes) |
| `thimble act seen --cwd <dir> {thread}` | the thread's answers read |
| `thimble act hand-back --cwd <dir> {thread}` | a finished thread's answer sent to main as the analyst's message, `From thread "<question>": <answer>` (the thread's meta then says `hand_back: handed`) |
| `thimble act stop --cwd <dir> {agent}` | stop one of thimble's agents, or a side thread's fork |
| `thimble state checks --cwd <dir>` | the report checks route's list: each check's name, color, `shown` and runs, which name a document's comments |
| `thimble act comment-resolve --cwd <dir> {doc, comment}` / `comment-reopen` | a document's comment resolved, as the browser's margin's ✓ does, or opened again |
| `thimble act doc-save --cwd <dir> {doc, title?, blocks}` | a report edited as Markdown, saved as the browser's editor saves it (PUT …/blocks): each block with the id of the unit it was built from, so a kept passage keeps its id and its comments |
| `thimble view host --cwd <dir>` | thimble's view host, started beside the session the first time a view opens (`$.process.spawn`): it prints `{t: ready, socket, token}`, then the frames a view's program draws on its own; the panel posts `/open`, `/event` and `/close` to the socket (`$.http.fetch`, `hooks/viewhost.ts`) |

It sees a change without starting Python: once a second it lists the workspace's folders (`notebooks`, `concepts`,
`labels`, `investigations/main`, `checks`, `chats`, `trusted/subagents.json`, `orient/run.json`, `extension/views`,
`views/proposals.json`, `ui.jsonl`) and reads again only the surfaces a drawing shows.

## Files

`hooks/register.tsx` holds the hooks and the one place `$` is used (Claude Code follows `$` into no import);
`hooks/ctx.ts` is what it shares with the rest (the answer footer, the `↳` rows, the stream and `/thimble`'s words are
in register.tsx too). `hooks/term.ts` keeps what it read and the panel's moves, `hooks/reply.tsx` draws main's chat,
`hooks/panel.tsx` the panel, `hooks/filesview.tsx` its file browser and a file, `hooks/lines.tsx` the parts drawn from styled lines (homeview.tsx), `hooks/cell.ts` turns a
thimble cell into the drawing's card form, `hooks/model.ts` reads the other surfaces, `hooks/data.ts` runs the command.
The drawing itself: `draw.ts` lays out cards and charts as styled lines, `card.tsx` draws a card (its border the
drawing's, its title a hot spot, everything but the title below the plot), `cite.ts` and `para.tsx` citations and their
tips, `home.ts` and `homeview.tsx` home, `chrome.tsx` the panel's chrome, `paint.ts` the colors, `gestures.tsx` what a
press does, `anim.ts` the mark a citation lights on a card, `nav.ts` the path from home and the threads tree,
`signal.ts` the `↳` rows' rules, `report.ts` a document's comments and its edit as Markdown, `docedit.tsx` the document's editor, `files.ts` the file browser's pure parts (the file a ref cites, the folder tree, a file's modes, the labels that are on
and the values they gave its records, what a find found, the turns a whole-file JSON transcript's view reads), `turns.ts` one drawing of a pane at a time, `lib.ts`
the pure helpers, `field.tsx` the text field that shows all of its text (a label's prompt), `kept.ts` what main's
chat drew under its rows, kept for a resume, `viewhost.ts` thimble's view host and the open view's frame, and
`viewclient.tsx` a view's frame drawn with its hot regions and tips.

## Tests

From `mods/thimble-term`:

    claude plugin validate .
    claude plugin test .
    npx -p typescript tsc -p . --noEmit

`tsc` needs the types Claude Code writes into `.claude-plugin/types/` when it loads the plugin, for example in a session
started with `claude --plugin-dir .`. The tests answer `thimble state` and `thimble act` from fixture states
(`tests/fixtures.ts`).
