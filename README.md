<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

thimble is a plugin for Claude Code. It helps you and Claude work through a large amount of data, such as the
transcripts and logs that agents leave behind, without leaving the terminal.

You ask Claude questions as usual. thimble adds three things:

- **Cards.** When a chart or a table shows the answer better than a paragraph, Claude draws a card under its reply.
  You can open a card to see each of its parts, the rows behind each part, and the code that made it.
- **Citations.** Numbers in Claude's replies link to the rows they were counted from. You can open each one and read
  those rows.
- **A second reader.** After each reply, a side agent reads the reply and the work behind it. It leaves notes for
  Claude about anything that needs a fix, suggests another view when one would help, and explains terms you may not
  know.

> [!CAUTION]
> thimble is a research prototype and changes often. It is not an official Anthropic product.

## Install

You need Claude Code, Python 3.10 or later with pandas, and Node.js 22 or later. Then:

```
claude plugin marketplace add safety-research/thimble
claude plugin install thimble@thimble
```

[INSTALL.md](INSTALL.md) has the details, how to check that it works, and what to do when it does not.

## Use

1. Go to a folder with your data: JSONL, CSV, TSV, JSON, SQLite, Markdown or plain text files. Subfolders are fine.
2. Start Claude Code with `claude`, and ask a question about the data.

Claude reads and queries the files with the `thimble` command. thimble keeps the code, the inputs and the source rows
behind every value Claude reports, in a `thimble/` folder beside your data, so each number can be traced back.

### Keys

When the prompt is empty, a few keys act on Claude's latest reply. The line above the prompt always lists the keys
that work at that moment, so you do not need to learn them first.

| Key | What it does |
|---|---|
| `v` | Asks Claude for another view of the reply, as a card. When the side agent has a view in mind, `v` is lit and offers it. |
| `s` | Rewrites the reply in place: shorter or longer, more or less interpretation, for a newcomer or an expert. When two or more replies came since your last prompt, `s` offers one catch-up message of all of them. |
| `]` `[` | Step through the citations and explained terms in the reply, then its cards. |
| `1` | Opens the card or citation you stepped to. |
| `{` `}` | Pick an earlier or a later reply. |
| `0` or `esc` | Close. |

A citation opens in a tray above the prompt: `r` shows its rows, `c` the code behind it, and `1` lets you ask a
question about it in a side thread that the main conversation does not see.

A card opens in a detail view beside the chat: arrow keys select a part, `↵` shows its details, `e` its example rows,
`p` its program and `h` its earlier versions. Text you type there is a question for that card's side thread.

If you type a word that starts with one of these letters, thimble gives the letter back to the prompt.

### Commands

- `/card [name]` opens a card's detail view. On a terminal narrower than 144 columns, use it in place of `1`.
- `thimble --help`, in your shell, lists the commands Claude uses: `thimble run`, `thimble save`, `thimble rows`,
  `thimble coverage` and `thimble label`. You can run them too.

## What it costs

The side agent makes one model call after each of Claude's replies, with your session's model. A `--prompt` label
makes one call per 50 records. A rewrite with `s` makes one call. All calls go through your Claude Code login and
show in your usage like any other. To turn the side agent off, run `/plugin configure thimble@thimble` in Claude Code
and set Observer to off.

## What it stores

- `thimble/`, in your data folder: the queries Claude ran, the cards, the labels and a record of each reply.
- `~/.thimble/` (or the folder in `THIMBLE_HOME`): where each card is drawn, per session, so `claude --resume` shows
  them again, and a log of thimble's own model calls.

thimble sends nothing anywhere except through your Claude Code session, and starts no other Claude Code process.

## Develop

The plugin is the `plugin/` folder:

| Folder | What it holds |
|---|---|
| `plugin/engine` | the kernel in Python, which the `thimble` command runs (`plugin/bin/thimble`) |
| `plugin/shell` | the hooks that draw cards, citations and the bar in the terminal |
| `plugin/draw` | the card runtime: a card's program draws through it, in a sandbox |
| `plugin/panes` | the detail view, the tray and the bar, as programs on the same runtime |
| `plugin/observer` | the side agent that reads each reply |
| `plugin/squeeze` | the rewrite behind `s` |
| `plugin/prompts`, `plugin/skills` | the texts the model reads |

To try a checkout, start Claude Code with `claude --plugin-dir plugin`. `scripts/check.sh` runs the same checks as CI:
the plugin's validation, its hooks tests, the Node tests and the Python tests.

## License

Apache-2.0; see [LICENSE](LICENSE).
