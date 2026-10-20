# The citations' tool

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/features/citations.py).

## read_ref

Read anything thimble can cite, as the analyst sees it, such as a card with its outputs or a record of a file. The analyst may edit a card at any time, so read it again before you rely on it. Read a plain file with Read.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "A ref, as it stands inside a citation's parentheses."}
  },
  "required": ["ref"]
}
```
