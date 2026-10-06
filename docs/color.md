# Color in a view

Every view page has thimble's Color by control, `thimble.colorBy`, in its view kit (`thimble.colourBy` is the same
function). The page mounts it in its top row and draws its records with the color it chooses. Use it in place of a
color control of your own, so that every view colors the same way. Color is one encoding at a time: only the Color by
choice is drawn in colors, on the chips, the records' bars, the tracks and the chart marks. Show any other category of
the view as text, a glyph or a gray pattern, never in a second palette.

- One menu lists Off, the fields the view can color by and every label over files. Fields are values the files hold or
  the reader works out, such as a kind or a source. The labels that mark the view's files come first, each with its
  switch and an info button that shows the label's definition in place: what it asks or matches, its values with what
  each means, the files it covers and how many records it has read, and Open label, which opens it in thimble's label
  panel.
- Color by is thimble's small secondary button, with the choice in it: "Color by: Kind". While a label is the choice, an
  info button beside it opens the label's definition.
- Off colors nothing: no chips, no bars, and the tracks and the time range's overview draw every record in gray.
- The values of the chosen field show as key chips in the top row (`chip chip-key` in the view kit): a square of the
  value's color, its name and its count. A click turns a value off or on. An Alt-click, or a double click, shows that
  value alone. A value turned off is hidden or dimmed, as the view says, and its chip goes quiet with an empty square.
  Hovering a label's value shows what the label says the value means.
- On a record, color is a 3 px bar on the left edge of its row or card. Text and fills keep their own colors.
- A long list gets two tracks in place of its scrollbar, as a music or video editor lays out its navigator (below).
- Reset, at the end of the row, shows while the view is not as it opens and puts it back (below).
- thimble keeps the choice, the values turned off, each value's color and the time ranges per view. The page opens on
  them again.

[plugin/viewers/timeline](../plugin/viewers/timeline), one of the worked examples the dev agent reads, uses it: a
ferry operator's alerts, deploys, chat and tickets on one time axis, colored by a source or a label, with the time
range selector ([time-range.md](time-range.md)) above its lanes. `thimble demo --examples` opens it, and the other
worked examples, each on its sample with its sample labels, on the server of your stack.

## Mount it

```html
<div class="top">
  <input class="field" id="q" type="search" placeholder="Search messages">
  <span id="colour"></span>
</div>
<div id="list"></div>
<script>
const colour = thimble.colorBy({
  mount: '#colour',
  fields: [
    { name: 'kind', title: 'Kind', values: ['Text only', 'With links'] },
    { name: 'channel', title: 'Channel' },
  ],
  chips: 'filter',
  strip: '#list',
  onChange: load,
})

async function load() {
  const data = await thimble.fetch({ op: 'board', colour: colour.query() }, { key: 'board' })
  colour.counts(data.counts)
  document.getElementById('list').innerHTML = data.messages
    .map((m) => `<div class="row" data-anchor="${m.ref}"${colour.attr(m)}>${m.text}</div>`)
    .join('')
}
load()
</script>
```

| option | what it is |
|---|---|
| `mount` | an element or a selector in the view's top row. The control fills it and takes the row's free width. |
| `fields` | the view's own fields it can color by, in menu order: `{name, title, values?, value?}`. `name` is the field as the records hold it. `values` fixes the order of the values and their colors. A value given as `{name, colour}` takes the label palette's color `colour` (1 to 12), for example so that two values that often sit side by side do not take two blues. `value(record)` gives a record's value when it is not `record[name]`. |
| `initial` | the field chosen before the analyst picks one; the first field by default |
| `chips` | `'highlight'` (the default) dims the records of a value turned off; `'filter'` hides them |
| `strip` | the list that gets the tracks: an element, a selector, or `true` for the page |
| `onChange(colour)` | runs when the choice changes (Off among them), when a value is turned off or on, and when the values or colors of the label colored by change. Fetch and draw again here. |

## What the page does

- Give each record's element its `data-anchor`, as every view does, and `colour.attr(record)`. While a field is the
  color, `attr` writes `data-colour="<value>"`, which thimble draws the bar from. While a label is the color, or the
  color is Off, it writes nothing: thimble draws the label's value on each anchored record, or no bar. When the choice
  changes, the control takes every `data-colour` off the page until the page draws again in `onChange`.
- Pass `colour.query()` with each fetch, so the reader can count, filter and chart by the choice (below). It is `null`
  for Off.
- Give the counts with `colour.counts({value: n})`, the key `''` for records with no value. Without them, the control
  counts the elements on the page, which is right only when the page draws every record.
- Draw charts in `colour.colourOf(value)`, a color a canvas can draw, and leave out the values for which
  `colour.isOn(value)` is false. `colourOf` gives `null` for Off: draw those marks in one gray.
- A chart's key gives every series a mark drawn as the series is: a series in the Color by colors shows the chips'
  colors (or the field's name), one in a single color its swatch, and with Off a gray swatch.
- Draw no color control, legend or label list of your own. The control is the page's label control: a view that
  mounts it passes the check that a view draws its labels' controls.
- Where the page shows a value with its color outside the control, such as in a row's details, use the same key chip:
  `<span class="chip chip-key"><span class="chip-sw" style="--c:${colour.colourOf(v)}"></span><span class="chip-text">${v}</span></span>`.
- Give the page's chips, buttons, menus and fields thimble's classes (`chip`, `btn`, `seg`, `field`) and do not restyle
  them: the view checks note a rule that changes their edges, fills, corners, colors, type or height, and a chip of
  the page's own with corners rounder than `var(--radius-chip)` (views.own_parts). The same holds for the kit's own
  parts (`thimble-colour-*`, `thimble-range-*`, `thimble-axis-*`, `thimble-reset`).

## A long list's tracks

`strip: '#list'`, or `colour.strip('#list')` for another list, puts the list's scrollbar in tracks at its right edge:

- The overview track is the whole list: each record of a value that is on is a mark in its color where it stands in
  the list (gray for all of them with Off), the labels that are on mark their records as small ticks at the track's
  edge, and a frame as wide as the track outlines the part in view. Drag the frame to move the view.
- A list many times the height of its box adds the zoomed track at the overview's left: the part around the view at a
  finer scale, its colors faded beyond the part in view.
- Hovering the overview shows the records under the pointer in a preview, each with its time and first line, and the
  label and value of a tick there, without scrolling, and the zoomed track looks there while the pointer stays. A click
  goes there, a click on a mark goes to its record, and a drag scrubs, on either track.

For a list that draws only the rows in view, give every row's value in order: `colour.strip('#list', {rows: values})`,
with `refs` (each row's record, for the labels' ticks) and `preview(i)` (what the preview says of row `i`: a string, or
`{when, text}`). For a list of elements the preview reads each record's `<time>` and its text, or
`preview(element)`. Call `strip` again with the same list when they change.

## Details in place

A row's details open under its own line, as in the File browser's transcript, never in a box above the list:

```js
list.addEventListener('click', (e) => {
  const row = e.target.closest('.row')
  if (!row || e.target.closest('.thimble-details')) return
  open = open === row.dataset.anchor ? null : row.dataset.anchor
  thimble.expand(row, draw)   // draw() adds <div class="thimble-details"> under the open row
})
```

`thimble.expand(row, render)` runs `render()`, keeps the row where it was on the screen, under the pointer that
clicked it, and lets the details that appeared grow into place, the rows below moving down with them. The details are
the elements `render()` adds with the class `thimble-details` (or `{details: selector}`); a row that `render()` drew
again is found by its `data-anchor`. A second click closes the row.

## Reset

Reset shows at the end of the row while the view is not as it opens: a value turned off, a time range zoomed in, or a
search field or select in Color by's row changed. It puts them back and keeps the choice of Color by. Tell it the
page's own state, such as a menu's choice or the row opened, with `thimble.onReset`:

```js
thimble.onReset({
  changed: () => state.users.size > 0 || open != null,   // whether the view differs from how it opens
  reset: () => { state.users.clear(); open = null; load() },   // put it back and draw once
})
```

`reset()` runs after the kit has put back its chips, its time ranges and the row's fields (each field hears its own
`input` and `change` events), and Color by's and the ranges' `onChange` are not called then: draw the page once there.
A page that gives no `reset` hears those `onChange` calls instead. `onReset` returns `{check}`: call `check()` after
the page changes its state without a click or a key, so Reset shows or hides.

## In the reader

`colour.query()` is `{field, off}`, `{label, name, off}` or `null` (Off), with `off` the values turned off (`null` for
no value). The reader takes it with two calls:

```python
import thimble

def records(index, query):
    choice = query.get("colour")
    out, counts = [], Counter()
    for r in index["rows"]:
        ref = f"{index['path']}#L{r['line']}"
        if not thimble.kept(ref):
            continue
        value = thimble.colour_value(choice, ref, r)   # r["kind"], or a label's value on ref; None for Off
        counts["" if value is None else value] += 1
        if thimble.colour_on(choice, value):          # its chip is on
            out.append({**r, "ref": ref})
    return {"messages": out, "counts": dict(counts)}
```

For a label, `colour_value` gives the label's highlighted value on the record, the value its bar shows, and `None`
for a record the label does not mark.

## What thimble does

- With a field chosen, thimble draws a bar in the value's color on every element whose `data-colour` names a value,
  anchored or not. An SVG shape and a canvas take no bar: draw them in `colour.colourOf(value)`. The labels that are on
  draw no bar then, and the texts they match stay highlighted.
- With a label chosen, the label's value is the bar on each anchored record, as in the File browser.
- With Off, no element takes a bar.
- A label the analyst turns on, in the menu or anywhere in thimble, takes the color. When it is turned off again, the
  field chosen last is the color.
- A field's values take the label palette's colors: the declared `values` in their order, each in the color it
  names or else the next free one, then the others the first time they show, the most frequent first. A declared
  value always has its declared color; another value keeps its color after it first shows.
- A value turned off is hidden (`chips: 'filter'`) or dimmed (`'highlight'`) wherever its records show on the page.
  A page that leaves those records out itself, as the reader above does, loses nothing.
- A label's definition comes from thimble itself: the control asks with `thimble.fetch({$thimble: 'label', id})`,
  which thimble answers without calling the reader.

## The control

`thimble.colorBy` returns the control. Call it once; a second call replaces the control.

| member | what it gives |
|---|---|
| `by` | `{field, title}` or `{label, title}` (the label's id and name), or `null` (Off, or nothing to color by) |
| `off` | whether the analyst chose Off |
| `field`, `label` | the field colored by, or the label's id; `null` for the other and for Off |
| `values` | the chips: `[{value, name, colour, on, n}]`, `value` `null` for no value; none for Off |
| `valueOf(record)` | a record's value: its field's, or for a label the label's value on `record.ref` (or on a ref given as a string); `null` for Off |
| `colourOf(value)` | the value's color, `rgb()` or a hex, which a canvas can draw; `null` for no value and for Off |
| `isOn(value)`, `keeps(record)` | whether a value, or a record's value, is on |
| `attr(record)` | ` data-colour="<value>"` while a field is the color, `''` while a label is or for Off |
| `counts(map)` | the counts of the current choice's values from the reader; `null` counts the page's elements again |
| `query()` | the choice for the reader: `{field, off}`, `{label, name, off}`, or `null` for Off |
| `strip(list, {rows, refs, preview}?)` | the tracks on another list, or the rows of one already on |

`thimble.markOf(ref)` gives each label's value on a record as `values: [{id, label, value, colour}]`, and every color
it gives, `bar` too, is one a canvas can draw.
