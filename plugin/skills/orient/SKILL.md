---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--no-deck] [--no-views] [--report] [--critique] [--model <model>] [--effort <level>]` starts the orientation as a subagent of this session, with the focus as its brief and the flags as Start's choices; what no flag sets takes its value from thimble's Settings.
disable-model-invocation: true
argument-hint: "[focus] [--no-deck] [--no-views] [--report] [--critique] [--model <model>] [--effort <level>]"
---

Call `start_orientation` with the words below that are neither flags nor the words after `--model` and `--effort` as its brief, or an empty brief for the whole corpus. Each flag sets one argument, and an argument no flag sets is left out, so that its value in thimble's Settings holds: `--no-deck` sets `final_notebook` to false, `--no-views` sets `propose_views` to false, `--report` sets `generate_report` to true, `--critique` sets `critique` to true, `--model` sets `model` to the word after it, and `--effort` sets `effort` to the word after it. Leave out any other word that starts with `--`. Then make the Agent call its result gives, which starts the orientation as a subagent of this session.

$ARGUMENTS
