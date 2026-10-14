---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--[no-]deck] [--[no-]report] [--[no-]critique] [--model <model>] [--effort <level>]` starts the orientation as a subagent of this session, with the focus as its brief and the flags as its switches; a switch no flag sets keeps its default, and a model or effort no flag sets takes its value from thimble's Settings.
disable-model-invocation: true
argument-hint: "[focus] [--[no-]deck] [--[no-]report] [--[no-]critique] [--model <model>] [--effort <level>]"
---

Call `start_orientation` with the words below that are neither flags nor the words after `--model` and `--effort` as its brief, or an empty brief for the whole corpus. Each flag sets one argument, and an argument no flag sets is left out, so that its default holds (for the model and effort, thimble's Settings): `--deck` sets `final_notebook`, `--report` sets `generate_report` and `--critique` sets `critique` to true, and each of them with `--no-` in place of `--`, such as `--no-report`, sets its argument to false. `--model` sets `model` to the word after it, and `--effort` sets `effort` to the word after it. Leave out any other word that starts with `--`. Then make the Agent call its result gives, which starts the orientation as a subagent of this session.

$ARGUMENTS
