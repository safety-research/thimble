# The report's tools

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/features/report.py).

## read_document

Read the report as it stands, as Markdown: the analyst's own notes, headings and figures included, and above each block you wrote, the line `<!-- by: claude -->`. Read it before you change it.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, as a request for it names it. Default: the report."}
  }
}
```

## write_document

Save the report whole, as Markdown in the report's form. Use it for a report that is empty, or one the analyst asked you to write anew; change a report that holds their work with edit_document. The result names each citation that does not open, so you can fix it before you end.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, as a request for it names it. Default: the report."},
    "text": {"type": "string", "description": "The whole report: `# ` its title, `## ` each section, cited paragraphs, and figures as `![what to take from it](card:<id>)` on lines of their own."}
  },
  "required": ["text"]
}
```

## edit_document

Change one passage of the report in place: the words `old_text`, exactly as read_document shows them, become `new_text`. An empty `new_text` deletes the passage, and `new_text` that starts with `old_text` adds after it. The analyst's own words stay as they are everywhere else. The result names each citation that does not open.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, as a request for it names it. Default: the report."},
    "old_text": {"type": "string", "description": "Words of the report, exactly as they stand, enough of them to occur once."},
    "new_text": {"type": "string", "description": "What they become, in the report's Markdown form."}
  },
  "required": ["old_text", "new_text"]
}
```
