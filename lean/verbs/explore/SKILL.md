---
name: explore
description: Use when the person presses x (Explore) on a reply or an object, or asks to explore, scrub, turn or unfold a result. You write a view of this one answer as a short program they can turn and open, with the real rows one key below, and save it with `lean save`.
---

# Explore: a view of this answer that the person can turn and open

The person pressed x on something you made. They want to look into it themselves: see what each number stands on,
turn what you assumed, and read the real rows. You write a short program for this one answer and save it with
`lean save`. There are no view types. Compose what this answer needs from the drawing toolkit (`TOOLKIT.md` in
`lean/draw`), which you can read for anything this page does not show.

## Principles

**Start from what the answer claims.** Each claim gets a part of the view, with an id that names it
(`day-2026-06-18`, `cursor`, `wiki-en`). The sentence that makes the claim links to its part:
`[Jun 18 had the most saves](#day-2026-06-18)`. The reply stays above the view, so do not repeat it. One or two
sentences at the top are enough.

**Every mark leads to its rows.** Bind the data from `lean q`: `"data": {"days": "q1"}`. Each bound row keeps
`_rows`, its source rows. Put them in the part's meta: `k.region(id, { label, rows: d._rows, fields: ['user',
'text'] }, part)`. `fields` names what a person needs to read one row. The person presses ↵ on the part and reads
the rows. If you have only a total, run a query that keeps the rows (`tally`) before you draw it.

**Turn what the answer assumes into a knob.** A threshold, a scale, a split, a window of time, the step of a run:
`k.knob(id, { values, at, label })` returns the value the person set. Draw what follows from it, words included,
so the sentence changes as the person turns it. Put the knob where it acts, with `k.dial(id)` or a link
`[◂ 10 ▸](#min)` in the sentence. One knob is usually enough. Do not add a knob for something the answer does not
depend on.

**A run is explored by scrubbing.** For a long run, a swarm or a session, make the step a knob. Draw the strip of
steps, a cursor, and the step under the cursor, with its call and its result as rows. The part under the cursor
keeps one id (`cursor`), so the selection stays on it while the person scrubs.

**A number unfolds into what explains it.** When one number carries the answer, show the splits that explain it
(by day, by who, by place), each with its rows. A knob can choose the split.

**An idea the reader may not know gets a small working example.** If the answer depends on an idea (a learning rate
that scales with batch size, a filter that drops links), a knob that shows the idea working on this data explains
it better than a sentence. Use this only where the answer depends on the idea.

**Keep it calm.** One title. Use color only where it means something, and say what it means in words. Use short
labels. Fold what is quiet ("17 quiet days") so that what matters stands out. Leave out what the question does not
need. The person can ask you for more.

**Say what is not in hand.** If a file you did not read could change the answer (`lean coverage`), draw it with
`k.unseen()`.

**Change it when the person asks.** A follow-up ("only the en wiki", "split by account") changes the program. Save
it again under the same name and keep the region ids, so the selection survives.

## How to make one

1. Reuse the queries you ran for the answer. Run a new `lean q` only when a part needs rows that you did not keep.
2. Write the program to a file and the object's JSON to another, with the Write tool:
   `{"title": "...", "verb": "explore", "of": "<the object's id, if there is one>", "data": {"days": "q1"}}`.
3. `lean save explore-<name> --from spec.json --program view.js`. Fix each problem that its output lists, then save
   again.
4. Look at it as the person will: `lean verb explore --text explore-<name>` prints the view, and
   `--keys "right enter"` presses keys. A program that throws draws only its error: fix it and save it again under
   the same name, and the fixed version takes its place under your reply.
5. Tell the person in one line what they can turn or open. Do not repeat the answer.

The view shows under your reply. The person opens it, turns knobs (a click on ◂ ▸, or j and k), moves between
parts with tab, and reads each part's rows under it. You see none of this unless they ask you something.

## Example: saves per day, from a wiki's edit log

The answer was "Jun 18 had the most saves." The view puts every day under that claim, folds the quiet days into one
row, and lets the person split each day by wiki. Each day leads to its saves.

```js
const label = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const days = data.days.map(d => Object.assign({ label: label(d.day) }, d)), total = days.reduce((s, d) => s + d.n, 0)
const peak = days.reduce((a, d) => d.n > a.n ? d : a)
const split = k.knob('split', { values: ['none', 'wiki'], at: 'none', label: 'split', fmt: v => v === 'none' ? 'no split' : 'by ' + v })
const wikis = [...new Set(data.byWiki.map(r => r.wiki))]
const of = (d, w) => (data.byWiki.find(r => r.day === d.day && r.wiki === w) || { n: 0 }).n
const busy = days.filter(d => d.n >= 100), quiet = days.filter(d => d.n < 100)
const quietN = quiet.reduce((s, d) => s + d.n, 0)
const bar = d => split === 'wiki'
  ? k.bar(wikis.map((w, i) => ({ value: of(d, w), tone: k.cat(i), label: w })), { max: peak.n })
  : k.bar(d.n, { max: peak.n, tone: d === peak ? 'accent' : 'c4' })
const line = (label, part, n, o) => k.beside(k.text(label, { w: 12, tone: o.tone, bold: o.bold }), part, k.text(k.fmt(n), { w: 6, align: 'right', tone: o.tone }), { gap: 1 })
return k.frame(k.stack(
  k.text(`[${peak.label} had the most saves](#day-${peak.day}): **${k.fmt(peak.n)}** of ${k.fmt(total)}.`),
  k.stack(
    k.region('quiet-days', { label: `${quiet.length} quiet days: ${k.fmt(quietN)} saves`, rows: quiet.flatMap(d => d._rows), fields: ['user', 'text'] },
      line(`${quiet.length} quiet`, k.bar(quietN, { max: peak.n, tone: 'dim' }), quietN, { tone: 'dim' })),
    busy.map(d => k.region('day-' + d.day, { label: `${d.label}: ${k.fmt(d.n)} saves`, rows: d._rows, fields: ['user', 'text'] },
      line(d.label, bar(d), d.n, { tone: d === peak ? 'ink' : 'dim', bold: d === peak })))),
  k.beside(k.dial('split'), split === 'wiki' && k.legend(wikis.map((w, i) => [w, k.cat(i)])), { gap: 4 }),
  { gap: 1 }), { title: 'Saves per day', right: 'revisions.jsonl' })
```

## Example: an agent's run, step by step

The answer was "It claimed the PR at step 7, set up the build until step 40, then edited and tested." The person
scrubs a cursor along the run. Under the strip is the step at the cursor, and ↵ opens its call and its result.
The query that made `data.steps` gave each step `_refs` of two rows: the tool call and its result.

```js
const steps = data.steps, n = steps.length
const tone = kind => ({ read: 'c4', edit: 'accent', test: 'good', git: 'c2' })[kind] || 'dim'
const at = k.knob('step', { min: 1, max: n, at: 1, label: 'step', fmt: v => `${v} of ${n}` })
const s = steps[at - 1]
const W = Math.min(n, k.w - 6), cell = i => Math.floor(i * W / n)
const c = k.canvas(W, 2)
steps.forEach((x, i) => c.put(cell(i), 0, x.error ? '▀' : '█', x.error ? 'bad' : tone(x.kind)))
c.put(cell(at - 1), 1, '▲', 'ink', { bold: true })
const kinds = [...new Set(steps.map(x => x.kind))]
return k.frame(k.stack(
  k.text(data.lead),
  c,
  k.region('cursor', { label: `step ${at}: ${s.tool} ${s.what}`.slice(0, 100), rows: s._rows },
    k.stack(
      k.beside(k.dial('step'), k.text(`{dim:${s.t}}`), k.text(`**${k.escape(s.tool)}**`), k.text(`{${tone(s.kind)}:${s.kind}}`), s.error && k.text('{bad:failed}'), { gap: 2 }),
      k.text(k.escape(s.what), { max: 2 }))),
  k.text(kinds.map(kd => `{${tone(kd)}:█} {dim:${kd} ${steps.filter(x => x.kind === kd).length}}`).join('   ') + '   {bad:▀} {dim:failed}'),
  { gap: 1 }), { title: `${data.agent} · ${n} steps`, right: `${steps[0].t} – ${steps[n - 1].t}` })
```

## Example: a threshold the answer chose, as a knob in the sentence

The answer was "A few heavy editors made most of the saves," with "heavy" meaning 20 saves or more. That cut is an
assumption, so it is a knob. The sentence and the part it links to change as the person turns it, and the part
leads to the saves of the accounts above the cut.

```js
const accts = data.accounts.slice().sort((a, b) => b.n - a.n), total = accts.reduce((s, a) => s + a.n, 0)
const min = k.knob('min', { values: [1, 2, 5, 10, 20, 50, 100], at: 20, label: 'heavy means at least' })
const heavy = accts.filter(a => a.n >= min), share = heavy.reduce((s, a) => s + a.n, 0) / total
return k.frame(k.stack(
  k.text(`[${k.fmt(heavy.length)} accounts](#heavy) saved at least [◂ ${min} ▸](#min) times. They made **${k.fmt(share, { pct: true, dp: 0 })}** of the ${k.fmt(total)} saves.`),
  k.region('heavy', { label: `${heavy.length} accounts with ${min}+ saves`, rows: heavy.flatMap(a => a._rows).slice(0, 2000), fields: ['user', 'text'] },
    k.bars(accts.slice(0, 8).map(a => ({ label: a.name, value: a.n, tone: a.n >= min ? 'accent' : 'dim' })))),
  { gap: 1 }), { title: 'Heavy editors', right: `${k.fmt(accts.length)} accounts` })
```
