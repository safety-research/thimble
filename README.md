<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble** is a Claude Code plugin that gives Claude tools to cite, visualize and label your data, and gives you tools to check its work.

https://github.com/user-attachments/assets/e8b0c9d8-1bc0-4ccb-a5ac-4c311cea02d4

## Features

**For Claude**

- **Cards**: interactive graphs of your data, drawn in the terminal, that you can click and ask about. `v` draws one for the last answer.
- **Citations**: every claim in an answer points to the code output or file line that shows it.
- **Labels**: records sorted into categories by a rule or a model's reading.

**For you**

- **Verified citations**: a second Claude checks each claim against your files; a click shows the evidence.
- **Coverage** (`r`): how much of the folder Claude has read, and what it never opened.
- **Claims** (`c`): everything the session has concluded, as a map, with what was corrected and why.
- **Squeeze** (`s`): the last answer, shorter or longer, or with its interpretation and background.
- **Side threads**: ask about a passage or part of a card without derailing the session.

## Installation

```
claude "install thimble from https://github.com/safety-research/thimble"
```

Claude asks whether you want the terminal plugin, the browser workbench, or both, and helps with anything missing. Agents installing thimble: follow [CLAUDE.md](CLAUDE.md).

Or by hand:

```
git clone https://github.com/safety-research/thimble
cd thimble
scripts/install.sh
```

`scripts/install.sh --no-browser` installs the terminal plugin alone. [INSTALL.md](INSTALL.md) covers upgrading from 0.9 and what to do when something does not work.

> [!CAUTION]
> - **thimble is in alpha.** It changes daily, so expect bugs and rough edges.
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

## Usage

Run `claude` in a folder with files you'd like to analyze. thimble is on in every session; click `thimble` above the prompt, or run `/thimble-settings`, to turn features on or off, and `/plugin` to turn it off.

Run `thimble-browser` in a folder of files to open the browser workbench.

## Requirements

Claude Code, macOS or Linux, Python 3.10+ and Node.js 22.18+. The browser workbench also needs [uv](https://docs.astral.sh/uv/) and about 1 GB of disk.

## Security & Privacy

thimble is a research prototype. Please report any security issues privately to [@mjoerke](https://github.com/mjoerke). The plugin runs inside your Claude Code session: it collects no data of its own, its model calls go through your session, and Claude's card code runs in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime) with no network.

## License

Apache-2.0; see [LICENSE](LICENSE).
