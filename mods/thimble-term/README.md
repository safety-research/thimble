# thimble-term

thimble's terminal-mode renderer: a Claude Code plugin of function hooks that draws thimble's work in the terminal.
`thimble mode terminal` once in a folder, then `thimble`, starts Claude Code with thimble's plugin and this one
(`--plugin-dir <tree>/mods/thimble-term`), with no server, no port and no browser. Browser mode does not load it.

It only draws. It registers no model tools, agents, guidance or commands, and it keeps no data except what is on
screen: what it draws comes from `thimble state`, and every change it makes goes through `thimble act`. It is idle in
any session whose `THIMBLE_WS` does not name a workspace with `mode: "terminal"` in its `trusted/launch.json`.

## What it draws

- **Main's replies** on thimble-cc-mod's grid (`views/SPEC.md`, "The visual system", copied unchanged from the mod).
  Each citation, `[[value|ref]]` or the Markdown link main writes for the terminal, is a link; it is red when its place
  does not exist or does not hold its value (`thimble state resolve`). Main's end token, `(shown in the dashboard)`, is
  not shown.
- **Cards.** Each card a turn of main added or changed (`add_card`, `edit_card`, `apply_label`, `thimble-run card`) is
  drawn once, under the turn's last reply, in its last state, with its takeaway under it. Claude Code's tool groups
  stay folded, and no hex id is drawn: a thimble tool's row names a card by its question. A table, a timeline, a
  diagram, an example and a label draw directly; a simple bar or line chart draws as text; any other chart as a table
  of its rows; a note, a custom card, a code card and a card type's card as their words.
- **The rows above the prompt:** what the workspace holds (`home ›`) and side threads with answers not read.
  thimble's agents show in Claude Code's own agent tray, so no row repeats them.
- **One panel:** home (documents, side threads, cards by group, labels, files), a card whole with its code, a
  citation's place with the value marked, a side thread, a label with its records and agree / disagree, the documents
  and one document with its figures as cards, the files and a file's lines, an agent, and a view as one line (the
  browser draws views). Its top row is its path (`‹ back`, the steps from home, `threads`).
- **Side threads.** Right-click a card, a citation or a sentence and choose "ask about it", or press `?` beside a
  passage, or select text and press "ask". The ask field posts the thread (`thimble act thread`) and main forks
  `thread:<name>`, as for the browser's. When an answer comes in while the panel shows something else, a row under
  main's latest row says so (`↳ thread · "…" · answered`, `new` in bold until it is read).
- **`/thimble`** opens the home panel, with no model turn.

## What it reads and changes

`hooks/data.ts` runs the `thimble` command beside the plugin in thimble's tree (`<tree>/plugin/bin/thimble`;
`THIMBLE_TERM_CLI` names a stand-in for tests and the live check). Each surface prints the JSON of the server's GET
route for it:

| Call | Read as |
| --- | --- |
| `thimble state home --cwd <dir>` | the workspace's counts: `cards`, `labels`, `docs`, `threads`, `views`, `files` (a number or a list each), and `views` and `coverage` for the home panel |
| `thimble state cards --cwd <dir> --since <iso>` | the canvas route's `{groups, cells}`, the cells changed since |
| `thimble state card --cwd <dir> <id>` | the cell route's cell |
| `thimble state labels --cwd <dir>` / `label --cwd <dir> <id>` | the concepts route's list / one concept, with a page of its rows (`rows`, as `/rows?text=1` answers) |
| `thimble state docs --cwd <dir>` / `doc --cwd <dir> <slug>` | the document types route's `{slug: {exists, title, …}}` / one document |
| `thimble state threads --cwd <dir>` / `thread --cwd <dir> <id> [--after n]` | the chats route's metas (each with `answers` and `seen`, or `unread`) / `{meta, events}` past `n` |
| `thimble state agents --cwd <dir>` | the agents route's `{rows}` |
| `thimble state files --cwd <dir> [path] [--start n]` | the sources route's list / a page of a file's records |
| `thimble state resolve --cwd <dir> <refs json>` | `{ref: resolution}` (the ref route's answer, or `{error}`) for a list of refs |
| `thimble state ui --cwd <dir> --after <n>` | the `ui.jsonl` records past `n` |
| `thimble act thread --cwd <dir> {anchor, anchor_text?, message}` | a new side thread: `{ok, thread}` |
| `thimble act thread-message --cwd <dir> {thread, message}` | a question in a thread |
| `thimble act verdict --cwd <dir> {label, ref, value}` | the analyst's value for a record |
| `thimble act seen --cwd <dir> {thread}` | the thread's answers read |
| `thimble act stop --cwd <dir> {agent}` | stop one of thimble's agents |

It sees a change without starting Python: once a second it lists the workspace's folders (`notebooks`, `concepts`,
`labels`, `investigations/main`, `chats`, `trusted/subagents.json`, `orient/run.json`, `ui.jsonl`) and reads again only
the surfaces a drawing shows.

## Files

`hooks/register.tsx` holds the hooks and the one place `$` is used (Claude Code follows `$` into no import);
`hooks/ctx.ts` is what it shares with the rest. `hooks/term.ts` keeps what it read and the panel's moves,
`hooks/reply.tsx` draws main's chat, `hooks/panel.tsx` the panel, `hooks/cell.ts` turns a thimble cell into the mod's
card form, `hooks/model.ts` reads the other surfaces, `hooks/data.ts` runs the command. The drawing files are copied
from `mods/thimble-cc-mod/hooks/`: `anim.ts`, `card.tsx`, `cite.ts`, `gestures.tsx`, `homeview.tsx`, `lib.ts`, `nav.ts`,
`paint.ts`, `para.tsx`, `signal.ts` and `turns.ts` unchanged; `draw.ts` with the `note` and `text` card kinds,
`home.ts` with a file's `listed` state, `files.ts` with `fileRef` alone.

## Tests

From `mods/thimble-term`:

    claude plugin validate .
    claude plugin test .
    npx -p typescript tsc -p . --noEmit

`tsc` needs the types Claude Code writes into `.claude-plugin/types/` when it loads the plugin, for example in a session
started with `claude --plugin-dir .`. The tests answer `thimble state` and `thimble act` from fixture states
(`tests/fixtures.ts`).
