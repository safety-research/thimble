---
name: orient
description: Orient the analyst in this corpus. `/thimble:orient [focus] [--model MODEL] [--effort LEVEL]` starts the orientation as a subagent of this session, with the focus as its brief; a model or effort no flag sets takes its value from thimble's Settings.
disable-model-invocation: true
argument-hint: "[focus] [--model MODEL] [--effort LEVEL]"
---

Call `start_orientation` with the words below that are neither flags nor the words after `--model` and `--effort` as its brief, or an empty brief for the whole corpus. `--model` sets `model` to the word after it, and `--effort` sets `effort` to the word after it. An argument no flag sets is left out, so that its value in thimble's Settings holds. Leave out any other word that starts with `--`, and tell the analyst in one line that you left it out. Then make the Agent call its result gives, which starts the orientation as a subagent of this session.

$ARGUMENTS
