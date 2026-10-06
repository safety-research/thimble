---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--no-deck] [--no-views] [--report] [--critique]` passes the focus as the brief and the flags as Start's switches.
disable-model-invocation: true
argument-hint: "[focus] [--no-deck] [--no-views] [--report] [--critique]"
---

Call `start_orientation` with the words below that are not flags as its brief, or an empty brief for the whole corpus. Each flag sets one argument, and an argument no flag sets is left out, so that its default holds: `--no-deck` sets `final_notebook` to false, `--no-views` sets `propose_views` to false, `--report` sets `generate_report` to true, and `--critique` sets `critique` to true. Leave out any other word that starts with `--`.

$ARGUMENTS
