# Demo pre-caches

`thimble demo` (backend/app/demo.py) installs, beside each dataset it downloads, an orientation run ahead of time, so
thimble opens on cards, labels and views. This folder holds `precaches.json`, which names each pre-cache: a release
asset `<name>.thimble-demo.zip` with its URL, size and SHA-256. The zips are not in the tree: scripts/check_content.py
keeps `.jsonl` files out of it, and a zip in the tree would carry them past that check and past gitleaks unscanned.

## Making one

1. Download the dataset as a user would, so the orientation runs on the same bytes:
   `thimble demo collusion-wiki --no-start --dir ~/demo-src`.
2. Run `thimble` in `~/demo-src/collusion-wiki`, set the orientation's model to Opus 5.5 with Ultracode in Start, and
   start it with no prompt. Wait until it is done, its views built and its report written if it was asked for.
3. Export it: `thimble demo --export collusion-wiki ~/demo-out` (the workspace's name, or its folder). The export keeps
   the workspace's state and leaves out what thimble rebuilds or keeps per machine; it writes absolute paths as
   placeholders and refuses while your user name, another absolute path or a gitleaks finding remains, listing each.
   `--scrub-user` writes `user` in place of your user name (it appears in `ls -l` output in tool results);
   `--allow-private` keeps what is left, after you have looked. It prints the entry for `precaches.json` and any
   messages you typed into main's chat (slash commands are dropped).
4. Check it on a clean install: `thimble demo collusion-wiki --precaches ~/demo-out --dir /tmp/demo-check`.
5. Upload the zip to a release (`gh release create demo-precache-<n> ~/demo-out/*.thimble-demo.zip` or `gh release
   upload`) and add the printed entry, with the tag in its URL, to `precaches.json`.

A pre-cache made with an older thimble still installs: the format has a version (`thimble-demo-precache.json`'s
`version`), and a newer format than the running thimble reads is refused with a pointer to `thimble update`.

## The format

`<name>.thimble-demo.zip` holds:

- `thimble-demo-precache.json`: `schema` (`thimble-demo-precache`), `version` (1), `dataset`, `created`, `thimble`
  (version and commit that made it), `orientation` (status, outputs, effort, Ultracode, critique, model, start and end),
  `counts` (cards, labels, views, documents, chats), `corpus` (each file the orientation read, with its size and
  SHA-256, checked on install), `placeholders`, `files` (each file kept, with its size and SHA-256), `left_out` (each
  file left out and why), `gitleaks`, `user_name_scrubbed`, `typed_in_main`, `marked_done` (chats whose meta still said they ran, written done), `flagged`.
- `workspace/`: the files of the workspace folder, by their paths in it: `notebooks/` (the cards and their full-size
  outputs), `concepts/` and `labels/*.jsonl` (the labels), `views/` and `extension/` (the views), `investigations/`
  (the documents and the event stream), `chats/` and `calls/` (main's chat, the orientation's thread and its calls),
  `orient/run.json`, `orient/summary.md` and `orient/work/` (the files its cards read), `canvas-history.jsonl`,
  `settings.json` (without keys that name a secret), `card-checks/` (without pictures).

Absolute paths are written as `@@THIMBLE_WORKSPACE@@`, `@@THIMBLE_CORPUS@@`, `@@THIMBLE_APP@@` (thimble's install)
and `@@THIMBLE_HOME@@`, and filled in on install. Left out, as thimble rebuilds them or they belong to the maintainer's
machine: label indexes (`*.sqlite`), view caches and `view-indexes/`, `kernels/`, `scratch/`, telemetry, the files
viewed, sessions, permissions, undo, the critic's digest of the transcript (`critique/`), the writers' and view builds' own folders, and hidden files. Chats' metas lose the ids of processes that ran them. The orientation's own Claude Code transcript is not included, so
a follow-up to the pre-cached orientation asks for a new one.
