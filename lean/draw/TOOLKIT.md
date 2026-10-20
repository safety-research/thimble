# Drawing a card

A card's program is the body of a function `(k, data) => node`. `data` is the card's data, with query outputs bound
in it. `k` is the toolkit. Return what to draw. The same program draws in the terminal, in cells, and in the browser,
with type and lines. It runs in a sandbox: it sees `k` and `data` and nothing else (no files, no network, no clock),
and it runs start to end, with no `await`. The card guidance says what makes a good card; this page lists the parts.

```js
const total = data.days.reduce((s, d) => s + d.messages, 0)
return k.frame(k.stack(
  k.text(`**${k.fmt(total)}** messages in ${data.days.length} days`),
  k.bars(data.days.map(d => ({ id: 'day-' + d.day, label: d.day, value: d.messages }))),
), { title: 'Messages per day' })
```

There are no chart types. The helpers below are conveniences built from the same parts; when one does not fit, build
your own from `stack`, `beside` and the canvas.

## Text and layout

- `k.text(str, { tone, bold, align, wrap, max, w })`. In `str`: `**bold**`, `{dim:words}` for a tone, and
  `[words](#id)` for a link to a region, a cite or a knob. `k.escape(s)` makes data safe to put in markup.
- `k.stack(...parts, { gap, align })` puts parts under each other, `k.beside(...)` side by side, and
  `k.frame(part, { title, right, bottom, tone })` draws a border with a title. They nest to any depth. A part may be a
  node, a string, a number, an array (a stack), or `false` (left out).
- `k.size(part, { w, grow })` fixes a width or takes spare width; most parts also take `w` and `grow`. `k.space(w, h)`,
  `k.rule()`.

## Values

A value given as a number stays a number: the browser draws it exactly, and the terminal rounds it to whole cells.

- `k.bar(value, { max, tone })`, or `k.bar([{ value, tone, label }, ...], { max })` for stacked parts. A part's
  `label` is drawn inside it when it fits.
- `k.bars(items, { max, labelW })`: rows of label, bar, value and note. An item is `{ id, label, value, tone, note,
  meta }`, or `parts` in place of `value`.
- `k.spark(values, { min, max, tone, w })`: a one-line trend. `null` is a gap.
- `k.plot(series, { h, x: { label, log, ticks, min, max }, y: {...}, dots, brush })`. A series is numbers, `[x, y]`
  pairs, or `{ id, name, values | points, tone, meta }`.
- `k.table(rows, { cols, max, id, cite, examples })`. `cols` is keys or `{ key, label, align, fmt, tone, w }`. `id`,
  `cite` and `examples` are functions of a row, and make each row a part.
- `k.unseen({ label, w, h })`: what you did not read or could not get, hatched. `k.legend(items)`, `k.dots(n, total)`.

## Parts the analyst can select

- `k.region(id, meta, part)` makes a part. The id names what the part is (`day-06-18`, `run-sgd-b32`), not where it
  sits. A selection, a link and a question about the part all carry the id, so keep ids when you change the program.
  `meta` is a label, or `{ label, ref, cite, examples, note, row, ... }`; any other field is kept.
- A bar item, a stacked part, a table row, or a region's meta made from a row of a bound query output (the row,
  `{ ...row }`, or `{ row: d }`) opens the records behind that row, with real examples spread across them.
- `k.cite(id, { text, source, query, rows, more, note })` and `k.examples(id, { label, records, total, fmt })` register
  a citation or a set of real records and return the id. A region points at them with `{ cite, examples }`. `k.rows(x)`
  gives the refs of rows of the data.

## Knobs and interaction

- `k.knob(id, { values, at, label, fmt })` returns the value the analyst set, else `at`. `values` is a list (up to
  2,000) or `{ min, max, step }`; `fmt(value)` is how the analyst reads a value. `k.dial(id, { label, w })` draws it as
  `label ◂ value ▸`, and a link `[words](#id)` in a text is the knob too. The program runs again with the new value.
- `k.on(name, fn, label)` answers a key (`'j'`, `'space'`), a press on a part (`'press:<id>'`, or `onPress` in a
  region's meta) or a drag in the browser (`'brush'`, from `k.plot(..., { brush: 'id' })` or `c.brush`). `fn(event)`
  returns the new state, and the program runs again and reads it in `k.state`, the same in both surfaces. `k.event` is
  the event this run answers. In a handler: `k.set(key, value)`; `k.ask({ label, rows, region, text })` sends the
  analyst's next question (or `text`, at once) to the card's thread; `k.after(ms, name, payload)` sends a later event,
  such as the next frame of a replay; `k.do(action, args)` asks the host for an action, such as `'open'`;
  `k.select(id)` marks a part as selected; `k.status(text)` is one short line in the bar.
- A card gets its keys while it has the focus: when the analyst steps onto it with `]` under a reply, or opens its
  detail. The bar then shows each key with the label you gave it, such as `c flip · , . year`, so a hint drawn inside
  the card adds nothing, and it stays there where the key does not work. A few keys stay with the host wherever the
  card is drawn, to move between things and to go back (`0` goes back). Claude Code keeps ← and → in the terminal, so
  a card never gets them there. `k.keys.free(key)` says whether a key reaches the card where it is drawn now, and
  `thimble save` names a key it cannot get. `k.local(...keys)` names state that each surface keeps for itself, such
  as a hover.
- `k.want({ rows: [refs] })` returns those rows once the host has read them, else null; the program then runs again.

## A map of work

`k.map(spec, { full, form, lens, w, rows })` lays work out by its own structure: `threads` (runs, agents) with their
`stops` or `moves`, `stations`, `links`, `groups`, and a `lens`, the thread field that colors the lanes. One thread
draws as a line of its stations, many as a metro map, and stations with no threads as boxes. `full: false` is the short
form under a reply (the default unless `k.mode === 'detail'`). Each station, lane and group is a part that opens its
rows. The map skill says more.

## The canvas

`const c = k.canvas(w, h)` draws a shape no helper has, in cells (x across, y down). It sits in a stack or a frame like
any other part.

- `c.text(x, y, str, { tone, bold, align, max })`, `c.put(x, y, ch, tone)`, `c.fill(x, y, w, h, ch, tone)`,
  `c.bg(x, y, w, h, tone)`.
- `c.hline(x, y, w, ch, tone)` and `c.vline(x, y, h, ch, tone)`: the browser draws `─` as a line, `━` as a heavy
  line and `╌` as a dashed one. `c.box(x, y, w, h, { title, tone, fill })`.
- `c.px(x, y, tone)` and `c.line(x0, y0, x1, y1, tone)` work in half cells down. `c.dot(x, y, tone, { size, hollow,
  label, part, meta })` and `c.link(x0, y0, x1, y1, tone, { dash })` draw nodes and links.
- `c.bar(x, y, w, value, max, tone)` and `c.spark(x, y, values, { w, min, max, tone })` keep values as values.
- `c.region(id, x, y, w, h, meta)` makes a part; `c.brush(id, x, y, w, h, { min, max })` is an area a browser drag
  reads as a range.

## Other

`k.w` and `k.h` (the room in columns and rows), `k.mode` (`'inline'` under a reply, `'detail'` in the detail view),
`k.surface` (`'terminal'` or `'browser'`), `k.title`, `k.id`, `k.fmt(n, { dp, pct, sign, compact })` for numbers
people read, `k.len(s)` for a string's width in columns, and `k.cat(i)` for the i-th category tone. Tones name
meanings: `ink`, `dim`, `accent`, `good`, `bad`, `warn`, `unseen`, and `c1` to `c6` for categories. A tone with
`-faint` (`c2-faint`) is that color, stepped back.

## When something goes wrong

A program that throws, runs too long or draws too much shows one line under the card's title: the error, its line,
and what to fix. Warnings, such as a region with no id or a link to an id nothing defines, come back with the drawing.
To check an interaction before the analyst tries it, run the saved card with an event: `node cli.mjs
thimble/objects/<id>.json --text --event '{"type":"key","key":"f"}'` (`cli.mjs` is beside this file). It prints the
cells the card then draws and the state its handler set.
