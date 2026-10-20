<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

# thimble browser

A workspace in a web page for making sense of a folder of files with Claude. You open a folder, ask a question in the
chat, and Claude answers with cards that show the evidence: charts, tables and the records themselves. Every number
and quote in an answer is a link that opens the file at the lines it came from.

This branch is a prototype of thimble browser as a product of its own, apart from the thimble plugin for the terminal.
It keeps the page of thimble 0.8 and puts a new, small server behind it.

## Start

You need Claude Code, signed in (run `claude` once and sign in), [uv](https://docs.astral.sh/uv/), and Node 20 or
later. Card code runs in a sandbox, which on Linux is bubblewrap (`apt install bubblewrap`).

```
scripts/thimble-browser path/to/folder
```

The first run builds the page. The server listens on 127.0.0.1, prints a sign-in link and opens it. Press Enter in
its window for a new link. To try it on a made-up folder of agent runs: `scripts/thimble-browser samples/agent-runs`.

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

Not yet: labels, the orientation, checks, settings, and card code on macOS.

## How it works

- `frontend/` is the page (React), from thimble 0.8.
- `server/` is the server (Python). It serves the page, reads the folder, keeps the workspace in
  `~/.thimble-browser` (never in the folder), runs card code in the sandbox, and starts the person's own Claude Code,
  headless, for each chat. Claude gets only Read, Grep and Glob inside the folder and thimble's card tools, so it
  never asks for a permission.
- `prompts/browser/` holds what Claude reads. The parts about writing for the person, citing and explaining terms are
  the terminal plugin's own text, copied into `prompts/terminal/` by `scripts/sync-terminal-prompts` and named in
  `prompts/shared.json`. A test checks that they match.

## Tests

```
cd server && uv run --extra dev pytest
```

`tests/test_prompt_parity.py` fails when the terminal plugin's text changes on its branch, or when a change that
`prompts/shared.json` lists no longer applies. Run `scripts/sync-terminal-prompts` and look at the result.

## License

Apache-2.0
