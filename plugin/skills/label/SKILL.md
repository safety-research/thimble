---
name: label
description: Define a label and apply it to the corpus's records. `/thimble:label <name> [definition] [kind=regex|code|prompt] [paths=<glob>,…] [values=a,b] [limit=N]` calls apply_label, and the label card shows the count of each value.
disable-model-invocation: true
argument-hint: "<name> [definition] [kind=regex|code|prompt] [paths=<glob>,…] [values=a,b] [limit=N]"
---

Call `apply_label` with the scope `files` and these arguments from the words below. `name` is the first word, or the words in quotes when the first word starts with a quote. The words after it that are not `key=value` are the definition. `kind=` sets the predicate's `kind`. With `regex` or `prompt`, the definition is the predicate's `text`, word for word. With `code`, write the function from the definition. Without `kind=`, choose the kind as your guidance under Labels says, and without a definition, write one from the name and the records. `paths=` sets `paths`, split at the commas. Without it, give the globs of the files the label is about, or `*` for every file. `values=` sets `values`, split at the commas, and `limit=` sets `limit`. Then do what the result says, as for any label you run.

$ARGUMENTS
