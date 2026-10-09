# Rows, filters, lanes, cards, the side panel and the transcript

Most views share one layout: the top row with the controls that act on the whole view, an overview of the records on a
time axis, the records themselves in a list under it, and the details of the record chosen. The view kit draws each of
these parts, so a page lays them out and fills them rather than drawing its own:

| part | call | what it is |
|---|---|---|
| Filter by | `thimble.filterBy` | in the top row: which rows show, by a field of the view or a label |
| Rows | `thimble.rows` | in the top row: what the lanes or rows are grouped by, a field or a label |
| Color by | `thimble.colorBy` | in the top row: the one color ([color.md](color.md)) |
| the time range | `thimble.timeRange` | over the overview: the time the view shows ([time-range.md](time-range.md)) |
| the lanes | `thimble.lanes` | the overview: a lane per group of Rows on the range's scale |
| the key | `thimble.key` | the series the overview draws beside Color by's, each a toggle |
| the divider | `thimble.divider` | the bar between the overview and the list, which a drag moves |
| the cards | `thimble.recordCard` | a record as a card or a tile, its colors Color by's bars on its edge, one per choice |
| the side panel | `thimble.side` | a record, or a row's children, in a wide panel beside the list |
| the transcript | `thimble.transcript` | a transcript's turns, as the File browser's Transcript mode draws them |

Only Color by draws in colors, and only on the records. Filter by's toggles and the lanes' names are words; a failure
may take the problem red beside the Color by colors, with a shape (✕ or an underline) so that it stays apart from a
value the analyst picked red. Filter by and Rows read a record's value of a field or a label the way Color by does, so a
view's own fields and every label over files work the same way in all three. A judgment that a label already holds
belongs to the label: filter, group or color by the label, and never copy its classes into a field the reader derives
from keywords.

Every choice of each part must draw the view: None for Rows and Filter by, Off for Color by, each field and each
label. The view checks try every choice the page's parts offer, and each part's first choice again after the others,
and fail the view on the one whose drawing gives a script error, naming it ("Rows: None"). Read `rows.by`,
`filter.by` and `colour.by` as what they are with None or Off, null, and draw the records in one group, unfiltered or
uncolored then.

No part scrolls sideways: the kit keeps the page to its pane's width, and the overview under the divider scrolls down
inside the height it has.

thimble keeps each part's state per view, with Color by's choice: Filter by's and Rows' choices, the values turned off,
the series of the key turned off, the lanes folded, the divider's place and the side panel's width. Reset, at the end of
Color by's row, turns every value and series back on and closes the side panel.

## Mount them

```html
<div id="view">
  <div class="top">
    <input class="field" id="q" type="search" placeholder="Search">
    <span id="filter"></span><span id="rows"></span><span id="colour"></span>
  </div>
  <div id="overview">
    <div class="time"><div id="readout"></div><div id="range"></div><div id="key"></div><div id="axis"></div></div>
    <div id="lanes"></div>
  </div>
  <div id="body"><div id="list"></div></div>
</div>
<script>
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }], strip: '#list', onChange: draw })
const filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'outcome', title: 'Outcome', values: ['ok', 'error'] }], onChange: draw })
const range = thimble.timeRange({ mount: '#range', readout: '#readout', times, onChange: draw })
const rows = thimble.rows({
  mount: '#rows',
  fields: [
    { name: 'session', title: 'Session', nameOf: (id) => names[id], parentOf: (id) => parents[id] },   // a tree
    { name: 'tool', title: 'Tool' },
  ],
  onChange: draw,
})
const lanes = thimble.lanes({
  mount: '#lanes', keyMount: '#key', rows, range, names: 200,
  end: (call) => call.t + call.duration,                 // a mark as wide as the call ran
  band: (lane) => [[lane.items[0].t, lane.items.at(-1).t]], // where the session ran
  problem: (call) => call.outcome !== 'ok',              // a failure, underlined in the problem red
  follow: '#list',                                       // the list's rows in view, as a tint
  onPick: (lane) => { session = lane.key; draw() },      // a lane's name: its session's transcript
  onMark: (call) => show(call),                          // a mark: the call in the side panel
})
const side = thimble.side({ mount: '#body' })
thimble.divider({ top: '#overview' })

function draw() {
  thimble.timeAxis('#axis', range.scale(document.getElementById('axis').clientWidth))
  const shown = calls.filter((c) => range.has(c.t) && filter.keeps(c))
  lanes.draw(shown)
  list(shown.filter((c) => !session || c.session === session))
}
</script>
```

## Filter by

`thimble.filterBy({mount, fields, initial, key, onChange})` puts Filter by in the top row, beside Color by. Its menu
lists None, the view's `fields` with their values in words under "Fields" and every label over files under "Labels",
each label with its definition one click away. The chosen field's or label's values are toggles in the row, as Color by's chips are, with a box ticked
while the value shows and no color; the toggles that do not fit go behind "N more". A click turns a value off or on, an
Alt-click or a double click shows that value alone, and hovering a value says what it means. A label chosen while it is
off is turned on, during the analyst's click, so that its values reach the records; Color by keeps its own choice.

`fields` take Color by's form, `{name, title, description, values, meanings, value(record)}`, and `nameOf(value)` for a
value's words where they are not the value.

| member | what it gives |
|---|---|
| `by`, `field`, `label` | the choice: `{field, title}` or `{label, title}`, or null for None |
| `values` | the toggles: `[{value, name, on, n}]`, `value` null for the records with no value |
| `keeps(record)` | whether a record shows: its value is on, every record with None |
| `valueOf(record)`, `isOn(value)` | a record's value, and whether a value is on |
| `query()` | the choice for the reader: `{field, off}`, `{label, name, off}`, or null |
| `counts(map)` | the reader's counts of the choice's values, `''` for no value; without them, the records the page hands `keeps` and `valueOf` are counted |
| `choose(name \| {label} \| null)`, `toggle(value)` | change it from the page |

A reader that filters takes the query with `thimble.colour_on(f, thimble.colour_value(f, ref, r))`. Filter by is the
only part that hides records: Color by only colors.

## Rows

`thimble.rows({mount, fields, initial, key, onChange})` puts Rows in the top row: "Rows: Session". Its menu lists None
(one lane of every record), the `fields` and every label. Rows groups; it never colors, so the lanes can be grouped by
one thing and colored by another (rows by tactic, color by tool). A lane is a group: its name takes no color, only its
records' marks do ([color.md](color.md)).

`initial` is what Rows opens on until the analyst chooses: a field's name, or a list of choices whose first that is
there is taken, each a field's name or `{label: name or id}`, a label counting while it is on. `initial: [{label:
'tactic'}, 'tool']` opens on the label tactic where it is on and on Tool where it is not, and follows the label as it is
turned on and off. Filter by takes `initial` the same way (None by default).

The label Rows groups by takes no color when it is turned on: Color by keeps its own choice, so the lanes are grouped
by the label and colored by Color by's field (a label no part holds takes the color as before).

`groups(items)` gives the groups in order, each `{key, value, name, depth, guide, last, heading, parent, children,
items}`:

- A label's classes, every one it has, so a class added to the label is a new lane with no click, and a different label
  regroups the lanes. The records it does not mark are the last group, "Not marked".
- A field's values: those it declares first, then as the records first take them, then "No <field>" for the records
  with none.
- A field with `parentOf(key)` is a tree: each group under its parent, `guide` its tree guide (`├ `, `└ `, `│ `) and
  `depth` its level. A parent no record takes is a heading. The lanes draw the guides as a file view draws its folders,
  left-aligned on one edge.

`groupOf(record)` is a record's group, `query()` the choice for the reader (`{field}`, `{label, name}`, or null), and
`thimble.colour_value(rows, ref, record)` a record's group there. A label's value reaches the page only on the records
it anchors (the marks of `thimble.markOf`); a record the reader gave its group as `group` keeps it, for a view that does
not anchor every record.

## The lanes

`thimble.lanes(opts)` draws the overview in `mount`: a lane per group of `rows` (or of `groups(items)`), its name in a
column `names` px wide (200 by default) with its tree guide, and its records on the time range's scale as marks in the
Color by colors, gray with Off. Lay the range and its axis out over the lanes with the same names column, so the lanes
stand under them.

| option | what it is |
|---|---|
| `rows`, `range`, `colour` | the Rows control, the time range (its `scale(width)`), and Color by (the page's by default) |
| `time(item)`, `end(item)` | a record's time (`item.t` by default), and its end, for a mark as wide as the record ran |
| `band(lane)` | the spans the lane ran, `[[start, end]]`, drawn as a light band (the key's "running") |
| `problem(item)` | whether a record failed: its mark is underlined in the problem red (the key's "failed") |
| `words` | the key's words: `{band, problem}` |
| `keyMount` | where the key goes; at the lanes' top by default |
| `follow` | the detail list, whose rows carry `data-t`: the rows in view are a light tint across the lanes |
| `density` | a flag, or a function the page answers at each draw: each lane as bars on the scale's bins in place of marks (an Events \| Density choice) |
| `anchor(lane)` | a lane's `data-anchor`, such as a session's unit |
| `onPick(lane)`, `onMark(item)` | a lane's name clicked, which marks it chosen; a mark clicked |
| `tip(item)` | the words of a record in the hover tip |

Hovering a lane draws a thin cursor line across every lane and a tip of the lane, the time and the record there; never
a band over the marks. With `density` each lane is a bar per bin, its height the bin's records on one scale for every
lane, stacked by their Color by values in the chips' order (the records with no value last, in gray); hovering a bin
gives its time and its records per value, and a click opens its first record (`onMark`). A parent's `▾` folds the lanes under it into its own. The tint of the list's rows in view moves
as the list scrolls; where the time range marks a span on its own overview (`range.visible`), the lanes mark it there
too.

| member | what it gives |
|---|---|
| `draw(items)` | the lanes drawn with these records, those of the range the page shows |
| `lanes`, `chosen`, `choose(key)` | the lanes as drawn, and the chosen one |
| `visible(t0, t1)`, `visible(null)` | the span the list shows, for a list `follow` cannot read |
| `isOn(series)` | whether `band` or `problem` shows |
| `scale` | the scale the lanes drew on |

## The key

`thimble.key(mount, entries, {key, onChange})` draws a key whose entries are toggles: `[{id, name, mark, colour, n,
count}]`, `mark` drawn as the series is drawn (`band`, `mark`, `problem`, `line`). A click hides or shows the series;
an entry with `n` 0 is left out, so a key never names a series the view does not draw. `isOn(id)` says whether a series
shows and `set(entries)` draws new ones. The lanes draw their own key with it.

## The divider

`thimble.divider({top, key, min})` puts a bar under `top`, the overview's box, which a drag moves: the overview takes
the height it leaves and scrolls down inside it, never sideways, and the list under it takes the rest. ↑ and ↓ move it while it has the
focus, a double click or Home puts it back. thimble keeps its place per view as a share of the height the two share.

## The cards

A record drawn as a card or a tile, such as a pull request on a board's column or a tile in a grid, is the kit's card,
`.thimble-card`: a hairline box on the paper with a chip's corners (`var(--radius-chip)`). A card takes no color of its
own. Color by draws its value's color as the bar on the card's left edge, as on a row, and the card's left corners go
square under the bar, so the bar stays straight. With several Color by choices each is a straight bar of its own, side
by side from the edge in the order of the choices and as wide and as far apart as on a row, empty where the record has
no value of that choice or its value's color is turned off; the card's left padding holds them and widens when more
come than it holds, so its text never sits under a bar. Draw no side stripe, colored edge or corners of the page's own
on it: the view checks note a rule that changes its edges, fills, corners, colors or type (views.own_parts).
`thimble.recordCard` gives a card's html, and a page that builds its own markup uses the same classes:

```js
col.innerHTML = '<div class="thimble-cards">' + prs.map((pr) => thimble.recordCard({
  ref: pr.ref,                     // its data-anchor
  record: pr,                      // Color by reads its value: the bar on the card's edge
  key: '#' + pr.number,            // the head's left, in mono
  chips: [pr.claimedBy],           // the head's right, neutral chips; or meta: text or {html}
  title: pr.title,                 // two lines at most
  body: pr.summary,                // three lines at most, the secondary text
  foot: { html: dots(pr.reviews) },
  active: pr.ref === open,         // the chosen card
})).join('') + '</div>'
```

```html
<div class="thimble-card thimble-card-act" data-anchor="forge.db#prs/66599" data-colour="agent-08">
  <div class="thimble-card-head"><span class="thimble-card-key">#66599</span>
    <span class="thimble-card-meta"><span class="chip chip-sans chip-tone-neutral"><span class="chip-text">agent-08</span></span></span></div>
  <div class="thimble-card-title">DOC: fix url in concat docs to copy-on-write</div>
  <div class="thimble-card-foot">13 reviews</div>
</div>
```

Each part is text, which `recordCard` escapes, or `{html}`. `act: false` gives a card a click does nothing on, and
`attrs` (`{name: value}`) more attributes, such as a key the page's click reads or a `class` of the page's, which joins
the card's own. `.thimble-cards` stacks cards in a column with a gap between them, and `.thimble-cards-grid` lays them
out as tiles at least `--thimble-tile-w` (220 px) wide. A list of records with no box is the kit's `.list-row` or
`.table`.

## The side panel

`thimble.side({mount, width, min, key, onClose})` gives the list a side panel: `mount` holds the list, and the panel
opens at its right, the list narrowing beside it. A record and a row's children open there, never under the row, so the
list keeps its place.

```js
const side = thimble.side({ mount: '#body', onClose: () => { open = null; list() } })
listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row')
  if (!row) return
  open = row.dataset.anchor
  side.open({ title: 'Read · explorer', sub: 'r1/explorer.jsonl line 12', ref: open, render: (body) => details(body, open) })
  list()   // mark the open row
})
```

The panel opens `width` of the mount (0.4), never narrower than `min` px (280). A drag of its left edge resizes it, a
double click on the edge puts it back, and thimble keeps its width per view. Escape in the panel or its × closes it.
`isOpen`, `ref`, `body` and `width` read it; `open({title, sub, ref, html | render(body)})` and `close()` change it.

## The transcript

`thimble.transcript({mount, colour, onOpen, fold})` draws a transcript's turns as the File browser's Transcript mode
draws them: a card per turn, its number in a column at the left (a click opens its lines in the File browser), its
speaker, tool and time in a mono head, its words under it; a tool call and what came back, and a system record, folded
to one line until opened; a block longer than six lines folded with Expand; a thought quiet; an error in the problem
red, a failed tool call's head with `✕` before its tool (`error` true, or the failure's word, which its hover gives); a
line between sessions. Each turn is anchored with its ref and carries `data-t`, so a label marks it, a ⌘-click
asks about it, Color by draws its bar and the lanes follow it.

```js
const tr = thimble.transcript({ mount: '#list', colour, onOpen: async (turn) => tr.set(turn.ref, await thimble.fetch({ op: 'turn', ref: turn.ref })) })
tr.draw(turns.filter((t) => t.session === session), { title: `${names[session]} · ${runName}` })
```

A turn is `{ref, t, speaker, kind, tool, text, input, output, error, session, sessionName, line}`, `kind` one of
`text`, `prompt`, `tool`, `thinking` and `system`. `draw(turns, {title, sub, empty})` draws them, with a header that
names what the list shows (the run, the session or the selection) and how many turns; `reveal(ref)` opens a cited turn
and scrolls it to the middle, its highlight fading as Files' does; `open(ref, on)` folds or opens one; `set(ref, patch)`
gives a turn its words once the reader sent them whole.

## What the list says it shows

A list under the overview names what it shows and how many: the run, the session or the selection the analyst chose,
as the transcript's header does. Choosing a lane shows that lane's records, such as a session's transcript, and the
header names it.
