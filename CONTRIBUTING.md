# Contributing to thimble

Bug reports, suggestions and pull requests are welcome.

## Set up a checkout

You need Claude Code, macOS or Linux, Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended) and Node 20+.

```
git clone https://github.com/safety-research/thimble.git
cd thimble
bash scripts/install.sh   # backend/.venv with the test extras, frontend/dist, ~/.local/bin/thimble
```

## Run it

```
thimble server up                  # the server on port 8300, detached; prints the URL
THIMBLE_DEV=1 thimble server up    # plus Vite on 5300 with hot reload; the URL is Vite's
thimble server status | stop | restart
thimble doctor                     # the install state, versions, port and the log's recent errors
```

`thimble` alone starts a Claude Code session in the current folder with the plugin loaded. Edits to `prompts/main.md` or
`prompts/shared.md` reach a session only when it is started again, since they are its system prompt.

State lives under `~/.thimble` (`THIMBLE_HOME`): `server.json`, `server.log` and the registry of opened folders.
Per-workspace state is `workspaces/<c>/` in the checkout (`THIMBLE_WORKSPACES_DIR`). To run a scratch stack beside the
live one, set `THIMBLE_HOME`, `THIMBLE_WORKSPACES_DIR`, `THIMBLE_DATA_DIR` and `THIMBLE_DEV_DIR` under /tmp and
`THIMBLE_PORT` above 8400 (`THIMBLE_UI_PORT` above 5400 with Vite). `scripts/dev/make_toy_corpus.py` writes a synthetic
corpus to try it on, and `scripts/dev/examples.py <folder>` opens the worked examples of custom views there, each on its
sample with its sample labels (`labels.json`) on.

## Run the tests

`bash scripts/check.sh` runs everything CI runs: the content check, the backend's tests, the frontend's type check,
tests and build, and the browser tests. Make it pass before you open a pull request. While you work, run the tests of
what you changed:

```
cd backend && THIMBLE_SKIP_KEY=1 .venv/bin/python -m pytest tests_public/test_<module>.py -q
cd frontend && npm run typecheck && npx vitest run tests/public/<name>
cd frontend && npx vitest run --config vitest.browser.config.ts tests/public/browser/<name>   # headless Chromium
```

The backend's tests run on a small synthetic corpus (`backend/tests_public/mini_corpus.py`) and fake every model call
and Claude Code session. The tests cover what must not break, not every feature: install and update, the server, the
security boundaries, the permission flow, the analysis loop and views. A change to one of these comes with a test on
synthetic data; a test does not pin wording, copy or layout.

## Layout

| what | where |
|---|---|
| the server (FastAPI, one router per module, mounted under `/api` by `main.py`) | `backend/app/` |
| the tools the agents call | `backend/app/tools.py`, their descriptions and schemas in `prompts/tools.md` |
| every model-facing prompt | `prompts/` (rendered by `backend/app/prompts.py`) |
| the browser (React, Vite); the types it shares with the backend | `frontend/src/`, `frontend/src/lib/types.ts` |
| the Claude Code plugin: launcher, MCP server and channel, skills, hooks | `plugin/` |
| the worked examples of custom views and the built-in PDF viewer | `plugin/viewers/` |
| install, update, release and dev scripts | `scripts/` |
| tests | `backend/tests_public/` (pytest), `frontend/tests/public/` (vitest), `frontend/tests/public/browser/` |

## Pull requests

A contribution is licensed under Apache-2.0, as section 5 of the LICENSE says.

`git config core.hooksPath scripts/hooks` turns on a commit-msg hook that refuses a message linking a Claude Code
session (`git commit --no-verify` skips it).
