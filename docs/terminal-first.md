# Terminal-first use

You can chat with thimble only in Claude Code and keep the browser as a dashboard.

- **Hide the chat.** The top bar's chat button, or *Hide the chat* in Settings, removes the chat column. Alerts, permission requests, the orientation's progress and its Start move to a dock at the bottom left. A ⌘-click answers in its own box.
- **Terminal-first** (Settings, off by default). Writers and the orientation's critic run as Claude Code background sessions, `thimble:writer` and `thimble:critic`, each with its own folder, permission mode and tools. *Orientation runs as* picks how the orientation runs: as a subagent of your session, in your session's permission mode and effort and without a write fence, workflows or critique of its own; or as the background session `thimble:orient`, with all of those.
- **At the bottom of your terminal.** ↓ at the prompt opens the agent tray, which lists the running threads, the orientation subagent and each background session. Pick one and press Enter to see it and type to it: what you type there appears in the browser's thread, and so does the answer. The statusline lists every running thimble agent with its state, a line after a start names the command that attaches the session (`claude attach <id>`), and a line after its run says it finished. `/thimble:agents` lists them all.
- **Names.** A ⌘-click's thread runs under the thread's name, such as `fork thread:probier-pages-601`, and the orientation subagent as `thimble:orient`.
- **Citations.** Main writes a citation in the terminal as a link on its number, which the browser shows as a chip.
- **Commands.** `/thimble:ask <thread> [message]` sends a message to a thread, as its composer in the browser would. With no message, it asks the thread's question again. `orient` and a view's build thread (`dev/<view>`) work as thread names too. `/thimble:orient [focus]` takes Start's switches as flags: `--no-deck`, `--no-views`, `--report`, `--no-critique`, and `--manual`, `--auto` or `--bypass`.

## Caveats

- **Esc stops an agent.** In the agent tray's view of a subagent or thread, Esc stops that agent, not just the view. To go back to main, press ↓ and pick main.
- **← copies your session.** In Claude Code's agent tray, ← copies your session into a background session. thimble keeps your terminal session connected to the browser; the copy works on its own.
- **Trust and the statusline.** `claude --bg` starts only in a folder Claude Code trusts, so thimble marks its workspaces folder trusted in Claude Code's config. Terminal-first sets the statusline in the corpus folder's `.claude/settings.local.json`, runs your own statusline before it, and puts yours back when you turn the setting off.
- **An undocumented variable.** `thimble` sets `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, which Claude Code does not document, so that a turn ending on a thimble call needs no closing words. Where Claude Code does not read it, main ends such turns with a marker the browser hides. `thimble doctor` shows which applies, on its *turn endings* line.
