<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

thimble helps you and Claude work through a large amount of data, such as the transcripts and logs that agents leave
behind. It comes in two forms, both in this repository:

- **The terminal plugin** (`plugin/`), for Claude Code. You ask Claude questions in the terminal as usual, and thimble
  adds cards, citations and a second reader to its replies.
- **The browser workbench** (`browser/`), a web page for a folder of files, with a file browser, a chat with Claude, a
  canvas of cards and a report. Run `thimble-browser` in a folder of files to start it. It runs on your machine and
  calls the Claude API with your own credentials.

> [!CAUTION]
> thimble is a research prototype and changes often. It is not an official Anthropic product.

## Install

```
git clone https://github.com/safety-research/thimble
cd thimble
scripts/install.sh
```

The script installs both. It first checks what they need and says what is missing: Claude Code, Python 3.10 or later
with pandas, and Node.js 22 or later for the plugin; Node.js 22.12 or later and [uv](https://docs.astral.sh/uv/) for
the browser workbench. The browser workbench takes about 600 MB of disk, most of it its page's packages and its
server's Python packages, so install the plugin alone if that is all you need:

- `scripts/install.sh --no-browser` installs the terminal plugin only. So do these two commands, with no clone:
  `claude plugin marketplace add safety-research/thimble`, then `claude plugin install thimble@thimble`.
- `scripts/install.sh --no-plugin` installs the browser workbench only.

Running the script again is safe, and updates both. [INSTALL.md](INSTALL.md) has the details, how to check that each
works, and what to do when it does not.

## The terminal plugin

You ask Claude questions as usual. thimble adds three things:

- **Cards.** When a chart or a table shows the answer better than a paragraph, Claude draws a card under its reply.
  You can open a card to see each of its parts, the rows behind each part, and the code that made it.
- **Citations.** Numbers in Claude's replies link to the rows they were counted from. You can open each one and read
  those rows.
- **A second reader.** After each of Claude's replies, a side agent reads it with the whole session and the work
  behind it. It suggests another view when one would help, explains terms you may not know, marks the details that
  are easy to miss, and keeps the session's claims. A click on `thimble` at the bar's left (or `/thimble-settings`)
  turns each feature on or off, and shows how the bar changes as you do.

### Use

1. Go to a folder with your data: JSONL, CSV, TSV, JSON, SQLite, Markdown or plain text files. Subfolders are fine.
2. Start Claude Code with `claude`, and ask a question about the data.

Claude reads and queries the files with the `thimble` command. thimble keeps the code, the inputs and the source rows
behind every value Claude reports, in a `thimble/` folder beside your data, so each number can be traced back.

#### Keys

When the prompt is empty, a few keys act on Claude's latest reply. The line above the prompt always lists the keys
that work at that moment, so you do not need to learn them first.

| Key | What it does |
|---|---|
| `v` | Asks Claude for another view of the reply, as a card. When the side agent has a view in mind, `v` is lit and offers it. |
| `s` | Rewrites the reply in place: shorter or longer, more or less interpretation, for a newcomer or an expert, or along a chip in your own words (`+`). When two or more replies came since your last prompt, `s` catches up on them: one message in their place, with the replies one key away (`0`). |
| `]` `[` | Step through the citations and explained terms in the reply, then its cards. |
| `o` | Opens the card you stepped to. |
| `{` `}` | Pick an earlier or a later reply. |
| `esc` or `0` | Close. Claude Code keeps `esc` at the prompt, so it closes the side panel and what opens over it; `0` closes the rest. |

A citation opens in a tray above the prompt: `r` shows its rows, `c` the code behind it, and `a` lets you ask a
question about it in a side thread that the main conversation does not see.

A card opens in a detail view beside the chat: arrow keys select a part, `↵` shows its details, `e` its example rows,
`p` its program and `h` its earlier versions. Text you type there is a question for that card's side thread.

If you type a word that starts with one of these letters, thimble gives the letter back to the prompt.

#### Commands

- `/card [name]` opens a card's detail view. On a terminal narrower than 144 columns, use it in place of `1`.
- `thimble --help`, in your shell, lists the commands Claude uses: `thimble run`, `thimble save`, `thimble rows`,
  `thimble coverage` and `thimble label`. You can run them too.

### What it costs

The side agent makes one model call after each of Claude's replies, with your session's model. It is a fork of the
session, so the prompt cache serves the conversation it reads; replies that come while it reads wait and are read
together in one call. A `--prompt` label makes one call per 50 records. A rewrite with `s` makes one call. All calls
go through your Claude Code login and show in your usage like any other. To turn a feature off, click `thimble` at
the left of the bar (or run `/thimble-settings`). The features that read Claude's replies share the side agent's call:
with all of them off, it makes none.

### What it stores

- `thimble/`, in your data folder: the queries Claude ran, the cards, the labels and a record of each reply.
- `~/.thimble/` (or the folder in `THIMBLE_HOME`): where each card is drawn, per session, so `claude --resume` shows
  them again, and a log of thimble's own model calls.

The plugin sends nothing anywhere except through your Claude Code session, and starts no other Claude Code process.

## The browser workbench

```
cd path/to/folder
thimble-browser
```

`thimble-browser` starts on the folder you are in, as `claude` does (`thimble-browser path/to/folder` names another).
It prints a sign-in link, opens the page when this machine has a browser, and listens on 127.0.0.1, port 8000 or the
next free one. The file browser shows the folder. You ask Claude a question in the chat, and Claude answers with cards that show the
evidence; every number and quote in the answer links to the lines it came from. Claude's code runs in a sandbox that
reads the folder and has no network. The browser workbench needs credentials for the Claude API, an API key or
Workload Identity Federation. [browser/README.md](browser/README.md) says how to give them, and what else it does.

## Develop

| Folder | What it holds |
|---|---|
| `plugin/` | the terminal plugin: the `thimble` command and its kernel, the hooks that draw in the terminal, the side agent, and the texts the model reads |
| `browser/` | the browser workbench: the page (`browser/frontend`), the server (`browser/server`), its prompts and its samples |
| `scripts/` | `install.sh`, `check.sh` (the checks CI runs), `scan.sh` and the git hooks |

To try the plugin from a checkout, start Claude Code with `claude --plugin-dir plugin`. [CONTRIBUTING.md](CONTRIBUTING.md)
has the layout of each product, how to run the tests, and how the repository keeps private details out of commits.

## License

Apache-2.0; see [LICENSE](LICENSE).
