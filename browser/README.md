# thimble's browser workbench

A web page for making sense of a folder of files with Claude, with the terminal plugin's guidance, marks and cards. You
open a folder, ask a question in the chat, and Claude answers. It marks the claims you would check, and after the reply
a copy of the chat checks each mark against the data: a mark turns into its corrected words, or red when it is wrong,
and a click shows the evidence (the file's lines, or the code that ran and its output). When an answer is faster to see
than to read, Claude draws an interactive card under its call, and v under an answer draws a card of it. The page also
has a file browser, labels, views built for the folder when you ask for one, and a report you write with Claude.

It runs on your machine. A small server listens on 127.0.0.1, serves the page, and runs Claude itself on the Claude
API, with your own credentials. Besides the chat, Claude works in the background only for you: the check of a reply's
marks, the card v draws, and a view's builder, which starts when you accept a view. It never writes into the folder of
files.

## Install and start

`scripts/install.sh`, at the top of the repository, installs it with the terminal plugin (`--no-plugin` installs the
browser workbench alone). It needs Node 22.12 or later, [uv](https://docs.astral.sh/uv/), and on Linux bubblewrap for
the sandbox. Then:

```
cd path/to/folder
thimble-browser
thimble-browser path/to/folder --wif path/to/wif.toml
```

`thimble-browser` opens the folder you are in, or the folder you name. The server listens on 127.0.0.1, port 8000 or the
next free one (`--port N` tries another first). It prints a sign-in link and opens it when this machine has a browser. A link works once, for 15 minutes; press Enter in the server's window
for a new one. To try it on a made-up folder of agent runs: `thimble-browser browser/samples/agent-runs`. From another
machine, reach it through an SSH tunnel (`ssh -L 8000:127.0.0.1:8000 <host>`). The workspace (chats, cards, report) is
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

Code that Claude writes, run_python's code and a view's reader, runs only in a sandbox: a new process for each run that
sees the folder (read-only), the Python libraries, an empty folder of its own and the workspace's temp folder, where it
writes a card's rows. It does not see your home folder, `~/.thimble-browser`, the server's environment or the network,
and it is stopped when its time is up. A card's view runs in the terminal plugin's card runner (`plugin/cards/
runner.mjs`): one Node process per workspace, in the same sandbox, that reads only the runner's code and the cards'
copies and draws each card in a context of its own with no module, file or network. The sandbox is Anthropic's [sandbox
runtime](https://github.com/anthropics/sandbox-runtime), pinned in `server/sandbox/package.json`, on Seatbelt (macOS) or
bubblewrap (Linux). If no sandbox works, code does not run, and the call and the server's first lines say why.
`thimble-browser --check-sandbox` tests it, one line per check.

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

The texts Claude reads are the terminal plugin's own: its guidance (communicating, marking claims, cards, labels), the
card tool's description, the checker's and the designer's prompts and the label classifier. The server reads them from
`plugin/` when it makes a prompt, with the few exact-string changes `prompts/shared.json` lists.
`server/tests/test_prompt_parity.py` fails when one of those changes no longer applies to the plugin's text. The marks'
validator (`plugin/engine/kernel/evidence.py`), the card runner and the page's reading of marks
(`plugin/marks/message.js`) are the plugin's code, used as they are.

## Tests

From the top of the repository: `scripts/check.sh parity server page`.
