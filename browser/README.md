# thimble's browser workbench

The browser workbench is thimble 0.8's browser mode: a web page where you and Claude make sense of a folder of files
together. The page has a chat, the folder's files with views built for them, a canvas of cards, labels, and a report.
Claude answers in cards that cite every claim.

It runs on your machine. A small server listens on 127.0.0.1 and serves the page, and runs the chat and thimble's
agents (side threads, the writers, the view builders, the report checks) itself, on one of three ways to reach Claude:

| Way | What runs |
|---|---|
| An Anthropic API key (the default) | The server calls the Claude API itself. No Claude Code process starts. |
| Workload Identity Federation | The same, with the IDs and token source of a config file you name (`backend/app/wif.py` lists its keys). |
| Your Claude Code sign-in | The server launches headless Claude Code sessions in the background, through the Agent SDK. It asks you to confirm first, since this uses your Claude subscription. |

Each way gets the same prompts, the same tools and the same records, so the page looks the same. The choice is made
once, at install or at the page's first start, and changed in Settings, Claude access. When Claude cannot be reached,
the chat shows one card that says what is missing and opens that step.

## Install and start

`scripts/install.sh`, at the top of the repository, installs it with the terminal plugin (`--no-plugin` installs the
browser workbench alone). It needs Claude Code, Node 22.12 or later, [uv](https://docs.astral.sh/uv/), and on Linux
bubblewrap for the sandbox that card code and the agents' shell commands run in. Claude Code is needed only for the
Claude Code sign-in. The installer asks how to reach Claude (`--no-setup` skips the question;
`thimble-browser --setup` asks it again). Then:

```
cd path/to/folder
thimble-browser
thimble-browser path/to/folder --port 8400
thimble-browser --continue    # or -r / --resume to pick an earlier chat
```

`thimble-browser` opens the folder you are in, or the folder you name. It starts the server on 127.0.0.1, port 8300 or
the next free one (`--port N` takes N alone), and prints the page's sign-in link and how it reaches Claude. Ctrl-C
stops the server. Each start opens a new chat, as `claude` does; the workspace's cards, canvas, reports and labels
stay. From another machine, reach the page through an SSH tunnel
(`ssh -L 8300:127.0.0.1:8300 <host>`). The workspaces (chats, cards, labels, report) are kept in `~/.thimble-browser`,
or in `THIMBLE_BROWSER_HOME`, apart from the terminal plugin's `~/.thimble`.

## Layout

| Folder | What it holds |
|---|---|
| `backend/` | the server (Python, uv): the workspace, the tools, the agents' sessions, the card harness (`backend/app`), and its tests (`backend/tests_public`) |
| `frontend/` | the page (React and Vite); `npm run build` writes `frontend/dist`, which the server serves |
| `plugin/` | 0.8's Claude Code plugin (its MCP shim, hooks, hooks module and skills), which the server no longer loads, and the worked examples of views (`plugin/viewers`) |
| `prompts/` | the texts Claude reads: main's prompt, the shared guidance, the tools, the writer's, the labels' and the view builder's |
| `extensions/` | the extensions thimble ships |
| `docs/` | the view kit's guides, which the view builder reads, the config reference and the route table |
| `scripts/thimble-browser` | the launcher: it rebuilds the page when it changed, then starts the server and opens the folder |
