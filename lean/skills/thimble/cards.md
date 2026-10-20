# The card guide

This guide says what makes a good card, lists the toolkit a card's program is made of, and ends with examples.

## What makes a good card

A good card asks one clear question, shows content that fits that question exactly, and has a takeaway that answers
it. The common failures in the question and the content are a question that asks several things, content that shows
something other than what the question asks, and a question in jargon the analyst has not used. The common failures in
the takeaway are one that does not answer the question, one that claims what the card does not show, one that claims
more than the data holds, and one crowded with numbers, and the four points below take them in turn.

- **It answers the question first, in words the analyst knows.** The analyst reads the question and the takeaway and
  moves on, so an answer they have to dig out of the content, or a caveat in its place, leaves them without one. A
  caveat comes after the answer, and only when it changes what they would conclude.
- **It claims only what the card shows.** The analyst checks each claim against the content, and a claim they cannot
  find there they must take on trust or read as a mistake. The card shows less than your output: long labels are cut,
  a wide table is cut at the card's edge, and a record shows only its opening unless you quote the passage. So quote
  the passage the takeaway rests on, keep a table to the columns the takeaway uses, or leave the claim out. Quote words
  exactly as the record has them.
- **It claims no more than the data holds.** Compute a claim about every record or about order, and any total, first
  or last, over every record rather than reading it off a chart, and check it against the card's own dates and values.
  When it holds for most, say how many, as in "26 of the 53".
- **It gives the one or two numbers the answer rests on, each with its base.** The analyst cannot take in four numbers
  in one sentence or judge a count without its base, and the rest are on the card.

**Be creative about how you present the content, since the right form lets the analyst see the answer immediately and
the wrong one hides it.** There are no card kinds: you compose the form from the toolkit's parts.
- Bars or a plot for a pattern, a trend or a comparison. People read lengths and positions most accurately, so give
  each value as a number and let the toolkit draw it. Name each color where it stands, such as a bar part's `label`.
- A table when exact values matter, kept to a few short columns and rows named by what they are. Large tables will not
  fit on a card, and the analyst cannot read them at a glance.
- Real records, since one instance makes a pattern believable. Quote the passage that makes the point, and attach more
  records to a part with `k.examples`; the analyst opens them when they select it.
- A timeline for a sequence of events, a causal chain or a story, with about a dozen events at most, each named in a
  few words. One long run reads as its stations in order (`k.map`), and several runs as strips on one axis, so the
  same moment lines up.
- A diagram for how things branch and connect, drawn on the canvas. Steps in a straight line read better as a timeline.
- A total the analyst should take apart, as the pieces that add up to it. A result that rests on a choice, such as a
  threshold, with the choice as a knob, so the analyst sees how the answer changes when they turn it.

**Show the whole first, and the details on demand.** Under your reply the card has about half a screen, and the detail
view (`k.mode === 'detail'`) has more room for more of the same. The analyst opens a part to read its records, so the
card itself does not list them.

**Use color to make what the question needs stand out, one encoding at a time.** The analyst's attention is limited,
and many colors at once overload them. Gray (`dim`) is for context, for "other" and for what is turned off. Draw what
you did not read with `k.unseen()`, so a gap does not read as a zero.

**Choose a sequence of cards with the same care as a single card.** When a question takes several steps, or one card
raises the next question, answer with as few cards as the question needs, and give the answer itself in your reply. A
card should show a single finding, not your process. Say how you worked in a sentence. The analyst can follow three or
four cards that build on each other, and cannot follow ten. Usually lead with the card that answers the question most
directly, then the pattern and the examples that support it. When the answer would not make sense on its own, lead
instead with a card that builds their intuition, such as a few real records or the shape of the data. A why question
wants a story, such as a timeline or a diagram, more than a count.

## The toolkit

A card's program is the body of a function `(k, data) => node`. `data` is the card's data, with query outputs bound in
it, and `k` is the toolkit. Return what to draw. The same program draws in the terminal, in cells, and in the browser,
with type and lines. It runs in a sandbox: it sees `k` and `data` and nothing else, and it runs start to end, with no
`await`. There are no chart types: the helpers below are made of the same parts, and when one does not fit, build your
own from `stack`, `beside` and the canvas.

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

**Text and layout.** `k.text(str, { tone, bold, align, wrap, max, w })`, where `str` may hold `**bold**`, `{dim:words}`
for a tone, and `[words](#id)` for a link to a part or a knob; `k.escape(s)` makes data safe to put in it.
`k.stack(...parts, { gap, align })` puts parts under each other, `k.beside(...)` side by side, and `k.frame(part,
{ title, right, bottom, tone })` draws a border with a title. A part may be a node, a string, a number, an array or
`false` (left out). `k.size(part, { w, grow })`, `k.space(w, h)` and `k.rule()` place them.

**Values.** A value given as a number stays a number: the browser draws it exactly, and the terminal rounds it to cells.
`k.bar(value, { max, tone })`, or `k.bar([{ value, tone, label }, ...], { max })` for stacked parts, each `label` drawn
inside its part when it fits. `k.bars(items, { max, labelW })` draws rows of label, bar, value and note, an item being
`{ id, label, value | parts, tone, note, meta }`. `k.spark(values, { min, max, tone, w })` is a one-line trend.
`k.plot(series, { h, x: { label, log, min, max }, y: {...}, dots, brush })` takes numbers, `[x, y]` pairs, or
`{ id, name, values | points, tone, meta }`. `k.table(rows, { cols, max, id, cite, examples })` takes `cols` as keys or
`{ key, label, align, fmt, tone, w }`. `k.unseen({ label, w, h })` draws what you did not read, hatched. `k.legend(items)`
is there for a color you cannot name where it stands.

**Parts the analyst can select.** `k.region(id, meta, part)` makes a part. The id names what the part is
(`day-06-18`), not where it sits, since a selection and a question about the part carry it, so keep ids when you change
the program. `meta` is a label or `{ label, ref, cite, examples, note, row, ... }`. A bar item, a stacked part, a table
row or a region's meta made from a row of a bound query output (the row, `{ ...row }` or `{ row: d }`) opens the records
behind that row. `k.cite(id, { text, source, query, rows, note })` and `k.examples(id, { label, records, total, fmt })`
register a citation or a set of real records and return the id, and a region points at them with `{ cite, examples }`.

**Knobs and keys.** `k.knob(id, { values, at, label, fmt })` returns the value the analyst set, else `at`; `values` is a
list (up to 2,000) or `{ min, max, step }`. `k.dial(id)` draws it as `label ◂ value ▸`, and a link `[words](#id)` is the
knob too. `k.on(name, fn, label)` answers a key (`'j'`), a press on a part (`'press:<id>'`) or a drag in the browser
(`'brush'`); `fn(event)` returns the new state, and the program runs again and reads it in `k.state`. In a handler,
`k.set(key, value)` sets one value, and `k.ask({ label, rows, text })` sends the analyst's next question to the card's
thread. A card gets its keys while it has the focus, and the bar shows each with the label you gave it, such as
`c flip · , . year`, so the card draws no key hints. Claude Code keeps ← and → in the terminal, and `0` goes back, so a
card never gets them; `thimble save` names a key a card cannot get.

**A map of work.** `k.map(spec, { full, lens })` lays work out by its own structure: `threads` (runs, agents) with their
`stops` or `moves`, `stations`, `links`, `groups`, and a `lens`, the thread field that colors the lanes. One thread draws
as a line of its stations, many as lanes that split and merge, and stations with no threads as boxes. Under a reply it
draws its short form, and in the detail its full form. Each station, lane and group opens its records.

**The canvas.** `const c = k.canvas(w, h)` draws a shape no helper has, in cells (x across, y down), and sits in a stack
or a frame like any part. `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h,
ch, tone)`, `c.bg(x, y, w, h, tone)`, `c.hline` and `c.vline(x, y, len, ch, tone)` (`─` a line, `━` heavy, `╌` dashed),
`c.box(x, y, w, h, { title, tone, fill })`, `c.dot(x, y, tone, { size, label, part })` and `c.link(x0, y0, x1, y1, tone)`
for nodes and links, `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })` for values,
`c.region(id, x, y, w, h, meta)` for a part, and `c.brush(id, x, y, w, h, { min, max })` for a range a browser drag reads.

**Other.** `k.w` and `k.h` are the room in columns and rows, `k.mode` is `'inline'` under a reply and `'detail'` in the
detail view, `k.fmt(n, { dp, pct, sign, compact })` formats numbers people read, `k.len(s)` is a string's width, and
`k.cat(i)` is the i-th category tone. Tones name meanings: `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and
`c1` to `c6` for categories; `c2-faint` is `c2`, stepped back.

**When something goes wrong.** `thimble save` checks each citation and binding, saves the card anyway, and lists each
problem: fix it and save again under the same name. A program that throws shows one line under the card's title with
the error and what to fix, and warnings come back with the drawing. To check a key or a press before the analyst tries it,
run the saved card with an event: `node ../../draw/cli.mjs thimble/objects/<id>.json --text --event
'{"type":"key","key":"f"}'`.

## Examples

```
Analyst   What caused most of last quarter's outages?
          question   What caused the outages written up in postmortems from July to September?
          content    bars of postmortems per cause, from a label that sorts each postmortem by the cause it names
Good      takeaway   Most outages were caused by configuration changes, 14 of the 22 postmortems that name a cause.
                     The other 9 of the 31 name none.
Bad       takeaway   The postmortems follow three different templates, and 9 of the 31 name no cause, so causes are
                     hard to compare across teams.
```

The bad takeaway describes the data instead of answering the question, the first failure, although its own chart
answers plainly.

```
Analyst   Show me a run where the agent deleted a failing test instead of fixing the code.
          question   What did the agent do when the date test kept failing in run 41?
Good      content    the three transcript records where the test fails, the agent says it will remove the test, and
                     it deletes the file, each quoted
          takeaway   After the date test failed twice, the agent wrote "this test is flaky, removing it" and deleted
                     the test file.
Bad       content    the first record of run 41, which shows only the task statement
          takeaway   (the same)
```

The takeaways are the same, but the bad card does not show what its takeaway claims, the second failure. It shows only
how the run begins, so the analyst finds neither the failure nor the deletion on it.

```
Analyst   Did the new permit rule stop the late-night construction complaints?
          question   How many late-night construction complaints came in each week before and after the permit rule
                     of June 1?
          content    complaints per week from April to August, with June 1 marked
Good      takeaway   Mostly. They fell from about 40 a week before the rule to about 6 a week after it, and some still
                     came in every week to the end of August.
Bad       takeaway   Yes. They fell from about 40 a week before the rule to none from June 1 on.
```

The bad takeaway claims more than the data holds, the third failure. It says none came after June 1, while its own
chart shows a few every week.

```
Analyst   Which bus lines run late most often?
          question   Which bus lines ran more than five minutes late most often in March?
          content    a sorted bar chart of the share of late trips per line, the bars named by line, such as Line 12
                     Harbor, not by route ids like rt_0012_v3
Good      takeaway   Line 12 Harbor ran late most often, on [212](r4#line=line-12-harbor@late) of its 930 trips,
                     nearly twice the share of the next line.
Bad       takeaway   Line 12 was late on 212 trips (22.8%), Line 7 on 118 and Line 30 on 97, with a mean of 3.4
                     minutes late (sd 2.9).
```

The bad takeaway crowds in six numbers, the fourth failure, and two of its counts have no base, so the analyst cannot
tell which line is late most often for its size.

```
Analyst   Why did refunds jump in March?
Good      reply   Refunds jumped in March because a shipment of X200 chargers delivered at the end of February began
                  failing in the first days of March, and nearly all of the extra refunds are for those chargers.
          cards   1  timeline   the shipment, the first failure reports, the refunds
                                Batch 17 shipped on February 24, failure reports began on March 2 and refunds peaked
                                on March 10.
                  2  bars       refunds per week by product: The jump is all X200, from 20 a week to 140 after March 3.
                  3  records    three March X200 refund tickets, quoted: Each says the charger stopped working within
                                days.
Bad       reply   I loaded the 4,120 tickets, ran describe() on the table and grouped refunds by product, week and
                  day. Refunds rose from 118 in February to 612 in March (+418.6%). The X200 accounts for 548 of the
                  March refunds (89.5%), and the daily count peaked at 31 on March 10. See the cards for the analysis.
          cards   1  describe() of the ticket table   2  refunds by product and week, 60 rows   3  refunds per day
                  4  refunds by shipment batch         5  a summary note
```

The bad reply retells the work and lists numbers instead of answering, the cards follow the order the work was done
in, and no card says why. The analyst has to piece the answer together from cards 3 to 5.

### Four programs

Each program's data is in `forms/<name>.data.json` beside this file.

Bars split by a label. Each day is a part that opens its records and real saves when the analyst selects it, and each
piece is named where it stands.

```js
const P = [['ask', 'c1'], ['instruct', 'c3'], ['share', 'c2'], ['test', 'c5']]
const items = data.days.map(d => ({
  id: 'day-' + d.day, label: d.day.slice(5), parts: P.map(([p, tone]) => ({ value: d[p], tone, label: p })),
  meta: { ref: `r1#day=${d.day}@n`,
    examples: k.examples('ex-' + d.day, { label: `saves to other agents on ${d.day}`, records: d.examples, total: d.n, fmt: '“{text}”\n{user} · {purpose}' }) },
}))
return k.stack(
  k.text(`**${k.fmt(data.total)}** saves to other agents`),
  k.bars(items),
)
```

A total taken apart. How to split it is a choice, so it is a knob, and the card checks that the pieces add up to the
total.

```js
const by = k.knob('by', { values: Object.keys(data.splits), at: 'purpose', label: 'unfold by' })
const parts = data.splits[by]
const sum = parts.reduce((s, p) => s + p.n, 0)
return k.stack(
  k.beside(k.text(`**${k.fmt(data.total)}** ${data.what}`), k.dial('by'), { gap: 3 }),
  k.bars(parts.map(p => ({ id: `${by}-${p.key}`.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').slice(0, 60), label: p.key, value: p.n,
    note: `${Math.round(p.n / data.total * 100)}%`,
    meta: { ref: p.ref, examples: data.examples[p.key] && k.examples('ex-' + p.key, { label: `saves that ${p.key}`, records: data.examples[p.key], fmt: '“{text}”\n{user}' }) } }))),
  k.text(sum === data.total ? `{dim:${parts.map(p => k.fmt(p.n)).join(' + ')} = ${k.fmt(sum)}}` : `{warn:the pieces add to ${k.fmt(sum)}, not ${k.fmt(data.total)}}`),
)
```

Several runs on one axis. No helper has this shape, so it is drawn on a canvas: one strip per run, each cell what the
run was doing at that share of its steps.

```js
const tone = { read: 'c4', search: 'c3', edit: 'c2', test: 'c1', rerun: 'c5' }
const W = Math.min(k.w - 18, 100)
const rows = data.runs.map(r => {
  const c = k.canvas(W, 1)
  for (let x = 0; x < W; x++) c.put(x, 0, '▆', tone[r.buckets[Math.floor(x / W * r.buckets.length)]])
  const share = r.buckets.filter(b => b === 'rerun').length / r.buckets.length
  return k.region('run-' + r.id, { label: `${r.id}: ${r.outcome}, ${Math.round(share * 100)}% reruns`, ref: `r7#run=${r.id}@steps`,
    examples: data.examples[r.id] && k.examples('ex-' + r.id, { label: `${r.id}'s key steps`, records: data.examples[r.id] }) },
    k.beside(k.text(`**${r.id}**`, { w: 4 }), c, k.text(r.outcome, { w: 8, tone: r.outcome === 'fixed' ? 'good' : 'bad' }), { gap: 1 }))
})
return k.stack(
  k.text(`${data.runs.length} runs, each scaled to its own length · ${Object.entries(tone).map(([a, t]) => `{${t}:■} ${a}`).join('  ')}`),
  ...rows,
)
```

One long run, as its stations in order. A query gives each step of agent-05's run a station, by step ranges you
chose after reading the run, with one output row per station (`thread`, `station`, `start`, `end` and its records).
`k.map` draws the stations in order, each as wide as its share of the steps, and each opens its records. The card's data
is the spec, with the query's output bound as `moves`:

```json
{"title": "agent-05 · 143 tool calls", "unit": "calls", "threads": [{"id": "agent-05", "steps": 143}], "moves": "r1",
 "stations": [{"id": "orient", "label": "reads the board"}, {"id": "fix-a", "label": "fixes PR #66708", "note": "edits, runs pytest 6 times"},
  {"id": "review", "label": "reviews #66534"}, {"id": "fix-b", "label": "fixes PR #66763"}, {"id": "merge", "label": "merges", "mark": "✓"},
  {"id": "tidy", "label": "cleans up"}]}
```

```js
return k.frame(k.map(data), { title: data.title })
```

Under the reply it reads `reads the board ─ fixes PR #66708 ────── reviews #66534 ─ fixes PR #66763 ─ merges ✓ ─ cleans up`.
Many runs draw as lanes that split at the stations where they differ, colored by the thread field you name as `lens`.
