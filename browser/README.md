# thimble's browser workbench

A web page for making sense of a folder of files with Claude. You open a folder, ask a question in the chat, and Claude
answers with cards that show the evidence: charts, tables and the records themselves. Every number and quote in an
answer is a link that opens the file at the lines it came from. The page also has a file browser, labels, an
orientation that explores the folder, generative views, and a report you write from the cards.

It runs on your machine. A small server listens on 127.0.0.1, serves the page, and runs Claude's agents itself on the
Claude API, with your own credentials. It never writes into the folder of files.

## Install and start

`scripts/install.sh`, at the top of the repository, installs it with the terminal plugin (`--no-plugin` installs the
browser workbench alone). It needs Node 22.12 or later, [uv](https://docs.astral.sh/uv/), and on Linux bubblewrap for
the sandbox. Then:

```
thimble-browser path/to/folder
thimble-browser path/to/folder --wif path/to/wif.toml
```

The server prints a sign-in link and opens it. A link works once, for 15 minutes; press Enter in the server's window
for a new one. To try it on a made-up folder of agent runs: `thimble-browser browser/samples/agent-runs`. From another
machine, reach it through an SSH tunnel (`ssh -L 8420:127.0.0.1:8420 <host>`). The workspace (chats, cards, report) is
kept in `~/.thimble-browser`, or in `THIMBLE_BROWSER_HOME`.

## Credentials

The server calls the Claude API with the credentials you name, and reads no `ANTHROPIC_*` variable from its
environment. There are two kinds:

- **An API key**, pasted in Settings. It is kept in a file only your user can read.
- **Workload Identity Federation**, configured in a file you name with `--wif FILE` or in Settings. The server trades an
  identity token from your platform for a short-lived Claude API token, so no API key is stored. The file is TOML (or
  plain `KEY=VALUE` lines) and holds the IDs of your federation rule, as your Claude Console admin gives them:

  ```toml
  federation_rule_id = "fdrl_..."
  organization_id = "..."
  service_account_id = "svac_..."    # optional
  workspace_id = "wrkspc_..."        # optional
  ```

  `token_source` says where the identity token comes from: `google` (the default), a Google identity token for
  `audience` (`https://api.anthropic.com` unless you set another), from the metadata server or Application Default
  Credentials; `file`, the token in `token_file`, read again for each new token; or `command`, what `token_command`
  prints. The SDK's environment-variable names (`ANTHROPIC_FEDERATION_RULE_ID` and the others) are accepted as another
  spelling of the keys, in the file only. Keep the file writable by you alone, since it can name a command to run.

## Sandbox

Code that Claude writes, a card's code and a view's reader, runs only in a sandbox: a new process for each run that
sees the folder (read-only), the Python libraries and an empty folder of its own. It does not see your home folder,
`~/.thimble-browser`, the server's environment or the network, and it is stopped when its time is up. The sandbox is
Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime), pinned in `server/sandbox/package.json`,
on Seatbelt (macOS) or bubblewrap (Linux). If no sandbox works, code does not run, and the card and the server's first
lines say why. `thimble-browser --check-sandbox` tests it, one line per check.

## Layout

| Folder | What it holds |
|---|---|
| `frontend/` | the page (React and Vite); `npm run build` writes `frontend/dist`, which the server serves |
| `server/` | the server (Python, uv): sign-in, the folder's readers, the workspace, the agents' loop and their tools |
| `server/sandbox/` | the pinned sandbox runtime and how one run starts in it |
| `prompts/` | the texts Claude reads, and `shared.json`, the parts it reads from the terminal plugin |
| `docs/`, `samples/views/` | the view kit's guides and worked examples, which the view builder reads |
| `samples/agent-runs/` | a made-up folder of agent runs to try it on, written by `samples/make_agent_runs.py` |
| `scripts/thimble-browser` | the launcher: it rebuilds the page and the sandbox runtime when they changed, then starts the server |

The texts about communicating, citing, explaining terms and labels are the terminal plugin's own: the server reads them
from `plugin/` when it makes a prompt, with the few exact-string changes `prompts/shared.json` lists.
`server/tests/test_prompt_parity.py` fails when one of those changes no longer applies to the plugin's text.

## Tests

From the top of the repository: `scripts/check.sh parity server page`.
