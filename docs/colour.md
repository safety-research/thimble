# Colour in a view

Every view page has thimble's Colour by control, `thimble.colourBy`, in its view kit. The page mounts it in its top
row and draws its records with the colour it chooses. Use it in place of a colour control of your own, so that every
view colours the same way:

- One menu lists the fields the view can colour by and every label over files. Fields are values the files hold or the
  reader works out, such as a kind or a source. The labels that mark the view's files come first, each with its switch.
- The values of the chosen field show as chips in the top row, each with its count. A click turns a value off or on.
  An Alt-click, or a double click, shows that value alone. A value turned off is hidden or dimmed, as the view says.
- Colour is a 3 px bar on the left edge of a record's row or card, and of each chip. Text and fills keep their own
  colours.
- A coloured scrollbar shows where the records of each value are in a long list. It is the scrollbar of the File
  browser's transcript mode.
- thimble keeps the choice, the values turned off and each value's colour per view. The page opens on them again.

[plugin/viewers/colour-by](../plugin/viewers/colour-by) is a small view that uses all of it, one of the worked examples
the dev agent reads: a team's messages coloured by a message's kind, channel or author, or by a label, with the
messages per hour above the list. `backend/.venv/bin/python scripts/dev/examples.py <folder>` opens it, and the other
worked examples, on its sample with its sample label, in the environment of your stack.

## Mount it

```html
<div class="top">
  <input class="field" id="q" placeholder="Search messages">
  <span id="colour"></span>
</div>
<div id="list"></div>
<script>
const colour = thimble.colourBy({
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
| `fields` | the view's own fields it can colour by, in menu order: `{name, title, values?, value?}`. `name` is the field as the records hold it. `values` fixes the order of the values and their colours. `value(record)` gives a record's value when it is not `record[name]`. |
| `initial` | the field chosen before the analyst picks one; the first field by default |
| `chips` | `'highlight'` (the default) dims the records of a value turned off; `'filter'` hides them |
| `strip` | the list that gets the coloured scrollbar: an element, a selector, or `true` for the page |
| `onChange(colour)` | runs when the choice changes, when a value is turned off or on, and when the values or colours of the label coloured by change. Fetch and draw again here. |

## What the page does

- Give each record's element its `data-anchor`, as every view does, and `colour.attr(record)`. While a field is the
  colour, `attr` writes `data-colour="<value>"`, which thimble draws the bar from. While a label is the colour, it
  writes nothing: thimble draws the label's value on each anchored record. When the choice changes, the control takes
  every `data-colour` off the page until the page draws again in `onChange`.
- Pass `colour.query()` with each fetch, so the reader can count, filter and chart by the choice (below).
- Give the counts with `colour.counts({value: n})`, the key `''` for records with no value. Without them, the control
  counts the elements on the page, which is right only when the page draws every record.
- Draw charts in `colour.colourOf(value)`, a colour a canvas can draw, and leave out the values for which
  `colour.isOn(value)` is false.
- For a list that draws only the rows in view, give every row's value in order: `colour.strip('#list', {rows: values})`.
  Call it again with the same list when the values change.
- Draw no colour control, legend or label list of your own. The control is the page's label control: a view that
  mounts it passes the check that a view draws its labels' controls.

## In the reader

`colour.query()` is `{field, off}` or `{label, name, off}`, with `off` the values turned off (`null` for no value). The
reader takes it with two calls:

```python
import thimble

def records(index, query):
    choice = query.get("colour")
    out, counts = [], Counter()
    for r in index["rows"]:
        ref = f"{index['path']}#L{r['line']}"
        if not thimble.kept(ref):
            continue
        value = thimble.colour_value(choice, ref, r)   # r["kind"], or a label's value on ref
        counts["" if value is None else value] += 1
        if thimble.colour_on(choice, value):          # its chip is on
            out.append({**r, "ref": ref})
    return {"messages": out, "counts": dict(counts)}
```

For a label, `colour_value` gives the label's highlighted value on the record, the value its bar shows, and `None`
for a record the label does not mark.

## What thimble does

- With a field chosen, thimble draws a bar in the value's colour on every element whose `data-colour` names a value,
  anchored or not. An SVG shape and a canvas take no bar: draw them in `colour.colourOf(value)`. The labels that are on
  draw no bar then, and the texts they match stay highlighted.
- With a label chosen, the label's value is the bar on each anchored record, as in the File browser.
- A label the analyst turns on, in the menu or anywhere in thimble, takes the colour. When it is turned off again, the
  field chosen last is the colour.
- A field's values take the label palette's colours: the declared `values` in their order, then the others the first
  time they show, the most frequent first. Each keeps its colour after that.
- A value turned off is hidden (`chips: 'filter'`) or dimmed (`'highlight'`) wherever its records show on the page.
  A page that leaves those records out itself, as the reader above does, loses nothing.

## The control

`thimble.colourBy` returns the control. Call it once; a second call replaces the control.

| member | what it gives |
|---|---|
| `by` | `{field, title}` or `{label, title}` (the label's id and name), or `null` |
| `field`, `label` | the field coloured by, or the label's id; `null` for the other |
| `values` | the chips: `[{value, name, colour, on, n}]`, `value` `null` for no value |
| `valueOf(record)` | a record's value: its field's, or for a label the label's value on `record.ref` (or on a ref given as a string) |
| `colourOf(value)` | the value's colour, `rgb()` or a hex, which a canvas can draw; `null` for no value |
| `isOn(value)`, `keeps(record)` | whether a value, or a record's value, is on |
| `attr(record)` | ` data-colour="<value>"` while a field is the colour, `''` while a label is |
| `counts(map)` | the counts of the current choice's values from the reader; `null` counts the page's elements again |
| `query()` | the choice for the reader: `{field, off}` or `{label, name, off}` |
| `strip(list, {rows}?)` | the coloured scrollbar on another list, or the rows of one already on |

`thimble.markOf(ref)` gives each label's value on a record as `values: [{id, label, value, colour}]`, and every colour
it gives, `bar` too, is one a canvas can draw.
