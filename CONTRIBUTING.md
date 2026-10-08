# Contributing to thimble

Bug reports, suggestions and pull requests are welcome.

## Set up a checkout

You need Claude Code, macOS or Linux, Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended) and Node 20.19+, 22.13+ or 24+ (the frontend's tests need it).

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
thimble status                     # one line: the server, the orientation, the queue
thimble doctor                     # the install state, versions, port and the log's recent errors, with the lines
                                   # only a development install prints: the turn endings, the source changed since
                                   # the server started, the validation stack, the last apply and the dev tickets
thimble fix                        # the server will not start: the dev agent repairs it in the checkout, asking first
thimble revert                     # undo the last change thimble's dev agent applied
thimble launch-args | prompt <name>   # what a session starts with, and a prompt as a session gets it
thimble mode [browser | terminal]  # the mode `thimble` starts this folder in; terminal mode starts no server
thimble state <surface> | act <kind>  # terminal mode's renderer: a surface's JSON, or a click's effect, with no server
thimble view text <slug> --width 120  # a view's terminal program (view.term.js) drawn as text (docs/terminal-views.md)
```

`thimble help` lists the commands an analyst uses, and in a development install `fix` and `revert` too; the ones above
run whether or not they are listed. `fix` and `revert` refuse on a release install, since they change thimble's own
code.

`thimble` alone starts a Claude Code session in the current folder with the plugin loaded. Edits to `prompts/main.md` or
`prompts/shared.md` reach a session only when it is started again, since they are its system prompt.

State lives under `~/.thimble` (`THIMBLE_HOME`): `server.json`, `server.log`, the registry of opened folders and
`tour.json`, which records that the product tour was offered (delete it to see the first-launch welcome again).
Per-workspace state is `workspaces/<c>/` in the checkout (`THIMBLE_WORKSPACES_DIR`). To run a scratch stack beside the
live one, set `THIMBLE_HOME`, `THIMBLE_WORKSPACES_DIR`, `THIMBLE_DATA_DIR` and `THIMBLE_DEV_DIR` under /tmp and
`THIMBLE_PORT` above 8400 (`THIMBLE_UI_PORT` above 5400 with Vite). `scripts/dev/make_toy_corpus.py` writes a synthetic
corpus to try it on, and `scripts/dev/examples.py <folder>` opens the worked examples of custom views there, each on its
sample with its sample labels (`labels.json`) on. `thimble demo --examples` opens them on the server `thimble demo` uses,
as the workspaces `example-<name>` on copies of their samples in `$THIMBLE_HOME/examples`, and opens the start page,
whose rows open each at its view; `--refresh` copies the views and samples again after you edit them.

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

Before a release, `bash scripts/e2e_release.sh --ref <branch>` installs a fresh clone of the branch into a new
THIMBLE_HOME and walks the UI in headless Chromium on a copy of a synthetic corpus. It writes a report with a screenshot
of each step (`--help` lists its options). It uses your own Claude login for its one model call, a one-turn `claude -p`,
and it leaves your Claude Code settings and your `thimble` command as they were.

## Layout

| what | where |
|---|---|
| the server (FastAPI, one router per module, mounted under `/api` by `main.py`) | `backend/app/` |
| the tools the agents call | `backend/app/tools.py`, their descriptions and schemas in `prompts/tools.md` |
| an extension's program that runs a role: how it starts, and the `thimble` modules it imports | `backend/app/harness.py`, `backend/agent_kit/`, `docs/agents.md` |
| every model-facing prompt | `prompts/` (rendered by `backend/app/prompts.py`) |
| the browser (React, Vite); the types it shares with the backend | `frontend/src/`, `frontend/src/lib/types.ts` |
| the Claude Code plugin: launcher, MCP server, skills, hooks | `plugin/` |
| the worked examples of custom views, which the dev agent reads and thimble never installs | `plugin/viewers/` |
| install, update, release and dev scripts | `scripts/` |
| tests | `backend/tests_public/` (pytest), `frontend/tests/public/` (vitest), `frontend/tests/public/browser/` |

## Pull requests

A contribution is licensed under Apache-2.0, as section 5 of the LICENSE says.

`git config core.hooksPath scripts/hooks` turns on a commit-msg hook that refuses a message linking a Claude Code
session (`git commit --no-verify` skips it).
