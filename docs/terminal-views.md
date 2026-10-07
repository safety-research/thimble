# Views in the terminal

In terminal mode a view is drawn in thimble-term's panel by its own program, `view.term.js`, beside the view's
`reader.py`, as `view.html` draws it in the browser. The program imports thimble's terminal view kit, which gives it
the parts every view shares, drawn in terminal mode's look (mods/thimble-term/SPEC.md): Color by with its chips, the
time range, a list with a chosen row and its details in place, a record's place one click away and asking about a row
as a side thread. The rest of the view is the program's own: what it draws, in which rows, and what its keys and clicks
do.

```js
import { colorBy, details, draw, fetch, list } from 'thimble-term'

const colour = colorBy({ fields: [{ name: 'kind', title: 'Kind' }], onChange: load })
const rows = list({ key: (m) => m.ref })
let messages = []

async function load() {
  const data = await fetch({ op: 'board', colour: colour.query() }, { key: 'board' })
  colour.counts(data.counts)
  messages = data.messages
}

draw((d) => {
  colour.draw(d)
  d.blank()
  rows.draw(d, {
    items: messages,
    colour,
    row: (m, r) => r.add(m.author, { d: true }).gap().add(m.text),
    detail: (m, dd) => details(dd, { text: m.text, place: m.ref, ask: { ref: m.ref, text: m.text } }),
    ask: (m) => ({ ref: m.ref, text: m.text }),
  })
})
load()
```

[plugin/viewers/timeline/view.term.js](../plugin/viewers/timeline/view.term.js), a worked example the dev agent reads,
draws what its `view.html` draws: the search, the incident and Color by in the top row, the time range over a lane per
source, and the events by day, each opening in place. `thimble view text timeline --cwd <its sample> --width 120` draws
it as text (below).

## The program's life

The program runs sandboxed, one process per open view, alive while the view shows and ended when the panel shows
something else. It reads no file and opens no socket: what it knows arrives as events, and what it draws leaves as
frames.

- `draw(fn)` registers the function that draws the view: `fn(d)` gets a Drawing as wide as the panel's type area and as
  tall as its rows under the header. The kit calls it again after every event, every answer and every change a part of
  the kit makes, so the program keeps its state in variables and draws from them; `redraw()` asks for it too.
- `fetch(query, {key})` asks the view's `reader.records(index, query)`, as `thimble.fetch` does in the browser, and
  resolves with its answer; a newer fetch with the same `key` drops the older one, which rejects with an `AbortError`.
- `onOpen(fn)` hears each place a citation opens the view at, `{ref, target, key, label, excerpt}` as the reader's
  `resolve()` answered it (the place the view opened at, too).
- `onLabels(fn)` hears the workspace's labels or the label filter change; fetch again there, as the reader keeps only
  what the filter keeps. `labels()` lists every label over files.
- `keep(key, value)` and `kept(key)` keep a value for the view across openings. Color by keeps its choice and the
  values turned off, the time range keeps a range zoomed in.
- `size()`, `theme()` and `view()` give the panel's size, `dark` or `light`, and `{slug, name}`.
- An error the program throws is drawn as red rows that say what failed and where in view.term.js.

## The drawing

A Drawing (`d`) holds rows of styled runs on a grid `d.cols` wide, at most `d.rows` tall (`d.left` rows are left), each
with a 2-cell margin left of the type area for `❯`. Lines past the rows or the columns are cut.

| member | what it does |
|---|---|
| `d.row()` | a Row built left to right; `.end()` draws it |
| `d.line(runs, hits?, margin?)` | a row of runs (a string, a run or a list), with its hot regions |
| `d.blank()` | a blank row, never two in a row and none at the top |
| `d.rule()` | a rule across the type area (a panel has two at most, the header's among them) |
| `d.key(keys, words, run)` | bind keys for this frame, with the words the hint row says after them |
| `d.sub(...facts)` | facts for the panel's subtitle under the view's name, dim, parted by ` · ` |
| `d.typing({text, onText, onKey, hints})` | a part takes typing: the panel's field holds `text` and sends each change to `onText` |
| `d.inner(indent)`, `d.put(inner)` | a drawing `indent` cells in, put in at the current row (a row's details at A2) |
| `r.add(text, style, {on, tip, drag, row, max})` | text in a style; `on(x)` makes it a control, `tip` the words the pointer shows under it |
| `r.gap(n)`, `r.at(col)`, `r.right(text, style)` | space, a column, text against R |
| `r.margin(run)` | the mark in the margin: `❯` and the accent on the chosen row |
| `r.runsOf(runs)` | runs as they are, such as a `strip` |

A run is `{s, fg, bg, b, d, i, u, inv}`: `fg` and `bg` a theme key of `COLORS` or a hue of `SERIES`, `b` bold, `d`
dim, `i` italic, `u` underlined, `inv` inverse. `dim`, `bold`, `link`, `accent`, `problem`, `chosen` and `mark(hue)`
make one. Each style keeps the one meaning SPEC.md gives it: bold for titles and headings, dim for what is secondary,
blue and underlined for a link (`↗` and the place after it), the accent and `❯` for the chosen row, the selection
background for a choice in use (the time range's window), red only for a problem, and a palette hue only on the marks
of the Color by choice. A record's own words are drawn upright, as a file is.

`width`, `charWidth`, `cut`, `clip`, `prefix`, `oneLine`, `pad`, `padStart`, `wrap`, `num`, `plural`, `when`, `hms`,
`dayOf`, `dayName`, `dur` and `placeWords` measure, cut and write text the way thimble-term does: a cut at a word with
`…` against it, counts with thousands separators, a place as `agents.log line 12`. `seg`, `italic`, `merged`,
`lineWidth` and `clipLine` make and measure runs and lines; `HUES` is how many values of a field take a hue (six).

## Keys

A view's pane passes on ↑↓, Enter, Space and Backspace (`up`, `down`, `return`, `space`, `backspace`) and a lowercase
letter, a digit or a sign typed. ←, →, the page keys, Home, End, Tab and Esc reach no element of a pane, so `d.key`
refuses them, and `b`, `t` and `x` are the panel's own (back, the threads, close). The hint row names each key bound in
the frame with its words, in the panel's order: choosing, Enter, Space, the view's own, then `b to go back · x to close`.
Nothing else in the view says which key does what. A key works only while its part is drawn, since a part binds its keys
as it draws.

## Color by

`colorBy(opts)` is the one control for the view's color, as in the browser ([color.md](color.md)). Draw it in the top row
with `colour.draw(d, before)` (`before(r)` adds the row's other controls first) or `colour.add(r)`.

- The row reads `Color by  Kind` and the chosen field's values as chips: `●` in the value's hue, its name, its count
  dim. A click on a chip turns the value off (`○`, dim) or on. Values past the sixth share one chip, `other`, with no
  hue of their own; the records with no value have `no kind` (`not marked` for a label), with a dim mark.
- `c`, or a click on the choice, opens the menu under the row: Off, the fields with their values, then every label
  over files with its values and its kind. Under the chosen row, what it is: a field's description, a label's kind and
  definition with `definition ↗`, which opens the label's panel. Enter colors by it.
- With a label chosen, its name in the top row is followed by `↗`, which opens the label's panel: its definition, its
  runs and its records are a step away in every view that uses it.
- A chip's tip says what its value means: the field's `meanings`, a declared value's `meaning`, a label's value.
- Reset, against R, shows while a value is off, a range is zoomed, a search or a choice is set, or the page's
  `onReset({changed})` says so, and puts them back (`r`). `changed()` and `reset()` do the same from the program.

| option | what it is |
|---|---|
| `fields` | `[{name, title, description?, values?, meanings?, value?(record)}]`, as the browser's |
| `initial` | the field chosen first; the first field by default |
| `chips` | `'filter'` or `'highlight'`: what the page does with a value turned off (from `isOn`) |
| `onChange(colour)` | the choice changed, or a value was turned off or on: fetch and draw again |

| member | what it gives |
|---|---|
| `query()` | `{field, off}`, `{label, name, off}` or null for Off: pass it with each fetch, as the browser's |
| `counts(map)` | the reader's counts of the choice's values, `''` for no value |
| `valueOf(record)`, `colourOf(value)`, `dot(value)` | a record's value, a value's hue, its `●` (`○` when off) |
| `isOn(value)`, `keeps(record)` | whether a value, or a record's value, is on |
| `by`, `field`, `label`, `off`, `values` | the choice and its chips |
| `choose(field \| {label} \| null)`, `toggle(value)` | change it from the page |

A query names the label colored by, so the reader's `thimble.colour_value` reads it even while it is not on in Files.

## Time

`timeRange(opts)` is the one control for a view's time, as in the browser ([time-range.md](time-range.md)).

- `range.draw(d, {gutter})` draws its readout (`16 May 04:31 – 05:10 · 39m`) and its overview strip: a cell per bin of
  the whole span, each the bar of its records (`▁` to `█`) in the Color by hue most of them take. The window is on the
  selection background and the rest dim. It opens on the whole span.
- A click on the strip moves the window there; a drag frames a new range, a drag from inside the window moves it, a drag
  from its edge moves that edge; `[` `]` pan by a quarter and `+` `-` zoom.
- `range.data({times, values, span, marks})` gives it the records' times, their Color by values and the incidents or
  other point events; `range.has(t)`, `from`, `to`, `full`, `set(a, b)`, `set(null)`, `fit()` read and set it.
- `range.scale(cols)` lays the range across a chart's cells: `x(t)`, `t(x)`, `binOf(t)`, `step`, `ticks(gap)`.
- `axis(d, scale, {gutter, marks, onMark})` draws the chart's axis under it, and the marks' labels on a row of their own.
- `strip(scale, items, {value, colour, max, guide})` is one row of a chart over time (a lane), `maxBin(scale,
  groups)` the height every lane shares, and `bar(n, max)` one cell's bar.

## The list

`list({key})` is a list of records with a chosen row; `rows.draw(d, opts)` draws it in the rows left.

- `❯` and the accent mark the chosen row; ↑↓ choose and the chosen row stays in view; a heading item
  (`{heading: 'Sat 16 May 2026'}`) is a bold row no key chooses.
- Enter, or a click on the row, opens its details in place under it, at A2 (`detail(item, dd)`), and closes them;
  `onOpen(item)` hears it, to fetch what they show. `a` asks a side thread about the chosen row (`ask(item)`).
- Each row starts with its mark in its Color by hue. A list taller than its rows has the colored track at its right
  edge: each cell the commonest hue of the rows it stands for, the part in view on the selection background; one many
  times taller adds the zoomed track beside it. A click on the track goes there; the wheel moves the rows.
- `columns(specs, cols)` lays out columns with 2-cell gutters (`{w}`, `{align: 'right'}`, `{grow: true}`):
  `cells(r, values, styles)` adds a row's values, and `header(r, names, {sorted, desc, onSort})` the names, dim, `▼`
  after the one sorted by, each a click that sorts; a list's `header(r)` stands above its rows and does not scroll.
- `details(dd, {text, facts, groups, raw, place, ask})` draws a record's details: its words, its facts on one row, the
  records it links to, its lines as the file holds them, `↗` and its place, and `ask about it`.
- `onWheel(fn)` hears the wheel over the view, for a part of the program's own that scrolls.

## Search and choices

`search({words, onChange})` adds `/ search` to a row: `/` or a click starts typing, and the panel's field then holds
its text, each change of which reaches the search whole (Enter ends). A part of the program's own takes typing with
`d.typing({text, onText, onKey})`. `choice({title, all, key, values, onChange})` adds `incident  all` to a row, whose menu
picks one of its values.

## Acts

`open(ref)` opens a record's place in thimble-term's citation panel, `ask(ref, text)` asks a side thread about it, and
`openLabel(id)` opens a label's panel. Each works only during the analyst's own key or click in the view, as the
browser's label calls do: thimble takes an act only with the frame that answers that event.

## The protocol and the sandbox

thimble's view host (`thimble view host`, backend/app/term_views.py) runs each open view's program and answers its
queries; thimble-term starts it the first time a view opens and talks to it over a Unix socket in a private folder.

| from thimble to the program | |
|---|---|
| `init {source, cols, rows, theme, view, state, labels, open}` | the program's source and what it opens on |
| `resize {cols, rows}`, `key {key}`, `text {value}`, `click {i, seq, x}`, `drag {i, seq, x0, x1}`, `wheel {by}` | the panel's events, each with its number `n`; `text` the whole text of the field that takes typing |
| `answer {id, data \| error}` | a query's answer |
| `labels {labels, filter}`, `open {place}` | the labels changed; a citation opened the view at a place |

| from the program to thimble | |
|---|---|
| `frame {seq, ack, lines, hits, hints, hintKeys, keys, typing, field, sub, overflow?}` | what to draw: rows of runs, hot regions, the keys bound and the hint row, the text of a field that takes typing; `ack` the last event it answers; `overflow` `{rows, cols, first}` when the kit cut rows past the rows or wider than the columns |
| `query {id, q, labels}`, `cancel {id}` | a reader query, and one dropped |
| `act {n, act}` | a place, a thread or a label's panel, made during event `n` |
| `state {state}`, `error {message}`, `log {text}` | what the view keeps, an error, a line it printed |

The program runs in Node with its permission model, which lets it read the kit's folder alone and start no process,
worker or addon, inside Anthropic's sandbox runtime (or bubblewrap where that does not run), which gives it no network
and hides the home folder, thimble's folders and where user data lives. Its source arrives in `init`, so it reads no
file of its own either. backend/tests_public/test_term_views.py proves that a program can read no file and open no
socket.

`handle(msg)` is the runtime's half of the protocol, `__driver` the runtime's and the tests' hold on the kit, and
`Drawing` and `Row` the drawing's classes, which a program gets from `draw` and `d.row()` rather than making.

## As text

`thimble view text <slug> --cwd <folder> --width 120 [--height 40] [--keys 'down return'] [--open <ref>] [--ansi]`
draws a view as thimble-term's panel shows it, with no Claude Code, as it opens (keeping nothing): what the view
checks and the reviewer read. `--keys` takes key names, `click:<words>` for a click on the region that shows those
words, `wheel:<n>`, and `text:<words>` for what a field that takes typing holds. `frameText(frame, {ansi})` draws a
frame's rows as text in the kit itself.

```
  / search events  incident  all  Color by  Service  ● payments 79  ● web 45  ● passes 16  ● bookings-db 6  +1
  16 May 01:14 – 19 May 14:25 · 3d 13h
          ▂▂▃▁▁▁▁▂▄█▄▂▃▃▂▂▁                    ▁ ▁▁▂▁▁▁▂ ▂  ▁▁▁ ▁▁  ▁          ▂▄▂▂▁▂ ▁▂  ▂  ▁ ▁ ▁▁
  alert     ▄▂▂   ▄▅▂ ▃  ▃                         ▃        ▂▂                  ▃▃        ▃
  …
  Sat 16 May 2026
❯ ● 01:40:12  chat    message     Oona                 Tonight's release train: web 2.31.0 and payments 4.12.0…
```
