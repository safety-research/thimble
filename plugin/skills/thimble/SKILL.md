---
name: thimble
description: thimble gives a human analyst a browser workspace beside this session, with a chat, the files, a canvas of cards and a report written from the work. `/thimble` starts the server if needed, opens this folder as a workspace and prints the browser URL, with a note when Claude Code channels are off in this session (thimble then connects through hooks). `/thimble fresh` archives the folder's workspace and opens an empty one, `/thimble restore <name>` brings an archived run back and `/thimble restore` lists them (`resume` does the same). `/thimble status` prints one line, `/thimble fix` repairs a server that will not start, `/thimble feedback` writes a problem report (a zip of the logs) to send the developer.
disable-model-invocation: true
argument-hint: "[fresh | restore [<name>] | status | fix | feedback]"
arguments: [action, archive]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble *) Bash(${CLAUDE_PLUGIN_ROOT}/bin/.thimble-watch *) Bash(true)
---

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble prompt main --unless-launched --cwd "${CLAUDE_PROJECT_DIR}" --action "$action" --archive "$archive" 2>&1 || true`

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble server up --cwd "${CLAUDE_PROJECT_DIR}" --session "${CLAUDE_SESSION_ID}" --action "$action" --archive "$archive" 2>&1`

When this message opens with a prompt that starts `# thimble`, that prompt is yours for the rest of this session, as if it were part of your system prompt: the `thimble` command would have put it there. It does not change your reply to this command.

When a line above starts with `thimble-monitor:`, the browser reaches this session only through a Monitor you run. Before your reply, call Monitor with the command after `thimble-monitor:` as its `command`, "thimble browser events" as its `description` and 1800000 as its `timeout_ms`, and call it again the same way each time it expires, for as long as this session runs. Each of its events is a browser event.

Your entire reply is the lines above that start with `thimble:`, character for character, with no sentence before or after them, no commentary, no summary, no offer to help and no question. The lines are already written for the analyst, so anything you add only lengthens what they have to read.
