---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--no-deck] [--no-views] [--report] [--no-critique] [--manual | --auto]` passes the focus as the brief and the flags as Start's switches and a lower permission mode.
disable-model-invocation: true
argument-hint: "[focus] [--no-deck] [--no-views] [--report] [--no-critique] [--manual | --auto]"
---

Call `start_orientation` with the words below that are not flags as its brief, or an empty brief for the whole corpus. Each flag sets one argument, and an argument no flag sets is left out, so that its default holds: `--no-deck` sets `final_notebook` to false, `--no-views` sets `propose_views` to false, `--report` sets `generate_report` to true, `--no-critique` sets `critique` to false, and `--manual` or `--auto` sets `permissions` to that mode, which only lowers the mode Start or the workspace chose.

$ARGUMENTS
