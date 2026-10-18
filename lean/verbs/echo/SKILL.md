---
name: echo
description: The echo verb, a test of thimble's verb path. Use only when the person asks to try echo or to check that verbs run.
---

# Echo

Echo says back what an object holds: its parts of data, and where the selected part's value came from. It does nothing
new. It exists so that a new verb has a working example to copy: `verb.json`, `run.mjs`, `hint.mjs` and this file.

## Principles

**Say what is there, not what it means.** Echo lists the object's parts and the rows behind one value. It does not
judge or summarize.

**Keep the lineage.** Echo's own object is saved with the kernel and names the object it came from under `declared`.

## Example

The person selects the bar for June 18 in "Saves per day" and presses `e`. Echo returns:

```
Saves per day (01-saves-per-day@1) holds days: 28 rows.
day-2026-06-18: q1#day=2026-06-18@n comes from 6,543 source rows, such as revisions.jsonl#L28.
```

and a small object with the same lines, drawn under the command row.
