---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--no-deck] [--no-views] [--report] [--no-critique] [--manual | --auto | --bypass]` passes the focus as the brief and the flags as Start's switches and permission mode.
disable-model-invocation: true
argument-hint: "[focus] [--no-deck] [--no-views] [--report] [--no-critique] [--manual | --auto | --bypass]"
---

Call `start_orientation` with the words below that are not flags as its brief, or an empty brief for the whole corpus. Each flag sets one argument, and an argument no flag sets is left out, so that its default holds: `--no-deck` sets `final_notebook` to false, `--no-views` sets `propose_views` to false, `--report` sets `generate_report` to true, `--no-critique` sets `critique` to false, and `--manual`, `--auto` or `--bypass` sets `permissions` to that mode.

$ARGUMENTS
