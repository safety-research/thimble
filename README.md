<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

thimble helps you and Claude work through a large amount of data, such as the transcripts and logs that agents leave
behind. It comes in two forms, both in this repository:

- **The terminal plugin** (`plugin/`), for Claude Code. You ask Claude questions in the terminal as usual. Claude
  adds a citation to each claim you would check, a second Claude checks each one after the reply, and Claude draws
  interactive cards when an answer is faster to see than to read.
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
and Node.js 22.18 or later for the plugin; Node.js 22.12 or later and [uv](https://docs.astral.sh/uv/) for the browser
workbench. Both run Claude's card code in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime),
which the script installs; on Linux it needs bubblewrap, socat and ripgrep, and the script prints the one command that
installs what is missing. The browser workbench takes about 1 GB of disk, most of it its page's packages and its server's Python
packages, so install the plugin alone if that is all you need:

- `scripts/install.sh --no-browser` installs the terminal plugin only. So do these two commands, with no clone:
  `claude plugin marketplace add safety-research/thimble`, then `claude plugin install thimble@thimble`.
- `scripts/install.sh --no-plugin` installs the browser workbench only.

Running the script again is safe, and updates both. [INSTALL.md](INSTALL.md) has the details, how to check that each
works, and what to do when it does not.

## The terminal plugin

1. Go to a folder with your data: JSONL, CSV, TSV, JSON, SQLite, Markdown, code or plain text files. Subfolders are
   fine.
2. Start Claude Code with `claude`, and ask a question about the data.

thimble adds these to the session:

- **Citations.** Claude adds a citation to each claim in its reply that you would want to check: the numbers that
  answer your question, quotes, and what code does. A citation is underlined in purple. After the reply, a second
  Claude, a fork of the session, checks each citation against the files: a number with code whose printed output holds
  it, a quote or a claim about code with the line of the file that holds it. A spinner follows each citation while it
  checks. A citation that holds stays as it is; a wrong one shows the corrected words in its place; one the data shows wrong turns red with
  `×`, and one the check could not confirm gets a `?`. The line under the reply counts the wrong, unconfirmed and
  corrected citations. A click on a citation opens its evidence beside the chat: the output and the code for a number, the
  file at its line for a quote. Claude learns of each correction with your next prompt.
- **Cards.** When an answer is much faster to see than to read, such as the path one run took or forty runs side by
  side, Claude draws an interactive card in the conversation. A card takes clicks, and the letter keys it names while
  the prompt is empty. The code Claude writes for a card runs in Anthropic's sandbox runtime, which lets it read only
  the card's rows and reach no network.
- **`v`.** At an empty prompt, `v` asks for a card of the last answer. A background copy of the session lists a few
  forms that fit, picks one, draws it under that answer and fixes what it sees is unclear, while you go on. The line
  above the prompt says while it works.
- **Labels.** When Claude sorts records into categories, it makes a label: a rule (a regular expression or code) or a
  model's reading (a prompt) that gives each record a value. You can open a label to read its definition and its
  records per value, and correct a record.
- **Coverage.** The line above the prompt says how much of the folder Claude has read. `thimble coverage` lists the
  files Claude read and the ones it only computed over, searched or never touched.
- **`/thimble:fix`.** Say what you want thimble to do differently, and Claude changes thimble itself, in a copy, for
  you to try. A failure line above the prompt offers the same (`f`).

The line above the prompt names the keys that work at that moment, so you do not need to learn them first. When you type a
word that starts with one of those keys, thimble gives the letter back to the prompt.

### Settings

Click `thimble` at the left of the line above the prompt, or run `/thimble-settings`, to turn each feature on or off:
Citations, Cards (with `v`), and Labels and coverage on the bar. With Citations or Cards off, thimble's guidance to Claude
leaves that feature out too, from the next conversation or `/compact` on.

### What it costs

The checker makes one model call after each reply that has citations, with your session's model. It is a fork of the
session, so the prompt cache serves the conversation it reads. `v` makes one fork per press. A `--prompt` label makes
one call per 50 records. All calls go through your Claude Code login and show in your usage like any other.

### What it stores

- `~/.thimble/` (or the folder in `THIMBLE_HOME`): per Claude Code conversation, the labels it made in each folder, with
  every version of their values, the cards with their rows and state, the citations and their checks, the files Claude
  read (for coverage), and a log of thimble's own model calls; and in `srt/`, the sandbox runtime the cards run in. A
  new conversation (a new `claude`, or `/clear`) starts with none of an earlier one's; `claude --resume`, `--continue`
  and `/resume` bring a conversation's own back. Per data folder, only the files' row counts, for speed; and a
  `--prompt` label made again with the same name and definition in another conversation reuses the model's reads of its
  records from there, and shows nothing else of it. thimble writes nothing in your data folder. Labels an earlier
  thimble kept per folder (in `folders/`) stay there: no new conversation shows them, and a conversation that made one
  finds it again when resumed.

The plugin sends nothing anywhere except through your Claude Code session, and starts no other Claude Code process.

## The browser workbench

```
cd path/to/folder
thimble-browser
```

`thimble-browser` starts on the folder you are in, as `claude` does (`thimble-browser path/to/folder` names another).
It starts the server on 127.0.0.1, port 8300 or the next free one, and prints the page's sign-in link. The server
runs the chat itself, with an Anthropic API key (the default), Workload Identity Federation, or your Claude Code sign-in,
chosen at install or at the page's first start. The file browser shows the folder. You ask Claude a question in the page's chat, and
Claude answers with cards that cite the evidence. Claude's card code runs in a sandbox that reads the folder.
[browser/README.md](browser/README.md) says what else it does.

## Develop

| Folder | What it holds |
|---|---|
| `plugin/` | the terminal plugin: the `thimble` command and its kernel, the hooks that draw in the terminal, the checker and the card runner, and the texts the model reads |
| `browser/` | the browser workbench (thimble 0.8's browser mode): the page (`browser/frontend`), the server (`browser/backend`), the plugin its session loads (`browser/plugin`) and its prompts |
| `scripts/` | `install.sh`, `check.sh` (the checks CI runs), `scan.sh` and the git hooks |

To try the plugin from a checkout, start Claude Code with `claude --plugin-dir plugin`. [CONTRIBUTING.md](CONTRIBUTING.md)
has the layout of each product, how to run the tests, and how the repository keeps private details out of commits.

## License

Apache-2.0; see [LICENSE](LICENSE).
