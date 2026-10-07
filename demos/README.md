# Demo pre-caches

`thimble demo` (backend/app/demo.py) downloads each dataset from its publisher and installs the orientation in
`demos/<dataset>/`, which was run ahead of time on the same bytes. thimble then opens on that orientation's cards,
labels, views and report. Each folder holds plain text files, so a reviewer can read it in a diff before it is
committed.

A pre-cache holds the orientation's outputs and nothing else: `thimble demo --export --outputs-only` writes it. thimble
redistributes none of the datasets, so a pre-cache carries no copy of their records: no Claude Code transcript, no
conversation, no work file, and no data a view or a label derived from the records. Views rebuild their indexes from
the download the first time they open. The export refuses a file that copies a long stretch of the dataset ([The
threshold](#the-threshold)). `thimble demo --export` without `--outputs-only` writes a full export, which does not
belong here ([The full export](#the-full-export)).

A dataset with no folder here opens with no analysis yet: `thimble demo` says so in one line, and Start in the page
runs the orientation. A folder is committed only after a maintainer has exported a run and reviewed it ([Making
one](#making-one)).

## What a folder holds

- `README.md`: the source's own notice first, verbatim (mythos-5's carries a canary string), then the publisher's
  credit, how the orientation was made and what the folder holds.
- `thimble-demo-precache.json`, the manifest:
  - `schema` (`thimble-demo-precache`), `version` (3), `format` (`outputs-only`), `dataset`, `created`, `notice`
    (the source's notice), `credit` (who published the data);
  - `thimble` (the version and commit that made it);
  - `orientation` (status, outputs, effort, Ultracode, critique, model, its chat, start and end, and the coverage
    line its first run ended with);
  - `counts` (cards, labels, views, documents);
  - `corpus` (each file the orientation read, with its size and SHA-256, checked on install);
  - `placeholders`;
  - `files` (each workspace file kept, with its size and SHA-256);
  - `cited_calls` (each call the report or a card cites: its chat, number, the lines cited, and whether its output
    was cut);
  - `verbatim` (the threshold, and the files that share any stretch with the dataset, with the longest stretch of
    each and the characters all of them hold);
  - `left_out` (each file left out, and why);
  - `gitleaks`, `user_name_scrubbed` and `flagged` (findings kept with `--allow-private`);
  - `views`, when reviewed views took the place of the orientation's own (step 4 of [Making one](#making-one)): each
    view's slug, name and version, and the reviewed view it came from.
- `workspace/`: the orientation's outputs, by their paths in the workspace:
  - `notebooks/`: the cards with their outputs;
  - `investigations/main/*.json`: the documents (the report);
  - `concepts/*.json` and `labels/*.jsonl`: the labels' definitions and their values by record ref. A value row
    keeps the ref, the value, the confidence, the source and the labeler's one-line rationale, and drops `spans`, the
    texts a label marked;
  - `extension/extension.json`, `extension/views/<slug>/` (`view.json` and the view's code: `.html`, `.js`, `.mjs`,
    `.css`, `.py`, `.md`, `.svg`) and `views/proposals.json`: the views' code and manifests, without their caches;
  - `orient/run.json` and `orient/summary.md`: the orientation's record, without its session;
  - `chats/<id>.meta.json` and an empty `chats/<id>.jsonl`: the orientation's thread, without its log;
  - `calls/<id>.jsonl`: the calls the report or a card cites (`call:<chat>/<n>`), each with its input and an
    excerpt of its output: the first 30 lines unless only lines are cited, and the lines cited in place, at most 100
    lines in all, each cut to 500 characters, with every other line left empty so that a cited line number still
    holds.

Absolute paths are written as placeholders:
- `@@THIMBLE_WORKSPACE@@` (the workspace);
- `@@THIMBLE_CORPUS@@` (the dataset's folder);
- `@@THIMBLE_APP@@` (thimble's install);
- `@@THIMBLE_HOME@@` (`$THIMBLE_HOME`);
- `@@THIMBLE_USER_HOME@@` (the home folder).

Each also has a `@@THIMBLE_DASHED_…@@` form for where a path is spelled with dashes (`-home-a-…`).

Left out: the conversations (main's chat, the threads, the orientation's log and its steps), the call logs but for
the calls cited, the orientation's work files, label indexes (`*.sqlite`), views' indexes, caches, earlier versions and
the excerpts their keys cite (`views/key-refs.json`), the cards' edit history and card checks, the event stream,
kernels, the scratch mirror of the corpus, telemetry, settings, sessions, permissions, undo, hidden files, pictures and
every file that is not text. The manifest lists each with the reason. The manifest itself is scrubbed and checked
like the workspace's files, since it carries the orientation's request and the paths of the files left out.

## The threshold

The export refuses, naming each file and the start of its longest stretch, when a file it would write shares a
stretch of **400 characters** (about 70 words) or more with the dataset. No flag lets such a file through; take the
long output out of the card or the document, or cut what it prints, and export again.

How a stretch is measured (backend/app/demo_verbatim.py): every string value of a JSON or JSONL file, and the whole
of any other text file (a CSV file is one string), with white space collapsed. The index hashes the dataset's text in
64-character windows every 32 characters, and a file's text at every position. A stretch can measure up to 31
characters short at each end, so every stretch of 462 characters or more is refused, and one between 400 and 461 may
pass. A file is also read with its escapes decoded (`\n`, `\"`, `\u00e4`), and a string of it that is JSON, such as a
call's input or a record printed as a JSON line, as the strings it holds, so a record copied as escaped text measures
as the record. PDFs and pictures in a dataset are not indexed. The measure finds long stretches only: short records of
a JSON or JSONL file, each under 95 characters, copied one after another do not add up to a stretch (rows of a CSV or
text file printed as they stand do), so reading the cards and the cited calls before committing (step 5 below) still
matters.

Why 400. On 2026-10-05, across nine finished orientations (three each of collusion-wiki, mythos-5 and rubyhack), the
longest stretch the kept kinds of file shared with the corpus measured 105 characters (a view's reader); cards and
documents shared 64 or less, label rationales 76, and the excerpts of the cited calls, as the export cuts them, 321.
The parts a pre-cache leaves out shared far more: the call logs up to 16,896 characters, the orientation's work files
16,896, the views' key excerpts 2,000, the chats' logs 298. 400 is about four times the longest the cards, documents,
labels and views held, so a card that quotes a record passes, and a card or call that prints a record whole does not.

## What `thimble demo` does with it

It fills in the placeholders for the new folders and installs `workspace/` as the dataset's workspace, and ends the
orientation's thread with the coverage line the manifest's `orientation` keeps, as a live run's thread ends. It marks
the workspace pre-cached: `precached.json` in the workspace, and `precached` in the orientation's record and its thread's
meta. In the browser, the orientation's thread then says the orientation ran in advance and shows an "Attach a fresh
session" button with a short explainer, the command and a Copy button. Until a session first attaches, the page stays
readable rather than greyed under the card that asks for one, and the composer gives way to the same steps. A message
to the orientation is refused, since its session was not kept.

On a terminal it then asks "Attach a Claude Code session now? (requires claude to be logged in)", Enter for yes,
once `claude auth status` says a login is configured; when it says none, it says how to log in and asks nothing.
`--attach` answers yes and `--no-attach` no. Without a terminal it asks nothing. Either way it prints how to attach
later: `cd <folder> && thimble`, and `thimble -c` in that folder continues the last session.

A session attached to a pre-cached workspace starts fresh. Its `/thimble` gives it what the orientation left as its
context once: the canvas (each card's question and takeaway), the views and the documents, with the full text of
each one written (backend/app/precached.py).

## Making one

1. Download the dataset as a user would, so the orientation runs on the same bytes. Point `--precaches` at an empty
   folder so that no pre-cache is installed: `thimble demo collusion-wiki --dir ~/demo-src --precaches /tmp/none`.
2. Run the orientation in `~/demo-src/collusion-wiki` by one of two routes:
   - **By hand.** Run `thimble` there. In Start, set the orientation's model to Opus 5.5 at xhigh effort, and start
     it with no prompt. Keep the session running, since the orientation and the writer of its report run as its
     subagents, and answer in the terminal any permission request your permission mode leaves to you.
   - **Scripted.** Run `scripts/dev/precache_orientation.py`, which runs `thimble` on a tmux socket of its own and
     presses Start as the browser does.

   Wait until it is done: its views built and its report written. Claude's cyber safeguards flag mythos-5 under Opus
   5.5. On 2026-10-05, an earlier demo dataset ran to the end on claude-opus-4-8, but the same safeguard stopped its
   critic, two verification agents and one view build (the orientation's thread says so).
3. Export it from the checkout: `thimble demo --export demo-collusion-wiki demos/ --outputs-only` (the workspace's name,
   which `thimble demo` makes demo-<dataset>, or its folder). This writes `demos/collusion-wiki/`, replacing an earlier
   pre-cache there. The export refuses, listing
   each finding, when a file copies a long stretch of the dataset, and while it finds your user name, another
   absolute path or a gitleaks finding.
   - `--scrub-user` writes `user` in place of your user name.
   - `--allow-private` keeps the private findings that are left, after you have looked. The manifest's `flagged`
     lists what was kept. It never lets through a file that copies the dataset.
   - `--corpus <folder>` names the dataset's folder, when thimble does not know it.
   - `--app <folder>` names the thimble install the orientation ran in, when it was another.

   It ends with an inventory: the counts, the cited calls, the longest stretch shared with the dataset, the findings
   kept and what it left out. Before it, it names any cited call it could not find in the call logs.

   `check_content` refuses a label whose rows pass 6 MB, such as a code label over hundreds of thousands of records.
   When most of its records took one value, write that value as cover lines over the runs of lines that took it
   (backend/app/labels_store.py: `cover` lines, as a code label run over whole files writes its quiet value), keep the
   other rows, and export again. Every record then reads the same value and the counts are the same; a record a cover
   holds reads with confidence 1 and is named by its line (`#L<n>`).
4. To show reviewed views in place of the ones the orientation built, run `scripts/sync_demo_views.sh --from <the
   THIMBLE_HOME that holds them>`. For each dataset it lists, it takes each reviewed view as thimble serves it there,
   names it as the dataset's view, stamps it with the digest of its files so that install shows it at once, drops the
   pre-cache's other views and their proposals, and updates the manifest and README.md (scripts/dev/demo_views.py).
   Run it again whenever the reviewed views change.
5. Read it: the README, the report and the cards in a browser, and the cited calls. Run
   `python3 scripts/check_content.py`, which applies the checks below and gitleaks.
6. Check it on a clean install with a fresh `THIMBLE_HOME`:
   `thimble demo collusion-wiki --precaches demos --dir /tmp/demo-check`. Open a view to see it rebuild its index,
   and attach a session to see it start from the cards and the report.
7. Commit the folder.

## The full export

`thimble demo --export <workspace> <out>`, without `--outputs-only`, writes version 4: everything in the workspace but
what thimble rebuilds (label and view indexes, caches, kernels, the scratch mirror of the corpus) or what belonged to
the exporter's processes (sessions, the agent tray's instructions, the browser's telemetry). That is every chat and
call output, the labels with each row's rationale and the texts it marked, the views with their earlier versions, the
work files and card checks, and in `transcripts/` the Claude Code transcripts of the workspace's sessions with the
subagents thimble ran in them (the orientation, its critic, the writers, view builds, reviews and checks), and what
Claude Code keeps beside each (saved tool outputs). Each transcript drops the records Claude Code added about the exporter's machine and account
(their CLAUDE.md files, email, organization, skills), as `demo_scrub.clean_transcript` describes. Absolute paths are
written as the same placeholders, and `--scrub-user` writes `user` in place of your user name.

It refuses nothing for its content. It ends with an inventory: the transcripts, the chats, the call outputs, the label
rationales, how much of the dataset's text it holds and where, what may be private (your user name, absolute paths,
gitleaks' findings) and what it left out, each with its size. The manifest holds the same in `inventory` and
`verbatim`, and lists each file and transcript with its SHA-256.

`thimble demo <dataset> --precaches <out>` installs it. Each transcript goes where Claude Code keeps it, under a new
session id that the workspace's files name in place of the old one, so every thread shows its steps. Its agents ran as
subagents of the exporter's session, so none of them can be continued: the orientation's thread says so, and Start
runs a new orientation.

A full export holds the dataset's text, so `scripts/check_content.py` refuses it under `demos/`.

## What scripts/check_content.py allows here

`check_content` refuses `.jsonl` files and files over 2 MB anywhere in the tree. Under `demos/<dataset>/` it allows
them, on these terms only:
- **The manifest lists every file, and it is version 3.** The folder holds `thimble-demo-precache.json` (schema
  `thimble-demo-precache`, version 3: the outputs alone) and `README.md`. Every other file is `workspace/<path>` for
  one of the manifest's `files`. A folder of another version is refused: version 2 carried the orientation's
  transcript, and version 4 is a full export.
- **Outputs only.** Each `<path>` is one of the kinds listed in [What a folder holds](#what-a-folder-holds)
  (backend/app/demo_scrub.py `workspace_kind`): no transcript, no work file, no view index or cache.
- **In the shape the export writes** (demo_scrub.py `shape_findings`, which the export also applies). The only chat
  is the manifest's `orientation.chat`, and its log is empty. A call log holds only the calls the manifest's
  `cited_calls` lists, each output at most 100 non-empty lines of at most 500 characters. No label row carries `spans`.
- **The README carries the source's notice.** `README.md` holds the manifest's `notice` (mythos-5's canary string).
- **Text, and capped in size.** Each file is UTF-8 text of a kind the export writes (`.json`, `.jsonl`, `.md`,
  `.txt`, `.py`, `.html`, `.js`, `.mjs`, `.css`, `.svg`) and at most 6 MB. The folder is at most 30 MB in all.
- **The export's scrub check passes.** No file holds an absolute path under `/home`, `/Users`, `/mnt` or `/root`, or
  this machine's user name as a word. Common user names, such as `runner` or `user`, are not checked. The one
  exception is a finding that the manifest's `flagged` names for that file.

The threshold check needs the dataset, which is not in the tree, so `check_content` cannot repeat it; the manifest's
`verbatim` records what the export measured. gitleaks scans these files like every other, and the other rules
(databases, caches, file names that differ only by case) still apply.
