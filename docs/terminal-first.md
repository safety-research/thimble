# Terminal-first use

You can chat with thimble only in Claude Code and keep the browser as a dashboard.

- **Hide the chat.** The top bar's chat button, or *Hide the chat* in Settings, removes the chat column. Alerts, permission requests, the orientation's progress and its Start move to a dock at the bottom left. A ⌘-click answers in its own box.
- **Terminal-first orientation** (Settings, off by default). The orientation runs as a subagent of your Claude Code session, so it appears in the agent tray and you can message it there. In this mode it uses your session's permission mode and effort. It has no write fence, workflows or critique of its own.
- **Threads.** Press ↓ at the prompt to open the agent tray, pick a running thread or the orientation, and press Enter. Messages you type there appear in the browser's thread, and so does the answer.
- **Commands.** `/thimble:ask <thread> [message]` sends a message to a thread, as its composer in the browser would. With no message, it asks the thread's question again. `orientation` and a view's build thread (`dev/<view>`) work as thread names too. `/thimble:orient [focus]` takes Start's switches as flags: `--no-deck`, `--no-views`, `--report`, `--no-critique`, and `--manual`, `--auto` or `--bypass`.

## Caveats

- **Esc stops an agent.** In the agent tray's view of a subagent or thread, Esc stops that agent, not just the view. To go back to main, press ↓ and pick main.
- **← copies your session.** In Claude Code's agent tray, ← copies your session into a background session. thimble keeps your terminal session connected to the browser; the copy works on its own.
- **An undocumented variable.** `thimble` sets `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, which Claude Code does not document, so that a turn ending on a thimble call needs no closing words. Where Claude Code does not read it, main ends such turns with a marker the browser hides. `thimble doctor` shows which applies, on its *turn endings* line.
