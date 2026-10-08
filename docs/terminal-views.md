# Views in the terminal

In terminal mode a view is drawn in thimble-term's panel by its own program, `view.term.js`, beside the view's
`reader.py`, as `view.html` draws it in the browser. The program imports thimble's terminal view kit, which gives it
the parts every view shares, drawn in terminal mode's look (mods/thimble-term/SPEC.md): Color by with its chips,
Filter by and Rows, the time range, lanes on the range's scale with their key, a list with a chosen row, a side pane for
its details, the divider between the overview and the list, a transcript, a record's place one click away and asking
about a row as a side thread. They mirror the browser's parts ([color.md](color.md), [time-range.md](time-range.md),
[rows-and-filters.md](rows-and-filters.md)). The rest of the view is the program's own: what it draws, in which rows,
and what its keys and clicks do.

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
it as text (below). [plugin/viewers/linked-sessions/view.term.js](../plugin/viewers/linked-sessions/view.term.js) draws
runs of agent teams on one clock: the time range broken where the runs lie hours apart (`gap`), a lane per session
under its run as a tree, a run folded to one lane where the panel is short, and each call opened in the side pane with what came
back (`blocks`).

[plugin/viewers/repository/view.term.js](../plugin/viewers/repository/view.term.js), the third, draws records from a
code forge the way its own tools draw them: one run's repository at a time, chosen in a switcher on the first row
(`choice` with `all: false`, which lists each run with its tabs' counts); the tabs with their counts on a row of their
own, the chosen one inverse; the run's items with a dim line under each row (`body`); under a label, which marks
records, no mark on a row, which stands for its records, but a small bar of their mix, and a plain track; and an item's
page in the side pane (`side`), whose records are a `list` of their own, which ↑↓ move through once a click, the wheel
or `l` gives it the keys, the one a citation opened chosen.

## The program's life

The program runs sandboxed, one process per open view, alive while the view shows and ended when the panel shows
something else. It reads no file and opens no socket: what it knows arrives as events, and what it draws leaves as
frames.

- `draw(fn)` registers the function that draws the view: `fn(d)` gets a Drawing as wide as the panel's type area and as
  tall as its rows under the header. The kit calls it again after every event, every answer and every change a part of
  the kit makes, so the program keeps its state in variables and draws from them; `redraw()` asks for it too, and one
  asked while the view draws draws it again before the frame goes. A key is answered by one drawing, so a drawing
  costs what the rows it shows cost: the kit's list draws only its rows in view, and work that walks every record
  (grouping, counting, building rows) belongs where the records or a control change (`load`, `onChange`), or is one
  pass in `draw` that touches each record once.
- `fetch(query, {key})` asks the view's `reader.records(index, query)`, as `thimble.fetch` does in the browser, and
  resolves with its answer; a newer fetch with the same `key` drops the older one, which rejects with an `AbortError`.
- `onOpen(fn)` hears each place a citation opens the view at, `{ref, target, key, label, excerpt}` as the reader's
  `resolve()` answered it (the place the view opened at, too).
- `onLabels(fn)` hears the workspace's labels or the label filter change; fetch again there, as the reader keeps only
  what the filter keeps. `labels()` lists every label over files.
- `keep(key, value)` and `kept(key)` keep a value for the view across openings. Color by keeps its choice and the
  values turned off, the time range keeps a range zoomed in.
- `size()`, `theme()` and `view()` give the panel's size, `dark` or `light`, and `{slug, name}`.
- `loading()` says whether the view loads: a reader query has been out 150 ms or more, or the first one is out before
  any came back (the kit's own queries apart). The panel says `◌ starting the view…` from the moment the view opens until
  its first frame, and `◌ loading…` dim against R on the title's row while `loading()` holds; a program may draw it too,
  such as in place of a list with nothing in it yet.
- An error the program throws is drawn as red rows that say what failed and where in view.term.js.

## The drawing

A Drawing (`d`) holds rows of styled runs on a grid `d.cols` wide, at most `d.rows` tall (`d.left` rows are left), each
with a 2-cell margin left of the type area for `❯`. Lines past the rows or the columns are cut, a row whose words pass
the edge with `…` in its last cell (`fitLine`), never bare. The docked panel is about 47 cells wide at a 120-column
terminal and 92 at 200: draw a view at 47, 92 and 140 (`thimble view text --width`) and drop or move columns as the
width asks, as the worked examples do.

| member | what it does |
|---|---|
| `d.row()` | a Row built left to right; `.end()` draws it |
| `d.line(runs, hits?, margin?)` | a row of runs (a string, a run or a list), with its hot regions |
| `d.blank()` | a blank row, never two in a row and none at the top |
| `d.rule()` | a rule across the type area (a panel has two at most, the header's among them) |
| `d.key(keys, words, run)` | bind keys for this frame, with the words that name them (in the hint row or `?`'s list) |
| `d.sub(...facts)` | facts for the panel's subtitle under the view's name, dim, parted by ` · ` |
| `d.typing({text, onText, onKey, hints})` | a part takes typing: the panel's field holds `text` and sends each change to `onText` |
| `d.inner(indent)`, `d.put(inner)` | a drawing `indent` cells in, put in at the current row (a row's details at A2) |
| `d.focus()` | keep the next row in view: in a row's details, the record a citation opened, which the list shows however far down it is |
| `r.add(text, style, {on, tip, drag, row, max, cursor, tips})` | text in a style; `on(x)` makes it a control, `tip` the words the pointer shows under it; `cursor` marks a chart's cells, `tips[i]` the words of cell i |
| `r.gap(n)`, `r.at(col)`, `r.right(text, style)` | space, a column, text against R |
| `r.margin(run)` | the mark in the margin: `❯` and the accent on the chosen row |
| `r.runsOf(runs)` | runs as they are, such as a `strip` |

A run is `{s, fg, bg, b, d, i, u, inv}`: `fg` and `bg` a theme key of `COLORS` or a hue of `SERIES`, `b` bold, `d`
dim, `i` italic, `u` underlined, `inv` inverse. `dim`, `bold`, `link`, `accent`, `problem`, `chosen` and `mark(hue)`
make one. Each style keeps the one meaning SPEC.md gives it: bold for titles and headings, dim for what is secondary,
blue and underlined for a link (`↗` and the place after it), the accent and `❯` for the chosen row, the selection
background for a choice in use (the time range's window), red only for a problem, `added` and `removed` (Claude Code's
own diff green and red) only for the lines a diff added and removed and their marks, and a palette hue only on the marks
of the Color by choice. A record's own words are drawn upright, as a file is. A record's text can hold control
characters (an escape sequence, a bell, a NUL, the C1 characters of text decoded twice). The kit removes them from each
run, tip, hint, fact and error of a frame (`printable`: a tab is two spaces, a line break in a run is a space) and counts
them as no cells, so the columns after them stay in place.

A control under the pointer is drawn inverse. A chart's cells never are, which would turn the chart into a band: a hit
with `cursor`, and any hit over four or more cells that hold only a chart's glyphs (bars, lines, `×`, a break), marks
only the pointer's column, `┊` in an empty cell and a bar in the text color, on every chart hit over the same columns
(the lanes and the range's strip), with that cell's tip.

`width`, `charWidth`, `cut`, `clip`, `prefix`, `oneLine`, `pad`, `padStart`, `wrap`, `num`, `plural`, `when`, `hms`,
`dayOf`, `dayName`, `dur`, `placeWords` and `placeIn` measure, cut and write text the way thimble-term does: a cut at a
word with `…` against it, counts with thousands separators, a place as `agents.log line 12` (in `n` cells, without its
folders and then its file's name cut in the middle, its line kept). `seg`, `italic`, `merged`, `lineWidth`, `fitLine`
and `clipLine` make and measure runs and lines; `HUES` is how many values of a field take a hue (six).

## Keys

A view's pane passes on ↑↓, Enter, Space and Backspace (`up`, `down`, `return`, `space`, `backspace`) and a lowercase
letter, a digit or a sign typed. ←, →, the page keys, Home, End, Tab and Esc reach no element of a pane, so `d.key`
refuses them, and `b`, `t` and `x` are the panel's own (back, the threads, close). The kit's parts bind `c` (Color by),
`f` (Filter by), `g` (Rows), `r` (Reset), `a` (ask), `/` (search), a choice's own letter, and `<` `>` and Backspace (the
side pane) while they are drawn. The time range and the divider bind no key: the mouse moves the range.

A view that draws two lists or more (the pages, and a page's revisions in the side pane or under them) gives ↑↓, Enter
and `a` to one of them: the one the analyst last clicked (a row, the track, its details) or turned the wheel over, or
the one the program last chose a row of (`choose`, `show`: a citation opened it), else the main list, the first the
frame draws. When that list is not drawn any more (its pane closed), the main list has the keys again. `l` gives them
to the next list the frame draws; `?` names it and the hint row does not, and a view that binds `l` itself keeps it.

The hint row is one row: the moves the screen cannot show, `↑↓ to choose · Enter to open` (and an open menu's Space),
the first two keys the view binds of its own (`n p for the next lane`), `? for all keys`, then `b to go back · x to
close`. The top row shows Color by, Filter by, Rows and the search as controls a click opens, so the row leaves their
keys to `?`, which opens a list of every key the frame binds with its words, in a frame over the view's top rows; `?`
again, any other key or a click closes it. Where the row has no room for every hint it keeps whole hints, the most
needed first: ↑↓, Enter, `b`, `?`, `x`, then the view's own. Nothing else in the view says which key does what. A key
works only while its part is drawn, since a part binds its keys as it draws, and every key bound works whether or not
the hint row names it. A view that binds `?` itself keeps it, and the kit then binds none.

## Color by

`colorBy(opts)` is the one control for the view's color, as in the browser ([color.md](color.md)). Draw it in the top row
with `colour.draw(d, before)` (`before(r)` adds the row's other controls first) or `colour.add(r)`.

- The view opens colored by a label that is on in Files and marks its files (not one Rows groups by), as the browser's
  view does, else by its `initial` field; a label turned on while the view is away or open takes the color, the one turned on last.
- The row reads `Color by  Kind` and the chosen field's values as chips: `●` in the value's hue, its name, its count
  dim. A click on a chip turns the value off (`○`, dim) or on. Values past the sixth share one chip, `other`, with no
  hue of their own, and draw dim wherever they show; the records with no value have `no kind`, with a dim mark. A value
  with no records in the reader's counts has no chip, `other` too, unless it is turned off. A label's chips are the
  values it colors by (a regex label's `other` is not one), each with its count, then `not marked`.
- Where the top row has no room for Color by's name whole and its first chip after the row's other controls, Color by
  takes the row under them (Reset stays at R on the top row); where its own row has no room for a chip beside the name,
  the chips take the row under that, at A2, as many as fit and `+N` for the rest. The name is cut only where it alone
  has no room, and then `Color by` reads `Color`.
- `c`, or a click on the choice, opens the menu in a frame over the rows under the row, which keep their places: Off,
  the fields, then every label over files with its kind. The chosen field's or label's values stand after its name
  with their dots, in their hues; the others' in words, dim: a field's declared values, else those the records the list
  drew take (the kit counts them, `tally(record)`), the commonest first, else those it gives meanings for; a label's,
  then `not marked`. Under the chosen row, what it is, once: a field's description, a label's kind and definition with
  `definition ↗`, which opens the label's panel. In a narrow frame the chosen row's values and what it is stand under
  its name. Each row starts with `●` (in the accent) while it is a choice and `○` while it is not. Space checks or
  unchecks the row under `❯` and the menu stays open, so several are chosen together: the first is the color, each
  other a column of its own beside the list's track (`tracks`), and says `track`; the top row reads `Kind +1`. Enter
  colors by the row alone; Off unchecks them all. With Off, no mark and no track cell takes a hue.
- Checking a label, with Space or Enter, turns it on in Files and every view, as the browser's Color by does: the
  view host makes the change show_label makes, and the label keeps the place it was checked in. Unchecking it with
  Space turns it off, unless Filter by or Rows reads it. A choice the page makes itself (`choose`) turns no label on.
- `+N` after the chips opens the values it stands for in the same frame, each with its dot in its hue, its count and,
  under the one at `❯`, what it means; Space or Enter turns it off or on, as a chip's click does.
- A group's row (a page, an agent, a session) takes no color of its own: `colour.mix(counts, cells)` gives the runs of
  a small bar of its records' share of each value in its hue, which the row adds; none with Off.
- With a label chosen, its name in the top row is followed by `↗`, which opens the label's panel: its definition, its
  runs and its records are a step away in every view that uses it.
- A chip's tip says what its value means: the field's `meanings`, a declared value's `meaning`, a label's value.
- Reset, against R, shows after any change from how the view opens: Color by's choice, a value off, a range zoomed, a
  search or a choice set, or what the page's `onReset({changed})` says, and puts them back (`r`). `changed()` and
  `reset()` do the same from the program.

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
| `tally(record)` | count a record's values of every field for the menu (a list hands over its records, which the menu counts when it opens) |
| `by`, `field`, `label`, `off`, `values` | the choice and its chips |
| `choose(field \| {label} \| null)`, `toggle(value)` | change it from the page |

A query names the label colored by, so the reader's `thimble.colour_value` reads it even while it is not on in Files.

## Time

`timeRange(opts)` is the one control for a view's time, as in the browser ([time-range.md](time-range.md)).

- `range.draw(d, {gutter})` draws its readout (`16 May 04:31 – 05:10 · 39m`) and its overview strip: a cell per bin of
  the whole span, each the bar of its records (`▁` to `█`) in the Color by hue most of them take. Zoomed in, the window
  is on the selection background between its edges `[` `]`, the cells a drag moves them from, and the rest dim. It
  opens on the whole span. A chart over the range leaves out a lane with nothing in a range zoomed in. Under the
  pointer the strip marks its cell, with the cell's time and records in the tip.
- A click on the strip moves the window there; a drag frames a new range, a drag from inside the window moves it, a drag
  from its edge moves that edge; Reset gives back the whole span. It binds no key.
- `range.data({times, values, span, marks, gap})` gives it the records' times, their Color by values and the incidents or
  other point events; `range.has(t)`, `from`, `to`, `full`, `set(a, b)`, `set(null)`, `fit()` read and set it.
- `gap` (an option of `timeRange` or of `data`): an empty stretch longer than it, in the units, is a break of 4 cells,
  ` // `, on the strip and on the range's scale, so bursts hours apart (runs, sessions, shifts) share one axis and each
  keeps its share of the cells. An edge of the range never stays in a break.
- `range.scale(cols)` lays the range across a chart's cells: `x(t)`, `t(x)`, `binOf(t)`, `step`, `ticks(gap)`, and
  `broken` and `gaps()` (each break's first cell and the cell after it), with the breaks that fall inside the range.
- `axis(d, scale, {gutter, legend, marks, onMark})` draws the chart's axis under it, `//` at each break with the date on
  the first label after it, `legend` in the gutter before the ticks as the key of the marks the chart draws other than
  Color by's (`─ running  × failed`), and the marks' labels on a row of their own. `legend` is runs, or entries
  `{glyph, fg, name, on, toggle}`, each a control that hides or shows its series, dim while it is off, as `lanes`
  gives them (`legend()`); entries that do not all fit the gutter stand on a row of their own over the axis.
- `strip(scale, items, {value, colour, max, guide})` is one row of a chart over time (a lane), `maxBin(scale,
  groups)` the height every lane shares, and `bar(n, max)` one cell's bar.

## Filter by and Rows

`filterBy(opts)` is Filter by: which rows show, by a field of the view or a label. `filter.add(r, {max})` adds
`Filter by  Outcome` to a row and the chosen one's values as toggles, `●` while a value shows and `○` (dim) while it is
off, never in a hue (only Color by colors), each with its count, `+N` for those past `max` cells; a click on one turns
it off or on, its tip says what it means. `f`, or a click on the choice, opens the menu: none, the fields with their
values in words, then every label with its definition a step away. `filter.keeps(record)` says whether a record shows,
`query()` gives the reader the choice in Color by's form (`{field, off}` or `{label, name, off}`), `counts(map)` takes
the reader's counts, and `valueOf`, `isOn`, `values`, `by`, `choose` and `toggle` read and change it. Reset turns every
value back on.

`rows(opts)` is Rows: what the lanes are grouped by, a field or a label. `rows.add(r)` adds `Rows  Session`; `g`, or a
click, opens its menu. `rows.groups(items)` gives the groups in order, each `{key, value, name, depth, guide, last,
heading, parent, children, items}`: a label's classes (each one, so a class added to the label is a new lane), else the
field's values, then `no <field>` or `not marked` for the records with none. A field with `parentOf(key)` is a tree:
each group under its parent, `guide` its tree guide (`├ ` `└ ` `│ `), a parent no record takes a heading. `groupOf`,
`query()` (`{field}` or `{label, name}`), `by` and `choose` read and change it; a record the reader gave its group as
`group` keeps it.

`initial` is what either opens on until the analyst chooses: a field's name, or a list whose first choice that is
there is taken, each a field's name or `{label: name or id}`, a label counting while it is on in Files (`[{label:
'tactic'}, 'tool']`). The label Rows groups by takes no color: Color by neither opens on it nor takes it when it is turned
on, so the lanes keep Color by's own choice. A label chosen in either while it is off is turned on in Files and every
view during the analyst's key or click, as in the browser, and Color by keeps its own choice when it comes on.

Both take `fields` as Color by does, `{name, title, description, values, meanings, value(record)}`, with `nameOf(key)`
for a value's words, and a query names the labels they read, so the reader reads them though they are not on in Files.
A label's value comes from `labelValue(id, record)`, which Color by reads too.

## Lanes

`lanes(opts)` draws the overview as lanes on the time range's scale: `ln.draw(d, {items, scale, gutter, room, span})`
draws a lane per group of `rows`, its name in the gutter at the left, left-aligned with its tree guide in the rule gray,
a top group's `▾` `▸` at A0 folding the lanes under it into its own, and in each lane's cells its records' bars in the
Color by hues on one height, `─` in the rule gray where it ran (`band(lane)`), `─` in a record's hue while that record
ran (`end(item)`), and `×` in red where most of a cell's records failed (`problem(item)`). Where the lanes pass their
`room`, the top groups fold by themselves, the largest first, and then the rest wait behind `… N more`.

- A lane's cells are a chart's: under the pointer only its cell is marked, with the lane, the cell's time and its
  records in the tip; a click opens the record nearest there (`onMark(item)`), and a click on a name chooses the lane,
  in the accent (`onPick(lane)`), such as to show that session's transcript.
- `span`, `[t0, t1]` or a list (its `span()`), is the list's rows in view, on the selection background across the lanes.
- `density: false` draws Events: a mark `▌` in the hue of each cell that holds a record, in place of its bars.
- `ln.legend()` is the key for `axis`: an entry for each series the lanes drew (`─ running`, `× failed`), each a toggle.

## The list

`list({key})` is a list of records with a chosen row; `rows.draw(d, opts)` draws it in the rows left.

- `❯` and the accent mark the chosen row, across its whole width, its dim columns too (a run in a color of its own, such
  as a value's hue, keeps it); ↑↓ choose and the chosen row stays in view; a heading item
  (`{heading: 'Sat 16 May 2026'}`) is a bold row no key chooses.
- Enter, or a click on the row, opens its details in place under it, at A2 (`detail(item, dd)`), and closes them;
  `onOpen(item)` hears it, to fetch what they show. `a` asks a side thread about the chosen row (`ask(item)`).
- Each row starts with its mark in its Color by hue, then a mark for each choice past the first (`●` in the hue of the
  row's value of that choice, a space where it has none), as the browser's bands on a row's edge. A list taller than its rows has the colored track at its right
  edge: each cell the commonest hue of the rows it stands for, the part in view on the selection background; one many
  times taller adds the zoomed track beside it. A click on the track goes there; the wheel over the list moves its
  rows, and the rows of no other list (over a side pane's rows, those of the list the pane draws).
- A list draws only its rows in view (and the chosen one): a list of 15,000 rows answers a key as one of 40 does. The
  rows an item's `body` takes are counted as it last drew them at that width, so `body` draws from the item and its
  `{chosen, open}` alone. Drawn as text (`thimble view text`, the view checks) a list draws every row, so a row too
  wide anywhere in it is found.
- `columns(specs, cols)` lays out columns with 2-cell gutters (`{w}`, `{align: 'right'}`, `{grow: true}`):
  `cells(r, values, styles)` adds a row's values, and `header(r, names, {sorted, desc, onSort})` the names, dim, `▼`
  after the one sorted by, each a click that sorts; a list's `header(r)` stands above its rows and does not scroll.
- `details(dd, {text, blocks, facts, groups, raw, place, ask})` draws a record's details across the panel's width: its
  words, its blocks, its facts (on the rows they need, none split), the records it links to, its lines as the file
  holds them (`raw`, for a record whose facts do not say what its line holds: `↗` opens the line too), `↗` and its
  place, which keeps its line where it is cut, and `ask about it`, on the row under the place where both do not fit.
  A block (`{text, code, max}`) is text as the record holds it, such as a command and what it printed, or a diff: each
  line upright and cut at the cell edge, at most `max` rows (8) and then `… N more`, which a click opens; `code` draws
  it in the code color (a command, a query, a path).
- `title` and `count` name what the list shows over it, bold and dim: the run, the session or the selection, and how
  many (`explorer · Run 2  214 turns`).
- `body(item, dd)` draws lines every item has under its row, at `bodyIndent` cells (a turn's words); `mark: false`
  leaves out the row's leading Color by mark while its track keeps the hues. A heading with `dim` is a dim row.
- With `side` (a side pane), Enter or a click opens the row's details in the pane, never under the row.
- `rows.span(time)` gives the first and last times of the rows in view, which a lanes part marks on the overview. Read
  above the list, before it draws, it gives the rows the list will show after the key or the wheel being answered; where
  the list then shows others (its items changed), the view draws again, so the overview follows.
- `onWheel(fn)` hears the wheel over the view, `fn(by, at)` with `at` the cell under the pointer (`{x, y}` from A0 and
  the view's first row, null when the panel did not say), for a part of the program's own that scrolls.

## The side pane

`side(opts)` is a pane for a record or a row's children: `list.draw(d, {side, detail, sideTitle})` opens its rows
there. Where the panel holds both, the pane stands beside the list, `width` of the panel (0.42), a `│` in the rule gray
between them; in a narrower panel it stands under the list, a rule between them. Its first row names the record, bold,
with `close` against R. `<` `>` narrow and widen it (thimble keeps its width per view), Backspace or `close` closes it,
and Reset closes it too. `isOpen`, `key`, `show(key)` and `hide()` read and change it; `side.draw(d, left, right,
{title})` lays out any two parts the same way.

## The divider

`divider(opts)` is the divider between the overview and the list: `div.rows(d, fallback)` gives the overview's rows of
the rows left, `fallback` with at least `min` rows (3) on each side. The browser's divider is a bar a drag moves; the
panel has no drag across its rows, so here the overview has the rows the view gives it. Give the lanes those rows
(`room`).

## The transcript

`transcript(opts)` draws a transcript's turns as thimble-term's file view draws a transcript: `tr.draw(d, {turns, title,
count, colour, side, onOpen})`. Each turn has its clock dim in a column, `●` (in its Color by hue, with `colour`, and a mark
for each choice past the first) and the speaker bold, and its words under the name, up to three rows; a tool call is one dim row, `⎿ Bash pytest -q`, a
failed one (`error`) with `× Bash` in red as the lanes draw it; the day stands on a dim row of its own where it changes.
It is a list: ↑↓ choose a turn, Enter opens it in place, or in the side pane with `side` (a turn's words whole; a tool
call's input in the code color and what came back, in red for an error), `a` asks about it, and its track shows where
the Color by values are. A turn is `{ref, t, speaker, kind, tool, text, input, output, error}`, `kind` one of `text`,
`prompt`, `tool`, `thinking` and `system`; `title` names what it shows, with the count of its turns. `tr.list` is the
list under it, for `span` and `choose`.

## Search and choices

`search({words, onChange})` adds `/ search` to a row: `/` or a click starts typing, and the panel's field then holds
its text, each change of which reaches the search whole (Enter ends). A part of the program's own takes typing with
`d.typing({text, onText, onKey})`. `choice({title, all, key, values, onChange})` adds `incident  all` to a row, whose menu
picks one of its values. A value is a string or `{name, value, right, indent}`: `right` stands dim against R in the menu,
and `indent` stands its menu row in by 2 cells a level, for a tree such as runs and their sessions; the row shows the
chosen value's name alone. With `all: false` its menu holds the values alone (`items  pull requests`, the kind of record
a view lists): it opens on `initial`, else the first value, and Reset puts it back there.

## Acts

`open(ref)` opens a record's place in thimble-term's citation panel, `ask(ref, text)` asks a side thread about it, and
`openLabel(id)` opens a label's panel. Each works only during the analyst's own key or click in the view, as the
browser's label calls do: thimble takes an act only with the frame that answers that event. The kit's parts make one
more act themselves, `show`, when the analyst checks a label in Color by or chooses one in Filter by or Rows: the view
host turns the label on or off in Files and every view, as show_label does, and sends the program the labels again.

## The protocol and the sandbox

thimble's view host (`thimble view host`, backend/app/term_views.py) runs each open view's program and answers its
queries; thimble-term starts it the first time a view opens and talks to it over a Unix socket in a private folder.

| from thimble to the program | |
|---|---|
| `init {source, cols, rows, theme, view, state, labels, open}` | the program's source and what it opens on |
| `resize {cols, rows}`, `key {key}`, `text {value}`, `click {i, seq, x}`, `drag {i, seq, x0, x1}`, `wheel {by, seq, x, y}` | the panel's events, each with its number `n`; `text` the whole text of the field that takes typing; `wheel`'s `x` `y` the frame's cell under the pointer (its margin's two cells counted, as a hot region's), which a wheel from no pointer leaves out |
| `answer {id, data \| error}` | a query's answer; one longer than 16 MB comes as an error that says to answer in pages |
| `sync {id}` | asks whether the program is idle (`draw_text`, the view checks) |
| `labels {labels, filter}`, `open {place}` | the labels changed; a citation opened the view at a place |
| `choices {id}`, `choose {control, choice}` | the view checks ask for every choice of the kit's parts the program drew, then make each in turn, as the analyst's key makes it, with its number `n` |

| from the program to thimble | |
|---|---|
| `frame {seq, ack, lines, hits, hints, hintKeys, keys, typing, field, sub, overflow?, loading?}` | what to draw: rows of runs, hot regions (`cursor` on a chart's, with `tips` per cell), every key bound (`keys`) and the hints the hint row may name (`hints`, each one's keys in `hintKeys`), which the panel fits to one row with its own `b` and `x`, the text of a field that takes typing; `ack` the last event it answers; `overflow` `{rows, cols, first}` when the kit cut rows past the rows or wider than the columns; `loading` while a reader query is out (`loading()`) |
| `query {id, q, labels}`, `cancel {id}` | a reader query, and one dropped |
| `act {n, act}` | a place, a thread or a label's panel, made during event `n`; or a label turned on or off (`show {id, on}`), which the host makes |
| `choices {id, choices}` | the answer to `choices`: `[[control, choice]]`, Color by's first, then the other parts' in the order the program made them |
| `state {state}`, `error {message}`, `log {text}` | what the view keeps, an error, a line it printed |
| `synced {id, due, every}` | the answer to a sync, once everything sent before it is handled and the frames it drew are out: the ms until the next timer it waits on and its shortest interval's period (null for none) |

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
checks and the reviewer read. It takes each frame once the program is idle: no reader query out, the program's answer
to a sync in, nothing drawn meanwhile, no timer due within half a second and no ticker of 250 ms or less drawing; so a
view still decoding its answer is drawn once it is done, never as it loads. `--keys` takes key names, `click:<words>`
for a click on the region that shows those words, `drag:<x0>-<x1>` for a drag across those cells of the time range's
strip, `wheel:<n>` (the list that has the keys) and `wheel:<n>@<words>` (the wheel over the first row that shows those
words), and `text:<words>` for what a field that takes typing holds. `frameText(frame, {ansi})` draws a
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

A view built in terminal mode passes its checks only when its draft draws this way with no error, within the time limit
and with nothing cut, at 120 and 200 columns in light and dark and opened at the first place that resolves
(views.term_draws), and, with the checks' test label on, when every choice of the Color by, Filter by and Rows it draws
draws with no error: Off, None, each field and each label, two fields together, then each part's first choice again
after the others, as the browser's checks try a page's (term_views.Program.sweep). The checks name each choice that
fails, such as `Rows: None`. Its reviewer reads the same drawings in place of pictures.
