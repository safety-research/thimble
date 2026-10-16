---
name: thimble
description: thimble gives a human analyst a workspace beside this session, with a chat, the files, cards and a report written from the work. `/thimble` turns thimble on in this folder and gives this session thimble's guidance, with a warning when Claude Code hooks are off in it (thimble then connects through a Monitor). `/thimble open` opens the browser workbench, starting the server if needed. `/thimble fresh` archives the folder's workspace and opens an empty one, `/thimble restore <name>` brings an archived run back and `/thimble restore` lists them (`resume` does the same). `/thimble status` prints one line, `/thimble fix` repairs a server that will not start, `/thimble feedback` writes a problem report (a zip of the logs) to send the developer.
disable-model-invocation: true
argument-hint: "[open | fresh | restore [<name>] | status | fix | feedback]"
arguments: [action, archive]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble activate *) Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble guide *) Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble server up *) Bash(${CLAUDE_PLUGIN_ROOT}/bin/.thimble-watch --stream *)
---

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble activate --via command --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" --json 2>&1`

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble guide --if-owed --mark --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" 2>&1`

!`${CLAUDE_PLUGIN_ROOT}/bin/thimble server up --cwd "${CLAUDE_PROJECT_DIR}" --session "${CLAUDE_SESSION_ID}" --action "$action" --archive "$archive" 2>&1`

When this message holds thimble's guidance, which opens with a line that starts `thimble guidance`, that guidance is yours for the rest of this session, as its first line says. It does not change your reply to this command. When Claude Code shows only the start of it and names a file that holds all of it, Read that file before you reply to anything.

When a line above starts with `thimble-monitor:`, thimble reaches this session only through a Monitor you run. Before your reply, call Monitor with the command after `thimble-monitor:` as its `command`, "thimble events" as its `description` and 1800000 as its `timeout_ms`, and call it again the same way each time it expires, for as long as this session runs. Each of its events is one of thimble's events.

Your entire reply is the lines above that start with `thimble:`, character for character, with no sentence before or after them, no commentary, no summary, no offer to help and no question. The lines are already written for the analyst, so anything you add only lengthens what they have to read.
