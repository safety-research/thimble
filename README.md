<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

# thimble browser

A workspace in a web page for making sense of a folder of files with Claude. You open a folder, ask a question in the
chat, and Claude answers with cards that show the evidence: charts, tables and the records themselves. Every number
and quote in an answer is a link that opens the file at the lines it came from.

This branch is a prototype of thimble browser as a product of its own, apart from the thimble plugin for the terminal.
It keeps the page of thimble 0.8 and puts a new, small server behind it.

## Start

You need [uv](https://docs.astral.sh/uv/), Node 22.12 or later, and credentials for the Claude API: Workload Identity
Federation (`--wif ORG`, which reads the org's IDs from `~/.thimble/orgs/org-<org>.env`), or an API key you paste in
Settings. On a Mac with Homebrew: `brew install uv node`. Card code runs in a sandbox, which on Linux also needs
bubblewrap (`apt install bubblewrap`); see [Sandbox](#sandbox).

```
scripts/thimble-browser path/to/folder --wif org-a
```

The first run builds the page. The server listens on 127.0.0.1, prints a sign-in link and opens it. Press Enter in
its window for a new link. To try it on a made-up folder of agent runs: `scripts/thimble-browser samples/agent-runs`.
From another machine, reach it through an SSH tunnel (`ssh -L 8420:127.0.0.1:8420 <host>`).

## What works

- The file browser: the tree, readers for JSONL, CSV and Markdown, search in a file and across the folder, hover
  previews of citations.
- The chat, with threads: ⌘-click a card, a record or a passage to ask about it.
- Cards on the canvas: plots, tables, diagrams, timelines, examples and notes. Their code runs in the sandbox.
- Citations: a click opens the file at the cited lines, or the card at the cited value.
- Explain marks: after each answer, terms you may not know get a teal mark that opens what they mean.
- The report: Write drafts it from the chat and the cards, with figures and citations, and you edit it in place.
- Generative views: ask for a view in the chat, and a builder writes one (a reader and a page on thimble's view kit) that
  appears in the Files tab when it passes its checks. Its reader runs in the sandbox, its page in a frame with no network.

- The orientation: ask for one in the chat, and an agent explores the folder and leaves a deck of cards in the group
  Orientation. Before it finishes, a critic reviews its work for files it never opened, rival accounts and claims no
  call supports, and it revises. A message in its thread continues it.
- The card check: once an agent's card has its takeaway, one model reading checks it against five criteria and can
  replace it in place, with Undo in the card's details.
- Report checks: each check (Important details, Judgment calls, Unverifiable, or your own) runs as an agent over the
  report and leaves comments beside the passages it applies to. Checks that are on run again after the writer saves.

## How it works

- `frontend/` is the page (React), from thimble 0.8.
- `server/` is the server (Python). It serves the page, reads the folder, keeps the workspace in
  `~/.thimble-browser` (never in the folder), and runs card code in the sandbox. It runs each agent (the chat, its
  threads, the report writer, the view builder, the orientation and its critic, the report checks) as its own loop on the Messages API: it streams Claude's reply, runs
  the tools Claude calls as its own Python functions, and loops until the turn ends. The tools read inside the folder,
  run Python in the sandbox and change the workspace's cards, report and views; nothing else, so nothing asks for a
  permission.
- `prompts/browser/` holds what Claude reads. The parts about writing for the person, citing and explaining terms are
  the terminal plugin's own text, copied into `prompts/terminal/` by `scripts/sync-terminal-prompts` and named in
  `prompts/shared.json`. A test checks that they match.

## Sandbox

Code that Claude writes, a card's code and a view's reader, runs only in a sandbox. Each run is a new process that
sees the folder of files (read-only), the Python libraries, and an empty folder of its own for temporary files, which
is deleted when the run ends. It does not see your home folder, thimble browser's own folder (`~/.thimble-browser`),
the server's environment (no keys, no tokens), or the network, 127.0.0.1 included. A run is stopped when its time is
up.

The sandbox is Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime), pinned to one version in
`server/sandbox/package.json`. It uses Seatbelt (`sandbox-exec`, part of macOS) on macOS and bubblewrap on Linux.
`scripts/thimble-browser` installs it the first time (`npm ci` in `server/sandbox`), so all it needs is Node, and on
Linux bubblewrap. If no sandbox works, code does not run, and the card and the server's first lines say why and what
to install. `--no-sandbox` runs code without one (not recommended).

To test the sandbox on your machine, with no sign-in:

```
scripts/thimble-browser --check-sandbox
```

It runs a small card, then cards that try to write into the folder, read your home folder and thimble browser's
folder, reach the network, see the server's environment, keep a file for the next run, and run past their time. It
prints one line per check, pass or FAIL.

How the two systems differ: on Linux the sandbox shows only the system's libraries, the Python and the folder, and
every other top folder (`/tmp` among them) is empty. On macOS it shows the system and hides where people's files are:
`/Users`, `/Volumes` and the temp folders.

## Tests

```
cd server && uv run --extra dev pytest
```

`tests/test_prompt_parity.py` fails when the terminal plugin's text changes on its branch, or when a change that
`prompts/shared.json` lists no longer applies. Run `scripts/sync-terminal-prompts` and look at the result.

## License

Apache-2.0
