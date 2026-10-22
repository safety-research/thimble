# thimble browser's tools: the core's

Each `## <tool>` section is one tool Claude gets: its description, then its input schema. The server reads
this file and each feature's `tools-<feature>.md` (server/thimble_browser/prompts.py tool_text); each agent gets the
ones agent.AGENTS names, and the chat agent those of the features that are on (features/).

## Read

Read a text file of the folder: its lines, numbered, up to 2,000 at a time. Use `offset` and `limit` for a part of a long file.

```json
{
  "type": "object",
  "properties": {
    "file_path": {"type": "string", "description": "The file's path in the folder, such as runs/run-07.jsonl."},
    "offset": {"type": "integer", "minimum": 1, "description": "The first line to read, counting from 1."},
    "limit": {"type": "integer", "minimum": 1, "maximum": 2000, "description": "How many lines to read."}
  },
  "required": ["file_path"]
}
```

## Grep

Find the lines that match a regular expression in the folder's files, or in one file or folder of it. Each match comes back as `path:line: text`, up to 200.

```json
{
  "type": "object",
  "properties": {
    "pattern": {"type": "string", "description": "A Python regular expression."},
    "path": {"type": "string", "description": "A file or folder of the folder to search; the whole folder when left out."},
    "glob": {"type": "string", "description": "Only the files whose name or path match this glob, such as *.jsonl."},
    "ignore_case": {"type": "boolean"}
  },
  "required": ["pattern"]
}
```

## Glob

List the folder's files whose path matches a glob, such as `**/*.jsonl` or `runs/*`.

```json
{
  "type": "object",
  "properties": {
    "pattern": {"type": "string", "description": "A glob relative to `path`; `**/*` lists every file."},
    "path": {"type": "string", "description": "The folder to list from; the whole folder when left out."}
  },
  "required": ["pattern"]
}
```

## run_python

Run Python over the folder's files to compute a value: a count, a total, a first or last. The code runs in a sandbox, in the folder, which it can read and not change, with no network, and with pandas. It returns what the code prints and the value of its last line, such as a DataFrame. Each run starts fresh, so the code loads what it needs; a file it writes in `$TMPDIR` stays there for this conversation.

```json
{
  "type": "object",
  "properties": {
    "code": {"type": "string", "description": "The Python to run."}
  },
  "required": ["code"]
}
```

## draft_report

Draft a report of a problem with thimble itself, for the analyst to review. thimble adds its version and settings, removes any detail that could name the analyst or their data, and shows the analyst a preview of the exact text. Nothing is sent: only the analyst can send the report or save it as a file, from the preview. The result says how many details the scan removed.

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string", "description": "One line that names the problem in thimble's own terms, such as \"Rows fails on a CSV file that uses ; between fields\"."},
    "body": {"type": "string", "description": "Markdown with the sections ## What happened, ## Expected and ## Reproduction (made-up data)."},
    "slug": {"type": "string", "description": "The fix's slug, when you changed thimble with the fix tools: the draft then carries the change, and its body ends with a ## Change section that says what the change does and how it was tested."}
  },
  "required": ["title", "body"]
}
```
