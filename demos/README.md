# Demo pre-caches

`thimble demo` (backend/app/demo.py) downloads each dataset from its publisher and installs the orientation in
`demos/<dataset>/`, which was run ahead of time on the same bytes. thimble then opens on that orientation's cards,
labels, views and report, and a message to the orientation continues its Claude Code session with everything it read
and did. Each folder holds plain text files, so a reviewer can read it in a diff before it is committed.

A dataset with no folder here opens with no analysis yet: `thimble demo` says so in one line, and Start in the page
runs the orientation. A folder is committed only after a maintainer has exported a run and reviewed it ([Making
one](#making-one)).

## What a folder holds

- `README.md`: the source's own notice first, verbatim (mythos-5's carries a canary string), then how the orientation
  was made and what the folder holds.
- `thimble-demo-precache.json`, the manifest:
  - `schema` (`thimble-demo-precache`), `version` (2), `dataset`, `created`, `notice` (the source's notice);
  - `thimble` (the version and commit that made it);
  - `orientation` (status, outputs, effort, Ultracode, critique, model, start and end);
  - `counts` (cards, labels, views, documents, chats);
  - `corpus` (each file the orientation read, with its size and SHA-256, checked on install);
  - `placeholders`;
  - `transcripts` (each transcript's session id, the folder in the workspace it ran in, its path here, its size and
    SHA-256, and how many records were kept and dropped, by kind);
  - `files` (each workspace file kept, with its size and SHA-256);
  - `left_out` (each file left out, and why);
  - `gitleaks`, `user_name_scrubbed`, `typed_in_main`, `marked_done` (chats whose meta still said they ran, written
    done) and `flagged` (findings kept with `--allow-private`).
- `workspace/`: the files of the workspace folder, by their paths in it:
  - `notebooks/` (the cards and their full-size outputs);
  - `concepts/` and `labels/*.jsonl` (the labels);
  - `views/` and `extension/` (the views);
  - `investigations/` (the documents and the event stream);
  - `chats/` and `calls/` (main's chat, the orientation's thread and its calls);
  - `orient/run.json`, `orient/summary.md` and `orient/work/` (the files the cards read);
  - `canvas-history.jsonl`, `settings.json` (without keys that name a secret), `registry/` and `card-checks/`.
- `transcripts/orient.jsonl`: the orientation's Claude Code transcript, as Claude Code wrote it, minus the records
  that describe the maintainer's machine and account (backend/app/demo_scrub.py). Dropped: the maintainer's CLAUDE.md
  files, email, organization, skills and agents, the sandbox's paths, the system prompt, the environment, the hooks'
  commands and the reminders. Kept: the conversation (messages, tool calls and results, thinking blocks as Claude Code
  stored them), and the attachments the conversation needs: the call refs thimble's hook added, the date, the model
  and the deferred tools the session loaded. Each record whose parent was dropped now points to the dropped record's
  parent, so the conversation is still one chain.

Absolute paths are written as placeholders:
- `@@THIMBLE_WORKSPACE@@` (the workspace);
- `@@THIMBLE_CORPUS@@` (the dataset's folder);
- `@@THIMBLE_APP@@` (thimble's install);
- `@@THIMBLE_HOME@@` (`$THIMBLE_HOME`);
- `@@THIMBLE_USER_HOME@@` (the home folder).

Each also has a `@@THIMBLE_DASHED_…@@` form for where Claude Code spells the path with dashes (`-home-a-…`).

Left out, because thimble rebuilds them or they belong to the maintainer's machine:
- label indexes (`*.sqlite`), view caches and `view-indexes/`;
- `kernels/`, `scratch/` and telemetry;
- the files viewed, sessions, permissions and undo;
- the critic's digest of the transcript (`critique/`), and the writers' and view builds' own folders;
- hidden files, pictures and every file that is not text.

Chats' metas lose the ids of the processes that ran them.

The writers and the critic are not resumed: a new writer gets its context in its first message. So only the
orientation's transcript is kept.

## What `thimble demo` does with it

It fills in the placeholders for the new folders and installs `workspace/` as the dataset's workspace. It writes the
transcript where Claude Code resumes it: `<CLAUDE_CONFIG_DIR, else ~/.claude>/projects/<the workspace's orient/work,
dashed>/<session>.jsonl`, under a new session id so that two installs never share a session. That id goes into
`orient/run.json` and into the orientation chat's meta.

It then opens the workspace in the browser without starting a Claude Code session, and prints how to attach one:
- `cd <folder> && thimble` starts main on the workspace;
- typing in the orientation's thread, or asking main to message the orientation, resumes the orientation's session;
- `--attach` starts main directly.

## Making one

1. Download the dataset as a user would, so the orientation runs on the same bytes. Point `--precaches` at an empty
   folder so that no pre-cache is installed: `thimble demo collusion-wiki --dir ~/demo-src --precaches /tmp/none`.
2. Run the orientation in `~/demo-src/collusion-wiki` by one of two routes:
   - **By hand.** Run `thimble` there. In Start, set the orientation's model to Opus 5.5 with Ultracode, and start it
     with no prompt. Keep the page open (a request waits on its card unless the permission modes are Bypass) and the
     session running (main asks for the report).
   - **With no model in main.** Run `scripts/dev/precache_orientation.py`.

   Wait until it is done: its views built and its report written. Claude's cyber safeguards flag rubyhack and
   mythos-5 under Opus 5.5. On 2026-10-05, rubyhack ran to the end on claude-opus-4-8, but the same safeguard stopped
   its critic, two verification agents and one view build (the orientation's thread says so).
3. Export it from the checkout: `thimble demo --export collusion-wiki demos/` (the workspace's name, or its folder).
   This writes `demos/collusion-wiki/`, replacing an earlier pre-cache there. The export refuses, listing each
   finding, while it finds your user name, another absolute path or a gitleaks finding.
   - `--scrub-user` writes `user` in place of your user name (it appears in `ls -l` output in tool results).
   - `--allow-private` keeps what is left, after you have looked. The manifest's `flagged` lists what was kept.
   - `--claude-config <dir>` names the Claude Code config folder the orientation's session ran with, when that was
     not `CLAUDE_CONFIG_DIR` or `~/.claude`.
   - `--app <folder>` names the thimble install the orientation ran in, when it was another.

   It prints how many transcript records it kept and dropped, any messages you typed into main's chat (slash commands
   are dropped), and any chat whose meta still said it ran.
4. Read it: the README, the report and the cards in a browser, and the transcript. Run
   `python3 scripts/check_content.py`, which applies the checks below and gitleaks.
5. Check it on a clean install with a fresh `THIMBLE_HOME`:
   `thimble demo collusion-wiki --precaches demos --dir /tmp/demo-check`. Send the orientation a message from its
   thread and see that it answers from what it did.
6. Commit the folder.

## What scripts/check_content.py allows here

`check_content` refuses `.jsonl` files and files over 2 MB anywhere in the tree. Under `demos/<dataset>/` it allows
them, on these terms only:
- **The manifest lists every file.** The folder holds `thimble-demo-precache.json` (schema `thimble-demo-precache`)
  and `README.md`. Every other file is one the manifest lists: `workspace/<path>` for each of its `files`, or the
  `path` of one of its `transcripts`.
- **Text, and capped in size.** Each file is UTF-8 text of a kind the export writes (`.json`, `.jsonl`, `.md`, `.txt`,
  `.py`, `.html`, `.csv`, `.js`, `.mjs`, `.css`, `.tsv`, `.yaml`, `.yml`, `.svg`) and at most 6 MB. The folder is at
  most 30 MB in all.
- **The export's scrub check passes.** No file holds an absolute path under `/home`, `/Users`, `/mnt` or `/root`, or
  this machine's user name as a word. Common user names, such as `runner` or `user`, are not checked. The one
  exception is a finding that the manifest's `flagged` names for that file. A transcript also holds none of the
  records the export drops.

gitleaks scans these files like every other, and the other rules (databases, caches, file names that differ only by
case) still apply.
