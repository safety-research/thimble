<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble is a Claude Code plugin for making sense of large volumes of agent outputs.** It gives Claude tools to cite, visualize and label your data, and gives you an interface to understand and verify Claude's work faster.

> [!CAUTION]
> - **thimble is a research prototype.**
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

https://github.com/user-attachments/assets/878ed146-fc7c-486a-8f41-ac14b24c5068



## Features

- **Cards**: interactive graphs of your data, drawn in the terminal, that you can click and ask about. `v` (visualize) draws one for the last answer.
- **Citations** (`c`): select words in an answer and press `c`, and a second Claude checks them against your files. Set Citations to auto cite to have Claude cite every claim on its own.
- **Labels** (`l`): records sorted into categories by a rule or a model's reading, which you can open and correct.
- **Simplify** (`s`): a shorter, plainer version of the last answer, below it; under it, `1`–`4` make it shorter, longer, explain more or assume more, and `0` hides it.
- **Side threads** (`a`): ask about selected words or part of a card without derailing the session; `t` lists them.

## Installation

### With Claude (recommended)

```
claude "install thimble from https://github.com/safety-research/thimble"
```

Claude asks whether you want both the terminal plugin and the browser workbench (the default) or the plugin alone, and helps with troubleshooting. Agents installing thimble: follow [CLAUDE.md](CLAUDE.md).

### Manual installation

```
curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash
```

It installs thimble in `~/.thimble`. Adding `-s -- --no-browser` after `bash` installs the terminal plugin alone. [INSTALL.md](INSTALL.md) covers the options, updates and troubleshooting.

## Usage

### Terminal plugin

Run `claude` in a folder with files you'd like to analyze. By default, thimble is on in every session. For a two-minute tour on made-up data, run `thimble tour` in a shell, or type `/thimble:tour` in Claude Code. Click `thimble` above the prompt, or run `/thimble-settings`, to turn features on or off. Run `/plugin` to turn the thimble plugin off.

![thimble in the terminal: a card of each agent's activity during the incident, a side thread on one agent, and a reply with checked citations](docs/assets/thimble-term.png)

When thimble does something wrong or you'd like a new feature, `/thimble-fix <what should work differently>` has Claude change your own copy of thimble. In the shell, `thimble fixes` shows all existing fixes. `thimble file issue <id>` gives a link to file a GitHub issue, and `thimble file pr <id>` opens a pull request with the fix.

### Browser workbench

Run `thimble-browser` in a folder of files to open the browser workbench. The first time it opens, it offers a short tour on example data; type `/tour` in its chat to take it again.

![the browser workbench answering whether agents reviewed before approving: a chat answer with citations, an agent transcript colored by an activity label, a timeline of every agent's labeled work and approvals, and a table of what each approver ran](docs/assets/thimble-browser.png)

## Requirements

Claude Code 2.1.314+, macOS or Linux, git, curl, Python 3.10+ and Node.js 22.18+; on Linux also bubblewrap, socat and ripgrep, for the sandbox that cards run in. The browser workbench also needs [uv](https://docs.astral.sh/uv/) and about 2 GB of disk. On Windows, thimble runs in WSL 2, with the Linux tools installed in its distribution and your data in its home folder; not in WSL 1, and not on Windows itself yet ([INSTALL.md](INSTALL.md#windows)).

## Security & Privacy

thimble is a research prototype. Please report any security issues privately to [@mjoerke](https://github.com/mjoerke). The plugin runs inside your Claude Code session: it sends no data of its own (it keeps a log of its model calls in `~/.thimble/events`, and the workbench keeps a log of your actions in each workspace in `~/.thimble-browser`, on your machine only), its model calls go through your session, and Claude's card code runs in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime) with no network. A fix of thimble is made in a copy, by a Claude whose shell runs in the same sandbox and reaches only the npm and PyPI registries; the code that turns fixes off and undoes them runs from the installed release, which no fix changes.

## License

Apache-2.0; see [LICENSE](LICENSE).
