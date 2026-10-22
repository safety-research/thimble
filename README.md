<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

thimble helps you and Claude work through a large amount of data, such as the transcripts and logs that agents leave
behind. It comes in two forms, both in this repository:

- **The terminal plugin** (`plugin/`), for Claude Code. You ask Claude questions in the terminal as usual. Claude
  marks the claims you would check, a second Claude checks each one after the reply, and Claude draws interactive
  cards when an answer is faster to see than to read.
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
workbench. The browser workbench takes about 600 MB of disk, most of it its page's packages and its server's Python
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

- **Marks.** Claude marks the claims in its reply that you would want to check: the numbers that answer your
  question, quotes, and what code does. A mark is underlined in purple. After the reply, a second Claude, a fork of
  the session, checks each mark against the files: a number with code whose printed output holds it, a quote or a
  claim about code with the line of the file that holds it. A spinner follows each mark while it checks. A mark that
  holds stays as it is; a wrong one shows the corrected words in its place; one the data shows wrong turns red with
  `×`, and one the check could not confirm gets a `?`. The line under the reply counts the wrong, unconfirmed and
  corrected marks. A click on a mark opens its evidence beside the chat: the output and the code for a number, the
  file at its line for a quote. Claude learns of each correction with your next prompt.
- **Cards.** When an answer is much faster to see than to read, such as the path one run took or forty runs side by
  side, Claude draws an interactive card in the conversation. A card takes clicks, and the letter keys it names while
  the prompt is empty.
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
Marks, Cards (with `v`), and Labels and coverage on the bar. With Marks or Cards off, thimble's guidance to Claude
leaves that feature out too, from the next conversation or `/compact` on.

### What it costs

The checker makes one model call after each reply that has marks, with your session's model. It is a fork of the
session, so the prompt cache serves the conversation it reads. `v` makes one fork per press. A `--prompt` label makes
one call per 50 records. All calls go through your Claude Code login and show in your usage like any other.

### What it stores

- `~/.thimble/` (or the folder in `THIMBLE_HOME`): per data folder, the labels, with every version of their values;
  per session, the cards with their rows and state, the marks and their checks, the files Claude read (for coverage),
  and a log of thimble's own model calls. thimble writes nothing in your data folder (one whose `thimble/labels` an
  earlier thimble made keeps its labels there).

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
| `plugin/` | the terminal plugin: the `thimble` command and its kernel, the hooks that draw in the terminal, the checker and the card runner, and the texts the model reads |
| `browser/` | the browser workbench: the page (`browser/frontend`), the server (`browser/server`), its prompts and its samples |
| `scripts/` | `install.sh`, `check.sh` (the checks CI runs), `scan.sh` and the git hooks |

To try the plugin from a checkout, start Claude Code with `claude --plugin-dir plugin`. [CONTRIBUTING.md](CONTRIBUTING.md)
has the layout of each product, how to run the tests, and how the repository keeps private details out of commits.

## License

Apache-2.0; see [LICENSE](LICENSE).
