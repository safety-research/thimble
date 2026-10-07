# Worked examples of custom views

The dev agent reads these when it builds a view (prompts/dev-view.md); thimble never installs them as views of a
workspace. Each folder holds a view (view.json, reader.py, view.html and view.term.js), invented files under sample/
and the sample labels `thimble demo --examples` defines over them (labels.json).

- `timeline`: events on a time axis, the base layout. An overview of lanes on the time range, the events in a list with
  its columns' names, Filter by, Rows and Color by in the top row, and an event's details in the side panel.
- `repository`: records from a system the analyst knows, drawn the way that system draws them. A code forge's pull
  requests, issues and agents and a message board's threads, each opened as its page in the side panel.
- `linked-sessions`: reading many related transcripts. Sessions as a tree, the chosen session's transcript at the
  center, and the links between sessions.
