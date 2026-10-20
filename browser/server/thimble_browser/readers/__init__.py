"""The File browser's readers: what the page shows of a file beyond its lines, as thimble 0.8 showed it.

The modules are thimble 0.8's (backend/app/), with their routes moved to the feature module `files.py` and their access
to the folder through `base.py`:

- transcripts.py: whether a file reads as a transcript, in any of the formats 0.8 knew, and its turns.
- source_keys.py: the keys of a file's records that name a kind or a who (Color by and the overview track).
- source_events.py: a file's records on a time axis (the Timeline mode) and its page (files_timeline.html).
- records.py: the records of a file that labels mark and refs name: lines, a JSON document's values, CSV rows, a
  database's rows and a PDF's pages.
- refs.py: the file refs (`<path>#L3.b1:c4-9`, `<db>#<table>/<key>`, `<pdf>#p4`) and a record's blocks.
- pdfs.py: a PDF's page texts, for the excerpt of a page ref.

Every path comes in relative to the folder and goes through `base.safe_path`, which refuses one that leaves it. Nothing
here writes into the folder. A database is opened read-only.
"""
