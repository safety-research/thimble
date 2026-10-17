# thimble's terminal UI

thimble's terminal UI: the function hooks of thimble's plugin that draw thimble's work in Claude Code (the files of
`plugin/hooks/term/`, loaded with the agent bridge and file guard `plugin/hooks/thimble.ts` as one hooks module,
`plugin/hooks/register.ts`). It loads in every Claude Code session and stays quiet until thimble is on in it: before
that every hook passes through, except the path test of Read and Bash calls and `/thimble`, and it writes, spawns,
fetches and draws nothing.

**Turning on** (`activate.ts`). thimble is a regular Claude Code plugin: it turns on at the start of every session
with a person at the terminal (register.tsx, `session.start`), quietly staying off in a folder `thimble activate`
refuses; also at `/thimble` (which asks a refused folder again) and with the `thimble` command (`THIMBLE_OPEN=1`).
Reading data turns nothing on. Activation runs `thimble activate --mod --json` once (parallel calls share it
within their hook budget; a refused folder is asked once per session), pushes `load_thimble` to the shim with
`$.mcp.call` so thimble's tools are listed, tells `thimble.ts` (`bridgeActivated`) and hands thimble's guide to Claude
as the Read's context. The guide goes again when it is owed: with a prompt, with `/thimble`, after a compaction (a
hidden user row) and after `/clear`; it is marked sent only once the row that carries it is stored. A module reload
and a resumed session restore from the session's marker, `<home>/up/<session>.active`.

What it draws comes from `thimble state`, and every change it makes goes through `thimble act`. It registers no model
tools or agents; the one call it changes is main's Agent call for a side thread's fork, which runs with the thread's
question as its description, so that Claude Code's agent tray and exit dialog name the thread by it (its prompt keeps
`thread:<name>`, by which thimble knows the fork). The one file it writes is the workspace's `terminal/chat.json`
(`kept.ts`): what main's chat drew under each of its rows (the turn's cards, the answer's footer, the `↳` rows), by the row's uuid, which Claude Code keeps across `--continue` and `--resume`, so a resumed session draws it
again. It writes to main only when the analyst asks it to: a code label's run and a card's `run again` (code runs only
in main's Bash) and a new label described in the labels list go to main as the analyst's prompt, and a document's `as
slides` or `as a story` runs `/thimble:write`.

**Coverage** (`tracker.ts`). What Claude's tool calls read of the data files (a Read by its result: whole, part, a
PDF's pages; Bash readers; searches, which touch a file's contents without showing them; a recursive grep over a
folder), data files only and never the command's text, goes once per turn to `thimble act coverage --stdin`; the
session's summary it answers is the thimble line's `coverage` (the read share of the data by size), whose press opens
the panel's Coverage view. No line stands under the answer.

**Checks on answers.** A check's comment on a passage of Claude's answer tints the passage in the check's color (the
browser's label color of its place) with a flag `⚑` in that color in the margin on the passage's first row; a click on
either opens the panel at Checks. On the main screen (classic) an answer taller than the screen keeps no tint (Claude
Code reprints the transcript when such a row changes): its comments show in the panel.

**Settings** (`settings.ts`). The six switches (`/config` → thimble: View proposals, Labels, Checks, Citation marks, Coverage, Card check) stay in step with thimble's config, which the
browser's Settings writes. Coverage off draws no line and keeps no facts; Citation marks off draws citations as plain
links and checks none; Checks off draws no tint.

**Colors** (`palette.gen.ts`). The cards' series and the label colors are the browser's tokens (light paper on a light
Claude Code theme, Dark on any other), written by `scripts/dev/sync_palette.py`.

## What it draws

Its look is [SPEC.md](SPEC.md) ("The visual system"): one left edge, links blue and underlined, `new` in green,
Claude Code's panel chrome, no right-click menu.

- **Main's replies.** The model's Markdown as Claude Code draws it (bold bold, headings bold, inline code colored). The
  prose and the cards share one left edge, column 2, Claude Code's own (the ⏺ row's text), and one width: the
  terminal's, less 2 and the margin, with no measure; the cards follow the text and each other border to border. Each citation, `[[value|ref]]` or
  the Markdown link main writes for the terminal, is a link, purple and underlined; while it is checked (its place
  resolved by `thimble state resolve`, and in a card's takeaway thimble's links check) a purple `◌` follows it a space
  after, neither underlined (`3,934 ◌`); nothing once it is found (never `✓`), and no words beside one a check rewrote;
  red with a red `×` when its place does not exist or does not hold its value, or the links check found another. A
  time (`14:52:11`) is a value, as a number is. Inside a card every citation and evidence link (an example's `↗
  events.jsonl line 197`) is in the citation's purple. The citation under the pointer shows its status in plain words
  on a quiet box (`found in README.md line 3`, `found in README.md line 5; only its place is checked`, `not found: …
  does not exist`, and why). A dim `·` beside a passage, in the ⏺'s column, becomes a blue `?` under the pointer (over
  the ⏺ on the reply's first row), which asks a side thread about it (a heading's about its whole section, a card's about the card); once one was asked, a
  blue `↳` stays there and opens it. While main streams,
  citations show as links and a card's line as `◌ <its question>`, never `[[…]]`; a citation typed into the prompt is
  blue and underlined too. A chip, a citation that names only its place (`[[card:<id>]]`, `[↗](<ref>)`), reads as its
  place's short name in brackets in the link color, `[ card ]` or `[ events.jsonl line 12 ]`, alike in replies, thread
  answers, documents, takeaways and previews, except a whole card's chip in a thread's answer, which is the card itself,
  drawn after its paragraph; its tip names the place in full. Every cut is at a word (`hooks/lib.ts` `cut`). Main's end token, `(shown in the dashboard)`, is not
  shown. Off the terminal a cited block is
  Markdown, each citation a link to its file and a problem marked `×`.
- **The footer** under a turn's answer (its last part that cites or embeds a card), one blank row below it: `N citations
  · N cards` dim, `· N problems` in red, `ask about this answer ›`. None for the prompts thimble-term gives main itself.
  There is no `open as report`: thimble keeps one document per type, so an answer would replace the report; main's
  `/thimble:write` writes one.
- **Cards.** Each card a turn of main added or changed (`add_card`, `edit_card`, `apply_label`, `thimble-run card`) is
  drawn once, under the turn's last reply, in its last state. Every card, wherever it is drawn (under a reply, the card
  pane, the citation panel, a document), has a full round border; inside it, the title in bold, wrapped and never cut (in
  inverse under the pointer, a press asks a side thread), with the card's id dim at the right of its first row
  (`card:<name>`, as its chips read it), one blank row, then the plot or body directly; below the plot the readout (the
  value under the pointer, or the card's state), the label rows (the label's name a link with `↗`, which opens its
  panel; its values in their colors, `changed since` once the label changed after the card ran), the params and,
  after a blank row, the takeaway. A card that read a label colors its marks by the label's values. A label card is a bar card of the label's
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
  `↳` line about a run of one of thimble's agents, `↳ The writer …` or `↳ The view builder …`, is drawn once, for the
  run's hand-back or its task notification, whichever came first), and `↳ view ·
  <name> · building|built|proposed` under the answer that proposed a view (`failed` in red, `new` once built until
  opened).
- **The thimble line above the prompt**, while thimble is on, after one blank row: `thimble` (its press opens home),
  then `cards`, `threads`, `citations`, `labels`, `checks` and `coverage` with their counts, a purple `•` for what is
  new; each name's press opens its section (band.tsx). Side threads have their `↳` rows and thimble's agents Claude
  Code's agent tray, so no row repeats them.
- **Every row above the prompt is one line**: a dim label column, the words cut with `…` where the acts begin (a press
  shows them whole), the acts at the right in the accent, underlined under the pointer, the main one bold.
- **A view proposal above the prompt**, while one waits for an answer: `view proposal`, the view's name in bold and as
  much of what it would show as fits (the name's press shows it all), then `accept` (thimble builds it), `reject`,
  `don't ask again`, which turns view proposals off, and `dismiss`; why accept could not start the build, and the fix,
  in red under it. To turn
  view proposals back on after `don't ask again`, set `"views": {"propose": true}` in thimble's config
  (`~/.thimble/config.json`, or the workspace's `config.json` when it sets the key), or take the key out.
- **Every agent's failures above the prompt**, newest first, under the view proposal: a notice for each failure of any
  agent thimble runs (the orientation and its helpers, the critic, writers, view builds, report checks, code tickets,
  card checks, labels, the view proposer), since Claude Code's own output shows only main's: `notice` in red, its
  words, which name the agent and the failure, then the acts that fix it (`try again`, `retry`, `turn off view
  proposals`; `how to fix it` says where thimble's config is, the terminal's Settings), the agent's thread named for
  what opens (`see the orientation ›`), and `dismiss`.
- **One panel**, on Claude Code's panel chrome: one title row, the path from home, its earlier steps dim and a click
  away and the current step last in the accent color and bold (`home › Threads`; on home, `show all threads` and
  `N new` at the right; no `‹ back`, b goes back), a dim subtitle, a rule, the actions at the bottom after a second rule, and a dim italic row of key hints (`b to go back` only where there is a way back),
  which goes on to a second row where it does not fit, never cut. Claude Code's
  pane title says what it shows (`Citation`, `Threads`, `Label: …`, a card's question, a document's title). Its views:
  home (one column: views, documents, threads, cards by group with the newest open, labels, files by folder and the
  orientation's coverage line); a card with how its last run ended, `run again` (main runs `thimble-run card`), and its
  code with what it printed; a citation (its value as a link, red once it failed; the card or the sentence it stands
  in; its place as a purple `↗` link; its lines with the value on the citation's purple (the whole line where it shows
  none), a file's as a window that ↑↓ and the wheel scroll through the whole file, or for a value on a card the card's
  data row and code that hold it, never the plot; one bar above the entry box, `checked ›   history N ›` (`◌ checking …`
  while it is checked, `failed × ›` in red), its state word (`v`) opening how it was verified (what thimble read, the
  code that computed or printed the value, what the links check got, why it failed, or `ask for a script`, which asks
  a side thread for one, whose script then shows) and `history` (`h`) what Claude wrote and what the check made it; its
  entry box going on in the side thread it was opened from); the threads (a tree with a root per place, `main` or `report "…"`, one row a
  thread while one is open; the selected thread under it, or alone with no tree when it is the only one: what it is
  about on one dim row, `v` showing it whole (a card in its frame, a file's cited lines, a passage's words), then its
  chat as Claude Code draws one, each question after `❯` on the prompt's background and each answer after `⏺`, its
  cards where it cites them, a turn at work as `⏺ ◌ N tool calls` with its latest words after `⎿`, a stop or a failure
  on a `⎿` row under its question; a new thread shows its subject above its entry box, cut to 6 rows and `… N more`;
  `stop` while it answers, the entry box); a label; the documents and one document (a report with its
  contents, a deck or a story one slide or beat at a time, the retell controls; its comments, a check's, Claude's or the
  analyst's, under the passages they are on, ↑↓ to choose one, `r` to resolve it, `v` to show the resolved ones; read
  only: `o` or `↗` opens it in the browser workbench, which edits it); no file browser (0.9.0:
  Coverage lists the files), but a file opened to verify a place, a citation's, a label's record or a card's source (the
  modes that fit it, as the browser offers them: `Table` for records and CSV rows, `Transcript`, `Text`, `JSON` one record
  at a time, `Raw`; the chosen record's place and `?`; `f` to find in the file, `thimble state findin`; the labels that are on marking the records they labeled in their
  values' hues, `thimble state marks`; a database's tables and a table's rows, `thimble state tables` and `rows`); an
  agent;
  and the views (a view built in terminal mode drawn by its program, `view.term.js` on the terminal view kit, which
  thimble's view host runs sandboxed while the view shows: docs/terminal-views.md; a view built in browser mode as one
  line that says so).
- **The label panel**, as Matt laid it out (mockup labelpanel2), every field exposed and editable as in the browser's
  label editor: `name:` (a field after a `●` in its color, Enter renames it), `kind:` (`prompt  regex  code`, the one
  in use on the selection background, the others a click away), a prompt label's `model:` (its model by its id, a
  choice: a click shows the models, a pick saves it, `thimble act label {model}`), `unit:` (records of files, cards or
  sentences, the one it has), `scope:` (its glob in a field, then how many files match and records they hold, `· 1
  file matches · 44 lines`), for a label over files `mark records in Files and views:  on  off` (f, `thimble act
  label-show`); then a rule and the prompt (or pattern, or code) whole in a bordered field to edit (`hooks/field.tsx`:
  a click gives it the keyboard, Enter saves it, `thimble act label`; code colored; a pattern says what a match
  gives); then `values:`, each value's `●`, its bar and its count bold, a click on a value showing its `color` (the
  eighteen label colors around the color wheel by the names show_label takes), `filter` and the values to edit
  (`thimble act label-show`, `label-filter`, `label`); the last run, then its actions underlined in the accent,
  `delete` in red: `run on a sample` and `run on all`, which save what was typed first and run it (`thimble act
  label-run`), and `stop` (s) while it runs (`thimble act label-stop`), `rename` (n, the name's field) and `delete`
  (k), whose undo the labels list then offers (u, `thimble act label-undelete`); then `▸ examples` (the held-out
  agreement; each record under its value, `agree` or another value, `thimble act verdict`; `… N more` per value,
  `thimble state label --rows`; a JSON record's other fields on one dim row cut at whole pairs) and `▸ cards` (the
  cards that use it, each a click away), folded. A label's values take their classes' colors wherever they show
  (`hooks/labels.ts`, `paint.ts` `LABEL_HUES` and `PICKED_HUES`). A code label's code runs only in main's Bash: its
  run asks main to run the `thimble-run label` command it gives.
- **Side threads.** The `?` beside a passage or a card, a press on a card's title or mark, a selection's "ask", or `ask
  about this answer ›` opens a new thread's entry box, which posts the thread (`thimble act thread`, with the thread it
  was asked from as its parent, and a document's passage as its anchor); main forks `thread:<name>`, as for the
  browser's. A citation, a card, a check's comment and a document's chosen comment have an entry box of their own at
  their panel's bottom (`entry.tsx`, Claude Code's prompt box: a rule above and below, `❯`, two rows that grow with the
  text), where a question typed and Enter start the thread about them, opened over them; while a box has the keys the
  panel draws no key-hint row.
- **`/thimble`** turns thimble on in the folder and opens the home panel, with no model turn; `/thimble browser` opens the
  browser workbench; `/thimble coverage`, `citations`, `checks`, `threads`, `cite [n]` (the n-th citation of the last
  reply), `card [n|id]`, `files <path[:line]>` and `documents` open those; `fresh`, `restore`, `status`, `fix` and
  `feedback` are the skill's.
- **A card's ↗.** In fullscreen a card's border row ends with a `↗` that opens the card in the browser; a custom card
  reads `a custom card · the browser draws it ↗`.

## What it reads and changes

`data.ts` runs the plugin's own `thimble` command (`<plugin>/bin/thimble`; `THIMBLE_TERM_CLI` names a stand-in for tests
and the live check). Each surface prints the JSON of the server's GET route for it; activation, the guide, the
switches and coverage have their own:

| Call | What for |
| --- | --- |
| `thimble activate --cwd <dir> --session <sid> --via data\|command\|launcher [--rekey-from <old>] --mod --json` | thimble on in the folder for this session (C2): the workspace, or a refusal with its fix |
| `thimble guide --cwd <dir> --session <sid> [--if-owed] [--mark\|--unmark]` | the guide (C3), only when owed with `--if-owed`; marked sent, or owed again |
| `thimble features --cwd <dir> --json [--set <key>=on\|off …]` | the seven switches thimble holds (C6), after any change |
| `thimble act coverage --cwd <dir> --stdin` | a turn's coverage facts on standard input (C7): the session's summary and its line |
| `thimble state coverage --cwd <dir> --session <sid> --summary` | the session's coverage summary, read again when the coverage folder changes |
| `thimble state answer-comments --cwd <dir> --session <sid> --status open` | the checks' comments on this session's answers and the checks reading one now (C9) |


| Call | Read as |
| --- | --- |
| `thimble state home --cwd <dir>` | the workspace's counts: `cards`, `labels`, `docs`, `threads`, `views`, `files` (a number or a list each); `views`, each with its `status` (built, building, proposed, failed), `ts` and claimed `files`; the orientation's `coverage` line; `offer`, the view proposal waiting for an answer (`slug`, `name`, `description`, `task`, `claims`, `refused`), null while none waits and while view proposals are off; and `notices`, every agent's open notices, newest first (`id`, `agent`, `text`, `chat`, `open`: `thread`, `agent` or none, and `acts`, the acts that fix it) |
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
| `thimble act stop --cwd <dir> {agent}` | stop one of thimble's agents, or a side thread's fork |
| `thimble act view-accept --cwd <dir> {slug}` / `view-reject` | the view proposal accepted (its build queued) or rejected, as the browser's Accept and Reject do; it answers `{queued: true}` at once and thimble's hook process writes the answer, or `{queued: false, reason}` when the proposal no longer waits |
| `thimble act view-proposals-off --cwd <dir> {}` | view proposals off (`views.propose: false` in thimble's config), as Don't ask again does; `{off, config}` names the file written |
| `thimble act view-propose-now --cwd <dir> {notice?}` / `view-retry --cwd <dir> {slug, notice?}` | a notice's act: check for a view proposal now, or build again a view whose build failed, run by thimble's hook process, which first dismisses the notice it was pressed on (`notice`, its id) |
| `thimble act notice-dismiss --cwd <dir> {id}` | a notice dismissed, as its × in the browser does, written by thimble's hook process |
| `thimble state checks --cwd <dir>` | the report checks route's list: each check's name, color, `shown` and runs, which name a document's comments |
| `thimble act comment-resolve --cwd <dir> {doc, comment}` / `comment-reopen` | a document's comment resolved, as the browser's margin's ✓ does, or opened again |
| `thimble act doc-save --cwd <dir> {doc, title?, blocks}` | a report edited as Markdown, saved as the browser's editor saves it (PUT …/blocks): each block with the id of the unit it was built from, so a kept passage keeps its id and its comments |
| `thimble view host --cwd <dir>` | thimble's view host, started beside the session the first time a view opens (`$.process.spawn`): it prints `{t: ready, socket, token}`, then the frames a view's program draws on its own; the panel posts `/open`, `/event` and `/close` to the socket (`$.http.fetch`, `hooks/viewhost.ts`) |

It sees a change without starting Python: once a second it lists the workspace's folders (`notebooks`, `concepts`,
`labels`, `investigations/main`, `checks`, `chats`, `trusted/subagents.json`, `orient/run.json`, `extension/views`,
`views/proposals.json`, `ui.jsonl`, `coverage`, `answer-comments.json`) and thimble's `config.json`, and reads again only
the surfaces a drawing shows.

## Files

`register.tsx` holds the hooks (the answer footer, the `↳` rows, the stream and `/thimble`'s words
too); `ctx.ts` builds from each hook's `$` the context the other files take (`cxOf`: a hooks module passes `$` only to
a function of its own file or one imported from the module's files); `contracts.ts` the contracts with the panel's files;
`activate.ts` turning on and the guide, `tracker.ts` coverage facts, `settings.ts` the switches, `band.tsx` the rows above
the prompt. `hooks/term.ts` keeps what it read and the panel's moves, `hooks/reply.tsx` draws main's chat,
`hooks/panel.tsx` the panel, `hooks/filesview.tsx` a file, `hooks/lines.tsx` the parts drawn from styled lines (homeview.tsx), `hooks/cell.ts` turns a
thimble cell into the drawing's card form, `hooks/model.ts` reads the other surfaces, `hooks/data.ts` runs the command.
The drawing itself: `draw.ts` lays out cards and charts as styled lines, `card.tsx` draws a card (its border the
drawing's, its title a hot spot, everything but the title below the plot), `cite.ts` and `para.tsx` citations and their
tips, `home.ts` and `homeview.tsx` home, `chrome.tsx` the panel's chrome, `paint.ts` the colors, `gestures.tsx` what a
press does, `anim.ts` the mark a citation lights on a card, `nav.ts` the path from home and the threads tree,
`signal.ts` the `↳` rows' rules, `report.ts` a document's comments, `files.ts` the file browser's pure parts (the file a ref cites, the folder tree, a file's modes, the labels that are on
and the values they gave its records, what a find found, the turns a whole-file JSON transcript's view reads), `turns.ts` one drawing of a pane at a time, `lib.ts`
the pure helpers, `field.tsx` the text field that shows all of its text (a label's prompt), `kept.ts` what main's
chat drew under its rows, kept for a resume, `viewhost.ts` thimble's view host and the open view's frame, and
`viewclient.tsx` a view's frame drawn with its hot regions and tips.

## Tests

From `plugin`:

    claude plugin validate .
    claude plugin test .
    npx -p typescript tsc -p hooks/term --noEmit

`tsc` needs the types Claude Code writes into `plugin/.claude-plugin/types/` when it loads the plugin, for example in a
session started with `claude --plugin-dir plugin`. The tests answer `thimble state`, `thimble act`, `thimble
activate|guide|features` and the shim's `load_thimble` from fixture states (`tests/fixtures.ts`); thimble is on in the
fixtures' session from its start (its marker is there) unless a test starts it off. `tests/data-file-cases.ts` is the one
case list of the data rule, which the backend's coverage tests read too. `python3 scripts/dev/sync_palette.py --check`
says whether `palette.gen.ts` is stale.
