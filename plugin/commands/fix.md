---
description: "Change thimble for yourself: say what you want different. Then try it, u undoes it, and /thimble:fix submit shares it"
argument-hint: "<what you want changed> | submit | undo | try"
---
The analyst wants thimble itself to change: $ARGUMENTS

Make the change in a copy of thimble, never in the data folder. Start with `thimble fix new "<a short title>"` and work in the worktree it prints. Do the work in a background subagent, so the analyst can keep working, and say so in one line. When the plugin's tests pass, run `thimble fix use <slug>`: the analyst then tries the change in their own thimble. If it is a wish that you cannot make as a change, start with `thimble fix new "<a short title>" --kind report` and write it as an issue instead.
