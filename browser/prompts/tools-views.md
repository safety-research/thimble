# The views' tools

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/features/views.py):
propose_view is the chat's, and the others are the view builder's.

## propose_view

Propose a view: a page in the Files tab that shows the folder's records in a form their files hide, such as a timeline, a network or a forge's pull requests. The analyst sees the proposal as a card with Accept. On Accept, thimble's view builder builds it on its own from these fields and reads the files itself, and the view appears in the Files tab when it passes its checks. Call it only when the analyst asks for a view.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "A short name in Title Case, as its tab shows it, such as Message Board."},
    "description": {"type": "string", "description": "What the analyst sees, in one sentence, such as a wiki page with its edit history or a graph of who replies to whom."},
    "task": {"type": "string", "description": "What the analyst wants to accomplish, in their words, not how."},
    "claims": {"type": "array", "items": {"type": "string"}, "description": "Globs of every file that holds its records, relative to the folder, by pattern rather than one file, such as runs/*.jsonl."}
  },
  "required": ["name", "description", "task", "claims"]
}
```

## write_view_file

Write one of the view's three files whole: `view.json`, `reader.py` or `view.html`. It writes only into the view's own folder.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "enum": ["view.json", "reader.py", "view.html"]},
    "text": {"type": "string"}
  },
  "required": ["name", "text"]
}
```

## view_check

Check the view: its three files, the files its `scope` claims, its reader run on the folder in thimble's sandbox, and its page drawn in a headless browser. It says what to fix, and gives a picture of the page.

```json
{"type": "object", "properties": {}}
```

## finish_view

Run the checks as the record of the build. When they pass, the view appears in the analyst's Files tab.

```json
{"type": "object", "properties": {}}
```
