# thimble browser: notes for Claude Code sessions in this repo

- The page is `frontend/` (React and Vite): `npm --prefix frontend run build` writes `frontend/dist`, which the server
  serves. The server is `server/` (Python, uv): `cd server && uv run --extra dev pytest` runs its tests.
- `scripts/thimble-browser FOLDER` starts the server on a folder of files and prints a one-time sign-in link.
- Never edit `prompts/terminal/`: those are the terminal plugin's texts, copied by `scripts/sync-terminal-prompts`.
  Change how the browser uses them in `prompts/shared.json`, and keep `server/tests/test_prompt_parity.py` passing.
- The server binds 127.0.0.1 only. Card code runs only in the sandbox (`server/thimble_browser/cards/sandbox.py`), and
  the chat's Claude gets only the tools `server/thimble_browser/agent.py` names. Keep both that way.
