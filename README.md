<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble** is an open source Claude Code plugin for making sense of large volumes of agent output. Claude cites every claim it makes, a second Claude checks each citation against your files, and answers that are faster to see than to read come as interactive cards.

> [!CAUTION]
> - **thimble is in alpha.** It changes daily, so expect bugs and rough edges.
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

## Demo

https://github.com/user-attachments/assets/e8b0c9d8-1bc0-4ccb-a5ac-4c311cea02d4

## Installation

### With Claude (recommended)

```
claude "install thimble from https://github.com/safety-research/thimble"
```

Claude asks whether you want the terminal plugin, the browser workbench, or both, and helps with anything missing. Agents installing thimble: follow [CLAUDE.md](CLAUDE.md).

### Manual installation

```
git clone https://github.com/safety-research/thimble
cd thimble
scripts/install.sh
```

`scripts/install.sh --no-browser` installs the terminal plugin alone. [INSTALL.md](INSTALL.md) covers upgrading from 0.9 and what to do when something does not work.

## Usage

Run `claude` in a folder with files you'd like to analyze. thimble is on in every session; `/plugin` turns it off.


- **Citations**: Claude cites each claim, and a second Claude checks it against your files.
- **Cards**: interactive cards when an answer is faster to see than to read; `v` draws one for the last answer.
- **Squeeze** (`s`): the last answer, shorter or longer, or with its interpretation and background.
- **Claims** (`c`): the claims of the session, as a map.
- **Coverage** (`r`): how much of the folder Claude has read.
- **Labels**: records sorted into categories you can check and correct.
- **Side threads**: ask about a passage or a part of a card without derailing the session.

Click `thimble` above the prompt, or run `/thimble-settings`, to turn features on or off.

## Browser workbench

Run `thimble-browser` in a folder of files to open the browser workbench.


## Requirements

Claude Code, macOS or Linux, Python 3.10+ and Node.js 22.18+. The browser workbench also needs [uv](https://docs.astral.sh/uv/) and about 1 GB of disk.

## Security & Privacy

thimble is a research prototype. Please report any security issues privately to [@mjoerke](https://github.com/mjoerke). The plugin runs inside your Claude Code session: it collects no data of its own, its model calls go through your session, and Claude's card code runs in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime) with no network.

## License

Apache-2.0; see [LICENSE](LICENSE).
