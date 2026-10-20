# Verbs

A verb is a folder here. Adding the folder adds the verb: to the hint row under each object, to the `?` list, to the
detail view's keys and to `/verb`. Nothing else registers it. `trace/` is the smallest to copy.

```
verbs/<name>/
  verb.json   {"key": "t", "name": "trace", "line": "one line on what it does", "order": 3}  plus any field you want; all are kept
  run.mjs     export async function run(ctx) { ... return { object, text, note, ask } }
  SKILL.md    the verb's one-page skill for Claude: principles and worked examples (the plugin lists verbs/ as skills)
  hint.mjs    optional: export function applies(object, { drawing }) { return 'a short phrase for THIS object' or null }
```

`ctx` holds `object` (as the kernel keeps it), `region` (the selected part's id, or null), `regionMeta`, `refs` (the
kernel refs behind the selection), `drawing` (the object as the person sees it), `state` (the knobs' values), `args`
(words typed after the verb), `root`, `verb` (its verb.json, with `dir`), `skill` (its SKILL.md), `kernel` (`run`,
`json`, `resolve`, `list`, `objects`, `save`), `draw` (`runProgram`, `renderTerm`, `renderSvg`, `gridText`), `model`
(`complete`, `fork`) and `w`. `shell/node/verb.mjs` builds it and says what each part is.

`ctx.model` is the session's own model, one quiet call: `complete` as `$.model.complete` (no history), `fork` as
`$.model.fork` (over the conversation). A verb runs in a Node child, which has no `$`, so the first call stops the run;
the shell makes the call and runs the verb again with the answer. Call the model the same way each run and it works.
Calls started together (`Promise.all` over `ctx.model.complete`) are all handed back, and the shell makes them side by
side, `parallel` at a time (verb.json, default 4), trying again a call the API turned away while busy, then runs the verb
once more with every answer; a verb runs at most `rounds` times (verb.json, default 8). A request's `units` field (how
many things the call covers) is shown as progress under the object (`label… 120 of 412 records`) and never sent.
`verbs/label/` is the example: it asks for a wave of calls, writes what their answers gave, then asks for the next.

A verb whose verb.json says `"feed": true` may also be asked for by the kernel: a `{"kind": "verb", "verb", "object",
"args"}` line in the session's change feed (`thimble label NAME --prompt …` writes one). The shell runs it once, beside
the session, on that object, from the moment the line is written (it looks at the feed while a command runs), and draws
the object it makes in the old one's place.

`run` returns any of these, and any other field is kept:

- `object`: an object to show. A spec (`{name, title, program, data, ...}`) is saved with `thimble save`, so its lineage
  is the kernel's (a `lineage` of the verb's own is kept under `declared`); an object the verb saved itself, or one
  that is already saved, is given as `{id, version}`. It is drawn under the reply where the person pressed, after the
  object it came from; pressed in the detail view, it opens there. A new version of the same object takes its place.
  Its `hints` field names the verbs to suggest under it.
- `text`: words for the person (a toast, or a line in the detail view); Claude reads them too.
- `note`: words for Claude alone, given with the next prompt. No row and no turn.
- `ask`: a request for Claude, sent as a prompt once the session is idle, for a verb that needs Claude to do the work
  with its tools. Its row reads as one line naming the verb and the object.

The hint row shows 2–3 verbs: those the object names in its `hints` field first, then those whose `hint.mjs` has a
phrase for it, in the order of their `order` field. Once the observer (`../observer/`) has looked at the turn that saved
the object, its ranking takes that rule's place: it reads every verb's `line` and `hint.mjs` phrase beside the object's
lineage, picks the 2–3 most worth doing for this object, and writes a few words for each (`t trace the 412 to its
rows`). A verb without `hint.mjs` shows only in `?` until the observer picks it. Every verb with a key works on that key
in the detail view.

Run a verb by hand: `node shell/node/verb.mjs run <name> < input.json`, or `/verb <name> [object] [region] [words]` in
a session.
