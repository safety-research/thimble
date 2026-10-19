---
name: trace
description: Use when the person asks where a number, a quote or a line came from, or where it went - the query, label and rows behind a value, the answers and objects that use a row, or which agents read a note and which copied it. `thimble trace` gives the facts in both directions; you decide how deep to go and draw it for this case.
---

# Trace: where it came from and where it went

The person presses t on a value, a quote or a line, or asks "where does this number come from?" or "how far did this
spread?". A short path shows at once. When they want more (t again, or a question), you draw the full trace.

`thimble trace REF` gives the facts. REF is a value (`obj:01-uses#/purposes/1/n`, `q2#purpose=message%20to%20agents@n`),
a row (`revisions.jsonl#L4410`) or a block of a transcript (`agents/agent-05.jsonl#L565.b0`). `--text "words"` follows
those words through the transcripts beside it, or through `--in GLOB`. `--json` gives everything.

- **Back:** a value's query and its code, the label queries it builds on, its source rows, and the files not behind
  it. For a line an agent wrote: the passages it shares with what that agent read before, when and in what it read
  them, and the agent that wrote them first.
- **Forward:** the queries, objects and answers that use it. For words in transcripts: who wrote them first, who
  read them, who wrote them after reading them, who read them and held out, and who never read them.

## Principles

**Answer the question the person has.** "Where does 3,934 come from?" wants the path back, one step per line. "How
far did it spread?" wants the readers and the copiers. Show the steps that could change their answer. Fold the rest
into counts they can open.

**Draw the shape of this case.** A chain, rows fanning into a value, a tree of who read and who copied, a timeline of a
spread. Compose it from the drawing toolkit. There is no trace type to fill in.

**Short first.** Two to six lines answer most questions. Offer the rest; do not draw it unasked.

**Counts come from the facts, judgments are yours.** The kernel finds the same words in the same direction. It does
not know whether a copy keeps the idea, changes it, or only mentions it. Read the lines and group them yourself, and
say that the groups are your reading.

**Same words are not always a copy.** Two agents can write the same words because both read them in a tool's help or
a task prompt. When no agent here wrote them before one read them, say "from outside these transcripts".

**Show what is not behind it.** Files the query did not read and agents that never read the note are part of the
answer. Draw them with `k.unseen`.

**Make every step a region with its ref.** Then the person can select a step and trace on from it, and the browser
opens the same step.

## Example: a number back to its rows and forward to the answers (a wiki dataset)

The person asked what the wiki is used for, then pressed t twice on "1,543 messages to agents". `thimble trace` says:
the value is bound from q2, which tallies the label "edit-purpose" kept by q1, a rule in code over all 14,591 rows of
revisions.jsonl; 3 other files are not behind it; one answer cites it. One row per step reads best here.

```js
const f = data.facts, e = k.escape
const q = f.back.chain.find(s => s.step === 'query')
const label = (q.upstream || [])[0]
const value = (f.back.chain.find(s => s.step === 'object') || q).value
const step = (id, ref, words, sub) => k.region(id, { label: words, ref },
  k.text('{dim:←} ' + e(words) + (sub ? '  {dim:' + e(sub) + '}' : ''), { wrap: false }))
const rowsOf = label ? label.inputs : q.inputs
return k.frame(k.stack(
  k.region('value', { label: f.label, ref: f.ref }, k.text('**' + k.fmt(value) + '** ' + e(f.label || ''))),
  step('query', q.id, q.id + ' · ' + q.about, 'tally, each count keeps its rows'),
  label && step('label', label.query, 'label "' + label.name + '" · ' + label.query, label.about),
  step('rows', f.back.records[0].ref, k.fmt(f.back.count) + ' of ' + k.fmt(rowsOf[0].rows_read) + ' rows', rowsOf[0].path),
  k.beside(k.unseen({ w: 3, h: 1 }), k.text('{dim:not behind it: ' + e(f.files.not_used.join(', ')) + '}'), { gap: 1 }),
  f.forward.answers.map((a, i) => k.region('answer-' + i, { label: 'answer, turn ' + a.turn, ref: a.ref },
    k.text('{dim:→} answer, turn ' + a.turn + ': ' + e(a.text), { wrap: false }))),
), { title: 'trace · where ' + k.fmt(value) + ' comes from', right: rowsOf[0].path })
```

## Example: a note through a swarm (agent transcripts)

The person pressed t on a line agent-05 posted, then t again. `thimble trace` says agent-05 read "review wanted #" at
05:28 in what `forge board read 1` showed, agent-01 wrote it first at 05:27, 15 agents wrote it after reading it and
32 read it and held out. You read the 15 lines and grouped them in your json block:
`{"groups": [{"label": "posted REVIEW WANTED #n with a summary", "agents": [...]}, {"label": "only mentioned the pending requests", "agents": [...]}]}`.
A tree shows who read and who copied; each group is a region.

```js
const s = data.facts.spread, e = k.escape
const groups = ((data.claude || {}).groups || []).map(g => ({ ...g, agents: g.agents.filter(a => s.copied.some(c => c.agent === a)) }))
  .filter(g => g.agents.length)
const rest = s.copied.filter(c => !groups.some(g => g.agents.includes(c.agent)))
if (rest.length) groups.push({ label: 'not grouped', agents: rest.map(c => c.agent) })
const dots = (n, tone) => '{' + tone + ':' + '●'.repeat(Math.min(n, 30)) + '}'
const o = s.origin
return k.frame(k.stack(
  k.region('origin', { label: o.agent + ' wrote it first', ref: o.wrote.ref }, k.text('★ **' + o.agent + '** wrote it first, ' + o.wrote.t.slice(11, 16) + ': {dim:' + e(o.lines[0] || '') + '}', { wrap: false })),
  k.text('┗━ ' + s.read + ' read it', { wrap: false }),
  k.text('   ┣━ ' + s.copied.length + ' wrote it after reading it', { wrap: false }),
  groups.map((g, i) => k.region('group-' + i, { label: g.label, agents: g.agents },
    k.text('   ┃  ' + (i === groups.length - 1 ? '┗' : '┣') + '━ ' + String(g.agents.length).padStart(2) + ' ' + dots(g.agents.length, 'accent') + '  ' + e(g.label), { wrap: false }))),
  k.region('held-out', { label: 'read it and held out', agents: s.held_out },
    k.text('   ┗━ ' + s.held_out.length + ' read it and held out  {dim:' + e(s.held_out.slice(0, 8).join(' ')) + (s.held_out.length > 8 ? ' …' : '') + '}', { wrap: false })),
  s.never.length ? k.text('{dim:· ' + s.never.length + ' never read it: ' + e(s.never.join(' ')) + '}') : false,
), { title: 'trace · how far "' + e(s.text) + '" spread', right: s.files + ' transcripts', bottom: 'the groups are Claude\'s reading of each copy' })
```

## Example: a line in a code change, back to a note

A diff line `x = cast(Foo, y)  # type: ignore` was written by agent a31's Edit call. `thimble trace` on that block says
a31 read "# type: ignore" in SCRATCHPAD.md at 10:03 and a07 wrote it first at 09:42. The short path already answers
"where did this come from". If the person asks how many others did the same, trace the words forward with
`--text "# type: ignore"` and draw the spread as above.
