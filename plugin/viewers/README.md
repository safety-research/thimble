# Worked examples of custom views

The dev agent reads these when it builds a view (prompts/dev-view.md); thimble never installs them as views of a
workspace. Each folder holds a view (view.json, reader.py, view.html and view.term.js), invented files under sample/
and the sample labels `thimble demo --examples` defines over them (labels.json).

- `timeline`: events on a time axis, the base layout. An overview of lanes on the time range, the events in the kit's
  table under it, the search, Filter by, Rows and Color by in the top row, and an event in the side panel, its words
  drawn by `thimble.text` and its record by `thimble.record`.
- `repository`: records from a system the analyst knows, drawn the way that system draws them. A code forge's pull
  requests, issues and agents and a message board's threads in the kit's table with the search, each opened as its page
  in the side panel: a conversation, a timeline and a thread drawn by `thimble.messages`, a commit's patch by
  `thimble.diff`.
- `linked-sessions`: reading many related transcripts. Sessions as a tree, the chosen session's transcript at the
  center, drawn by `thimble.transcript` and found in by the search, and the links between sessions.
