# Verbs

A verb is a folder here. Adding the folder adds the verb: to the hint row under each object, to the `?` list, to the
detail view's keys and to `/verb`. Nothing else registers it. `echo/` is a working example to copy.

```
verbs/<name>/
  verb.json   {"key": "s", "name": "squeeze", "line": "one line on what it does"}  plus any field you want; all are kept
  run.mjs     export async function run(ctx) { ... return { object, text, note, ask } }
  SKILL.md    the verb's one-page skill for Claude: principles and worked examples (the plugin lists verbs/ as skills)
  hint.mjs    optional: export function applies(object) { return 'a short phrase for THIS object' or null }
```

`ctx` holds `object` (as the kernel keeps it), `region` (the selected part's id, or null), `regionMeta`, `refs` (the
kernel refs behind the selection), `root`, `verb` (its verb.json), `kernel` (`run`, `resolve`, `list`, `save`), `draw`
(`runProgram`, `renderTerm`, `renderSvg`, `gridText`) and `w`. `shell/node/verb.mjs` builds it and says what each part
is.

`run` returns any of these, and any other field is kept:

- `object`: an object to show. A spec (`{name, title, program, data, ...}`) is saved with `lean save`, so its lineage
  is the kernel's; an object the verb saved itself is given as `{id, version}`. It opens in the detail view.
- `text`: words for the person, which Claude also reads.
- `note`: words for Claude alone.
- `ask`: a request for Claude, sent as a prompt once the session is idle, for a verb that needs the model.

The hint row shows 2–3 verbs: those the object names in its `hints` field first, then those whose `hint.mjs` has a
phrase for it, in the order of their `order` field. A verb without `hint.mjs` shows only in `?`.

Run a verb by hand: `node shell/node/verb.mjs run <name> < input.json`, or `/verb <name> [object] [region]` in a session.
