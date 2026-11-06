# thimble's browser workbench

The browser workbench is a web page where you and Claude make sense of a folder of files together. The page has a
chat, the folder's files with views built for them, a canvas of cards, labels, and a report. Claude answers in cards
that cite every claim.

It runs on your machine. A small server listens on 127.0.0.1 and serves the page, and runs the chat and thimble's
agents (side threads, the writers, the view builders, the report checks) itself, on one of three ways to reach Claude:

| Way | What runs |
|---|---|
| Your Claude Code sign-in (the default) | The server runs Claude Code in the background, through the Agent SDK, on your Claude plan. Claude Code gets the environment as it is, so it signs in as it does in your terminal; the commands it runs in its sandbox get none of the `ANTHROPIC_*` variables. |
| An Anthropic API key | `ANTHROPIC_API_KEY` when it is set where the workbench runs, else a key pasted in Settings, Claude access. The server calls the Claude API itself. No Claude Code process starts. As in Claude Code, `ANTHROPIC_BASE_URL` applies to `ANTHROPIC_API_KEY` alone: a pasted key goes to api.anthropic.com. |
| Workload Identity Federation | The same, with the IDs and token source of a config file you name (`backend/app/wif.py` lists its keys). Its calls go to api.anthropic.com, or to the `base_url` the file names. |

Each way gets the same prompts, the same tools and the same records, so the page looks the same. The choice is made
once, at install or at the page's first start, and changed in Settings, Claude access. When Claude cannot be reached,
the chat shows one card that says what is missing and opens that step.

## Install and start

thimble's install ([INSTALL.md](../INSTALL.md)) builds it with the plugin, in `~/.thimble/fixes/live/browser`, and puts
`thimble-browser` in `~/.local/bin`. It needs Node 22.12 or later, [uv](https://docs.astral.sh/uv/) and npm, and on
Linux bubblewrap for the sandbox that card code and the agents' shell commands run in. Claude Code is needed only for
the Claude Code sign-in. The install sets how it reaches Claude (`--sign-in`), or asks in a terminal;
`thimble-browser --setup` asks again. Then:

```
cd path/to/folder
thimble-browser
thimble-browser path/to/folder --port 8400
thimble-browser --continue    # or -r / --resume to pick an earlier session
```

`thimble-browser` opens the folder you are in, or the folder you name. It starts the server on 127.0.0.1, port 8300 or
the next free one (`--port N` takes N alone), and prints the page's sign-in link and how it reaches Claude. Ctrl-C
stops the server. Each start is a new session, as with `claude`: an empty chat, canvas, report and labels, as at the
folder's first start. `--continue` (`-c`) brings back the latest session with its chat, canvas, report and labels;
`--resume` (`-r`) lists the earlier sessions (when, the first message, turns and cards) and brings back the one you
pick. From another machine, reach the page through an SSH tunnel
(`ssh -L 8300:127.0.0.1:8300 <host>`). The workspaces (chats, cards, labels, report; the earlier sessions in
`workspaces/.archive`) are kept in `~/.thimble-browser`,
or in `THIMBLE_BROWSER_HOME`, apart from the terminal plugin's `~/.thimble`.

## Layout

| Folder | What it holds |
|---|---|
| `backend/` | the server (Python, uv): the workspace, the tools, the agents' sessions, the card harness (`backend/app`), and its tests (`backend/tests_public`) |
| `frontend/` | the page (React and Vite); `npm run build` writes `frontend/dist`, which the server serves |
| `plugin/viewers/` | the worked examples of views, which the view builder reads |
| `prompts/` | the texts Claude reads: main's prompt, the shared guidance, the tools, the writer's, the labels' and the view builder's |
| `docs/` | the view kit's guides, which the view builder reads, the config reference and the route table |
| `scripts/thimble-browser` | the launcher: it rebuilds the page when it changed, then starts the server and opens the folder |
