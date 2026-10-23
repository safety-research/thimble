## suggest

# A viewer for a file type

{{include:preamble.md}}

The analyst opened a file that thimble's files view shows only as raw text or bytes, since none of its built-in modes reads the format. thimble's dev agent can write a viewer for the file type, which then opens every file of that type. From the file's start, you decide whether such a viewer would help the analyst read it, and if so you write the proposal the dev agent builds from when the analyst accepts it.

A viewer helps when the format has a structure a page shows better than its text, such as timed events a player can replay, tiers of annotations over a recording, a capture's nested layers or a binary log's records. It does not help when the text already reads well, such as prose, a config file or code, since the analyst would gain a step and nothing else.

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
