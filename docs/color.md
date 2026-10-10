# Color in a view

Every view page has thimble's Color by control, `thimble.colorBy`, in its view kit (`thimble.colourBy` is the same
function). The page mounts it in its top row and draws its records with the color it chooses. Use it in place of a
color control of your own, so that every view colors the same way. Color is one encoding at a time: only the Color by
choice is drawn in colors, on the chips, the records' bars, the tracks and the chart marks. Show any other category of
the view as text, a glyph or a gray pattern, never in a second palette. Filter by and Rows stand beside it in the top row
([rows-and-filters.md](rows-and-filters.md)): they read a field or a label the way Color by does, and draw no color.

- One menu, which takes several choices: Off, then the fields the view can color by under "Fields" and every label
  over files under "Labels", each with how many values it colors by and those values as chips on a line under its
  name. Fields are values the files hold or the reader works out, such as a kind or a source. A field the page
  declares no `values` for shows the values its records take on the page (those the page hands the control through
  `attr`, `valueOf` or `keeps`), the commonest first, in the colors they would take if it were chosen now. The labels
  that mark the view's files come first. A label is a choice as a field is: it has no switch of its own.
- A click checks a field or a label, or unchecks it, and the menu stays open. The first one checked is the color: the
  chips, the records' bars and the first lane of the tracks. Each one checked after it is a lane of its own in the
  tracks (below), and the menu says "track" after its name. Unchecking the first gives the color to the next; unchecking
  the last is Off. Off unchecks them all and closes the menu.
- Checking a label turns it on in Files and every view and opens thimble's label editor beside the menu: the same
  editor as Files' (what it labels and marks, the files it applies to, its classifier, its prompt, pattern or code,
  and its classes with their colors and highlights), drawn by thimble over the view, so the view stays where it is. A
  class's color square opens the same picker as a chip's square. Escape, ×, Cancel and Re-run close the editor and put
  the focus back on the label's row; a click in the view closes it too. Unchecking a label turns it off, unless Rows
  or Filter by holds it. Checking a field or Off opens nothing.
- Color by is thimble's small secondary button, with the first choice in it and how many more there are: "Color by:
  Kind", "Color by: Kind +1".
- Off colors nothing anywhere: no chips, no bars, no lanes, the tracks a plain scrollbar, the lanes and the time range's
  overview every record in gray, and the labels' texts highlighted in gray, a label on or not.
- The values of the chosen field show as key chips in the top row (`chip chip-key` in the view kit): a square of the
  value's color, its name and its count. The chip of the records with no value ("Not marked", "No kind") has the gray
  square the marks draw those records in. A click turns a value's color off or on. An Alt-click, or a double click,
  keeps that value's color alone. A value turned off keeps its records, drawn in gray as the records with no value are
  (Filter by is what hides records), and its chip goes quiet with an empty square.
  Hovering a value shows what it means: a label's value what the label says, a field's value what the page declares
  for it, else what the field is.
- The chips that do not fit the row go behind "N more", which lists those values with what a chip offers: a box that
  turns the value off or on (Alt keeps it alone), its color square, which opens the picker under it in the menu, and
  what it means on hover.
- A field has twelve colors its values take by themselves. The values past the twelfth would share one gray, so they
  sit under one chip, "Other", in that gray with their counts summed: a click turns them all off or on, an Alt-click
  keeps them alone, and hovering it names them. The page still hears of each of them in `values`, in the gray.
- A click on a chip's square opens the color picker: every hue around the color wheel, a column per hue with its light
  color above its dark one, red, orange, gold, green, teal, sky, blue, purple and pink (backend/app/label_wheel.json,
  which the app's pickers read too). The color picked recolors the value everywhere in the view: its chip, the
  records' bars, the tracks, and what the page draws through `colourOf`. A label's value keeps it as the label's color,
  in Files and every view; a field's value keeps it for this view, and Reset colors in the picker gives the field's
  values their own colors back. Red, purple and pink (places 13 to 18) are the analyst's to pick: no value takes them by
  itself, so the problem red and the agents' purple keep their meaning, and a failed mark keeps a shape (✕) beside
  its red so that it stays apart from a value picked red.
- Color marks the unit its value belongs to: the records, the elements the page anchors (`data-anchor`). On a record,
  color is a 3 px bar on the left edge of its row or card; with several choices, a band per choice there, side by side
  in the order of the overview's lanes (the first at the edge), each in the color of the record's value of that choice
  and empty where it has none, so that a row's edge reads as a slice of the tracks. The bands stay in the space the bar
  takes (narrower as more come), so the text stays where it is. Text and fills keep their own colors. A group of records (a
  page, a wiki, an agent, a run, a session, a source) takes no color of its own: no colored title, edge or chip. Its row
  may show how its records divide among the values with `thimble.mix` (below). The texts the chosen label matches are
  highlighted in its colors; the texts of the other labels that are on, and every label's while a field or Off is
  chosen, in gray.
- A menu, a tip or the picker never covers a list's tracks: it stands left of them, and thimble's label editor opens on
  the menu's left where its right would cover them.
- A view never scrolls sideways: the kit keeps the page to its pane's width (a long line of code wraps, a picture, a
  video and a canvas scale down), and the overview under the divider scrolls down only. The view checks note a page
  that is wider than its pane.
- A long list of records gets a strip of its colors in place of its scrollbar, with a loupe on rest, as Files' reader
  has (below). A list of groups gets a plain scrollbar.
- Reset, at the end of the row, shows while the view is not as it opens and puts it back (below). While hidden it
  keeps its place unseen, so the chips fit the same width whether it shows or not and none moves behind "N more" when
  it shows. Only in a row too narrow for "N more" beside Color by does the hidden Reset give up its place.
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
| `fields` | the view's own fields it can color by, in menu order: `{name, title, description?, values?, meanings?, value?}`. `name` is the field as the records hold it. `description` says what the field is, on its chips' hover and its menu row. `values` fixes the order of the values and their colors. A value given as `{name, colour}` takes the label palette's color `colour` (1 to 12: 1 blue, 2 orange, 3 green, 4 sky, 5 gold, 6 teal, 7 brown, 8 navy, 9 grass, 10 cerulean, 11 chestnut, 12 cyan), for example so that two values that often sit side by side do not take two blues; `{name, meaning}` says what the value means, on its chip's hover. `meanings`, `{value: meaning}`, says what values mean without declaring them, so they keep the order and colors the records give them. `value(record)` gives a record's value when it is not `record[name]`. |
| `initial` | the field chosen before the analyst picks one; the first field by default |
| `chips` | does nothing: a value turned off keeps its records, in gray, whatever it says (`'filter'` hid them once). Filter by hides records ([rows-and-filters.md](rows-and-filters.md)) |
| `strip` | the list that gets the tracks: an element, a selector, or `true` for the page |
| `onChange(colour)` | runs when the choice changes (Off among them), when a value is turned off or on, and when the values or colors of the label colored by change. Fetch and draw again here. |

## What the page does

- Give each record's element its `data-anchor`, as every view does, and `colour.attr(record)`. While a field is the
  color, `attr` writes `data-colour="<value>"`, which thimble draws the bar from, on the anchored element alone. While
  a label is the color, or the color is Off, it writes nothing: thimble draws the label's value on each anchored record,
  or no bar. While a field is one of the choices past the first, `attr` writes its value in `data-colour-tracks` too,
  which its lane of the tracks reads. When the choices change, the control takes every `data-colour` (and
  `data-colour-tracks`) off the page until the page draws again in `onChange`.
- The kit's parts keep their own bars: the table, the transcript, the messages, the record, the cards and the timeline
  color their records by the page's Color by, mounted before or after them, and stamp them again when the choices
  change, so `onChange` draws again only the page's own markup. A part takes `colour` (or `color`, the same option) for
  another Color by, and `colour: false` for no bars.
- Draw a group's row (a page, an agent, a session) with no `data-colour` and no color of its own. To show the mix of
  its records' values, put `thimble.mix(counts)` in it, `{value: n}` with `''` for the records with no value: a small
  bar, 48 px wide, each value's share in its color in the chips' order, a value turned off in gray, the records with
  no value gray and last, and nothing with Off. `thimble.mix(el, counts)` draws it into `el`.
- Pass `colour.query()` with each fetch, so the reader can count and chart by the choice (below). It is `null` for
  Off.
- Give the counts with `colour.counts({value: n})`, the key `''` for records with no value. Without them, the control
  counts the elements on the page, which is right only when the page draws every record.
- Draw charts in `colour.colourOf(value)`, a color a canvas can draw. `colourOf` gives `null` for no value, for a value
  turned off and for Off: draw those marks in one gray, and keep them.
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

`strip: '#list'`, or `colour.strip('#list', {rows})` or `{whole: true}` for another list (see below), puts the list's
scrollbar in one strip at its right edge, at every length:

- The strip is the whole list in one lane for the first choice: each pixel row in the color of the value that
  is on which most of the records there take, never two colors side by side. The records with no value ("No kind",
  "Not marked") and those of a value turned off are the gray the no-value chip has, and only where no record of the
  pixel row takes a value that is on, so a value is never hidden under them. Each of Color by's choices past the
  first has a lane of its own beside it, in its colors (a label's own, a field's values'), so that one choice is one
  lane and two are two; a label that is on but no choice has no lane. Each lane names its choice on hover; each is 7
  px wide, 2 px from the next. Only the first choice colors the records' bars. A thumb as wide as the strip frames the
  part in view; drag it to move the view.
- While the view's search finds something ([search-table-diff.md](search-table-diff.md)), a lane of ticks in the ink,
  one per match, stands at the strip's left, before Color by's lanes; a click on a tick goes to that match.
- Where the strip draws a record shorter than 3 px, resting on it for 250 ms opens the loupe beside it: a short list,
  a line per record around the pointer, each its line or key, a cell per lane in the record's color (an empty cell for
  none) and the start of its text; the record under the pointer darker, those in view tinted, and a bracket beside the
  strip over the stretch the loupe shows. It follows the pointer along the strip, and moves to the thumb only on a real
  scroll: the wheel over the strip or the loupe, or a drag of the thumb. Once the pointer is in it, it holds still: a
  click goes to that record, highlights it for a moment and leaves the loupe's rows where they are, and the wheel
  scrolls the list, the rows following. A strip that tells every record apart names the record under the pointer on
  rest instead, on one line. On a touch screen a press on the strip opens the loupe, a drag scrubs and the release goes
  there.
- A click on the strip sends the thumb there, its middle under the pointer; a click within 4 px of a thin patch of a
  color (8 px tall at most, such as a lone record of a value) snaps to it: the list goes to the patch's first record
  and highlights it for a moment. A press becomes a drag once the pointer moves 3 px, and a drag of the thumb, or from
  where the press was, scrubs the list. The wheel over the strip scrolls the list.
- The strip moves in the browser's animation frames with transforms alone, so it follows a scroll or a drag frame by
  frame; once still, every edge goes onto the device's pixel grid.

For a list that draws only the rows in view, give every row's value in order: `colour.strip('#list', {rows: values})`,
with `preview(i)` (what the loupe says of row `i`: a string, or `{when, text}`; without it, the text of the row's
element where the page draws it), `refs` (each row's ref, which the labels' lanes read and whose line, `#L12`, or key
the loupe's line starts with) and `records` (each row's record, which the lanes of fields past the first choice read).
For a list of elements the loupe reads each record's `<time>` and its text, or `preview(element)`, and its
`data-anchor`. Call `strip` again with the same list when they change; rows given again unchanged, as a list drawn
again on each scroll gives them, are not measured again. The view checks count each row given with its ref as shown,
once the rows the list draws carry those refs as their `data-anchor`.

The tracks show colors only on a list of the records the color marks, and only where they reflect the whole list:
Color by's own `strip`, a list given `rows`, or another list whose elements are all of its records, which says so
with `colour.strip('#other', {whole: true})`. Any other pane, such as a list of groups (pages, agents, runs), a view's
second list or one that loads its records in pieces, gets a plain track: a scrollbar in the kit's style with no
colors and no lanes, its loupe with no cells. So does a list none of whose records takes a color (Off, or every value
turned off). A secondary pane is plain unless the page asks for its colors this way.

## Details

A record, or a row's children, open in the kit's side panel beside the list, never under the row, so the list keeps
its place: `thimble.side` ([rows-and-filters.md](rows-and-filters.md)).

`thimble.expand(row, render)`, which opened a row's details under its own line, stays for the views built before the
side panel: it runs `render()`, keeps the row where it was on the screen and lets the details that appeared (the
elements with the class `thimble-details`) grow into place. A new view uses the side panel.

## Reset

Reset shows at the end of the row while the view is not as it opens: a value turned off (Color by's or Filter by's), a
series of a key turned off, a time range zoomed in, the side panel open, or a search field or select in Color by's row
changed. It puts them back and keeps the choices of Color by, Filter by and Rows. Tell it the
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

`colour.query()` is `{field}`, `{label, name}` or `null` (Off). It names no value turned off, since Color by hides no
record. The reader takes it with `thimble.colour_value`:

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
        out.append({**r, "ref": ref})
    return {"messages": out, "counts": dict(counts)}
```

For a label, `colour_value` gives the label's highlighted value on the record, the value its bar shows, and `None`
for a record the label does not mark.

## What thimble does

- With a field chosen, thimble draws a bar in the value's color on every anchored element whose `data-colour` names a
  value; an element with no anchor, such as a group's row, takes none. An SVG shape and a canvas take no bar: draw them in `colour.colourOf(value)`. The labels that are on
  draw no bar then, and the texts they match stay highlighted in gray.
- With a label chosen, the label's value is the bar on each anchored record, as in the File browser, and the texts it
  matches are highlighted in its colors; the other labels' texts in gray.
- With Off, no element takes a bar, and the labels' texts are highlighted in gray.
- A label the analyst turns on, in the menu or anywhere in thimble, takes the first place, the color, unless Rows groups
  the lanes by it ([rows-and-filters.md](rows-and-filters.md)): a field that was the color gives way, and a label that
  was keeps its lane. When it is turned off again it leaves the choices, and the next is the color; with none left, the
  field chosen last.
- Every choice of Color by, Rows and Filter by the page mounts must draw the view, Off and None among them: the view
  checks try each in turn, and each control's first choice again after the others, and fail the view on the choice
  whose drawing gives a script error, naming it. Guard what the page reads of a choice that can be null (`rows.by`,
  `colour.by`, `filter.by`).
- A field's values take the label palette's colors: the declared `values` in their order, each in the color it
  names or else the next free one, then the others the first time they show, the most frequent first. A declared
  value always has its declared color; another value keeps its color after it first shows. Free colors go in the
  order new values take them everywhere in thimble: blue, orange, green, gold, teal, brown, sky, then navy, grass,
  cerulean, chestnut and cyan, so the first five are five hues with no second blue among them, each pair 15 or more
  apart in OKLab on every paper, Dark as well. A color's number is its place in the palette, so `colour: 4` is always
  sky, whatever the order. The chips of values the page did not declare come in the order of their colors.
- A value turned off takes its color off its records wherever they show on the page: no bar, and the chosen label's
  texts of that value in gray. thimble never hides or dims them; Filter by is what hides records.
- What a label's values mean comes from thimble itself: the control asks with `thimble.fetch({$thimble: 'label',
  id})`, which thimble answers without calling the reader.
- The label editor opens through `thimble.editLabel(id, {anchor: menu})` during the analyst's click (the bridge's
  label calls take effect only then). A page that offers its own control for a label can open the editor the same way,
  with that control as the anchor.

## The control

`thimble.colorBy` returns the control. Call it once; a second call replaces the control.

| member | what it gives |
|---|---|
| `by` | the first choice: `{field, title}` or `{label, title}` (the label's id and name), or `null` (Off, or nothing to color by) |
| `picks` | every choice in order, the first the color and each other a lane of the tracks: `[{field, title}]` or `[{label, title}]`; none for Off |
| `off` | whether the analyst chose Off |
| `field`, `label` | the field colored by, or the label's id; `null` for the other and for Off |
| `values` | the chips' values: `[{value, name, colour, on, n}]`, `value` `null` for no value, each value under "Other" in its place; none for Off |
| `valueOf(record)` | a record's value: its field's, or for a label the label's value on `record.ref` (or on a ref given as a string); `null` for Off |
| `colourOf(value)` | the value's color, `rgb()` or a hex, which a canvas can draw; `null` for no value, for a value turned off and for Off |
| `isOn(value)` | whether a value's color is on |
| `keeps(record)` | always `true`: Color by hides no record (Filter by's `keeps` does) |
| `attr(record)` | ` data-colour="<value>"` while a field is the color, `''` while a label is or for Off; with ` data-colour-tracks` for the fields past the first choice |
| `counts(map)` | the counts of the current choice's values from the reader; `null` counts the page's elements again |
| `query()` | the choice for the reader: `{field}`, `{label, name}`, or `null` for Off |
| `strip(list, {rows, refs, records, preview, whole}?)` | the tracks on another list, or the rows of one already on |

`thimble.markOf(ref)` gives each label's value on a record as `values: [{id, label, value, colour}]`, and every color
it gives, `bar` too, is one a canvas can draw.
