## suggest

# A viewer for a file type

{{include:preamble.md}}

From the start of one file, you decide whether a viewer for its file type would help the analyst read it. If it would, you write the proposal that thimble's dev agent builds from when the analyst accepts it.

The analyst opened a file that thimble's files view shows only as raw text or bytes, because none of the view's built-in modes reads the format.

- A viewer helps when the format has a structure that a page shows better than its text. Examples are timed events that a player can replay, tiers of annotations over a recording, a capture's nested layers, or a binary log's records.
- A viewer does not help when the text already reads well, for example prose, a config file or code.

## file

{{path}}, {{size}}, one of {{count}} files ending in `{{suffix}}` in the corpus. Its start, {{what}}:

{{head}}

## proposal

```json
{
  "type": "object",
  "properties": {
    "help": {"type": "boolean", "description": "Whether a viewer would help the analyst read files of this type."},
    "name": {"type": "string", "description": "A short name in Title Case, as the mode shows it, such as Terminal Replay. Empty when it would not help."},
    "why": {"type": "string", "description": "What the analyst sees in it and why that helps, in one sentence."},
    "arrangement": {"type": "string", "description": "What one record is and how one file is laid out, from its overview to one record's details."}
  },
  "required": ["help", "name", "why", "arrangement"]
}
```
