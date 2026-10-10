# Charts on a card

A plot card draws a common chart with one call, `thimble.chart(kind, data, **options)`, beside `thimble.diagram`,
`thimble.timeline` and `thimble.card`. The card's code gives the data in the shape the kind takes and writes no plotting
code and no style:

```python
import thimble
thimble.chart("bar", posts.groupby("agent").size().rename("posts"))
```

`data` is a DataFrame whose columns come in the kind's order. Their names are what the axes and the legend say. A
Series is its index, then its values, so `value_counts()` and `groupby(...).size()` are bar charts as they are; a
histogram takes a Series as its values, and a box plot its values grouped by its index when that is named
(`df.set_index("model")["score"]`). A named index counts as the first columns.

| kind | columns, in order | options | draws |
|---|---|---|---|
| `bar` | category, value[, group] | sort, stack, label, marks, interval | named categories as bars lying down, the largest first; number categories as upright bars in order; times as upright bars, each spanning its time to the next |
| `line` | x, y[, series] | label, marks, panels | a line per series over numbers or times, with a dot at each value while a series has 30 or fewer |
| `area` | x, y[, series] | stack, label, marks | the series as areas stacked over numbers or times, the legend's first lowest, with a dot at each value while a series has 30 or fewer |
| `scatter` | x, y[, group] | label, marks | a point per row |
| `dots` | x, row[, group] | sort, label, marks, interval | a point per row on its row's line, such as each agent's test runs over time; rows earliest first |
| `box` | value, group | sort, label | a box per group lying down, the largest median first, over its values as faint dots; a group of fewer than 5 values as a strip of its dots |
| `histogram` | value | step, marks | the values counted in bins of a round width, at most 20 bins |
| `heatmap` | x, y, value | log | a cell per row, colored by its value; names by their totals, numbers and times in order |

A value, a y and a histogram's or box plot's value are numbers. A line's, an area's, a scatter's and a dots chart's x
is numbers or times. Text that is all ISO dates or months ("2026-06-18", "2025-04") reads as times.

## Options

- `sort`: a list of the categories (bar), rows (dots) or groups (box) in the order to show, the others after them in
  the default order; `None` keeps the frame's order.
- `stack`: with a group or series column, `True` (the default) stacks them in the legend's order; `False` sets bars side
  by side and overlaps areas lightly; `"share"` stacks each category or x to 100%.
- `label`: a label's name, when the group or series column (else the category or row column) holds the label's values.
  They take the label's order and the label's colors, the same colors as its tags in Files; a box plot keeps its median
  order and takes the colors.
- `marks`: `{text: x}`, a line across the chart at each x with its text, such as `{"#118 merged": "2026-08-30T16:02"}`.
  For charts whose x is numbers or times.
- `panels`: `True` draws each series of a line chart in a panel of its own, with its own y scale.
- `step`: a histogram's bin width.
- `log`: `True` colors a heatmap's values on a log scale.
- `interval`: `(lo, hi)`, the names of two more columns of a bar or dots chart's frame that hold each value's low and
  high ends, such as a Wilson interval's. Each value gets a line from its low end to its high end, in the theme's ink. A
  bar chart's groups then go side by side, and a dots chart's groups side by side on their row's line, so no interval
  covers another.

```python
thimble.chart("bar", evals[["model", "accuracy", "condition", "lo", "hi"]], interval=("lo", "hi"))
```

The interval's columns are named in the call rather than placed by position: the kind's own columns keep their places
and meanings, so a frame of four columns without `interval` is still a wrong frame, a group column of numbers is never
taken for a bound, and the call says which columns are the bounds. They may stand anywhere in the frame, and the chart's
rows keep them, so a takeaway cites an interval's ends as it cites the value. They are ends, not widths: a frame whose
values all lie outside their intervals fails, as does a low end above its high end.

A wrong frame fails with one line that names the columns the kind takes and what it got, for example `thimble.chart('bar')
takes (category, value) or (category, value, group) columns, the value numbers; `agent` holds text`.

## Box plots

`thimble.chart("box", runs[["turns", "agent"]])` draws each group's box from its first quartile to its third, its median
as a line in ink across the box, and whiskers to the farthest values within 1.5 box widths of it (Tukey's). Every value
is a faint dot behind its box, so the values past the whiskers show too. A group of fewer than 5 values gets no box,
only a strip of its dots. The chart's rows, the table a takeaway cites, are each group's summary: `n`, `low` and `high`
(the whiskers' ends), `q1`, `median` and `q3`, so a takeaway cites a group's median by the group's name. The values
behind the boxes are in the dots' own rows.

## How it draws

`thimble.chart` shows a Vega-Lite chart (`application/vnd.vegalite.v6.json`, as Altair does) with its rows inline and no
color, font or size of its own. The card draws it in thimble's theme, as it draws every chart (frontend
`lib/vizTheme.ts` and `lib/chartDefaults.ts`), so these charts change with the theme and look alike. A mark that only a
job sets apart names that job as a Vega-Lite style, and the theme's `style` config gives it its look: `thimble-faint`
(a box plot's values), `thimble-box` (its boxes), `thimble-median` (its medians, in ink) and `thimble-overlap` (areas
side by side). An interval is a rule, which the theme draws in its annotation ink. A chart colored by
a label takes the label's colors because the call notes the label as read (as `thimble.labels` does), and the card gives
a label it read its colors. The inline rows are the chart's table: the model reads them in the card's output and a
takeaway cites a value by column and row, as for any chart. Times without a zone show as they are, and times with a zone
at their zone's clock time.

A chart of another form is still Altair or matplotlib code in a plot card. The code is in
`backend/app/kernel_thimble.py` (`chart`, `CHARTS`), the tests in `backend/tests_public/test_charts.py`.

## In a view

A view's page draws the same charts with the view kit's `thimble.chart(mount, kind, rows, options)`: the same kinds,
columns and options, with `rows` a list of objects whose keys come in the kind's order, as a DataFrame's columns do,
and times as ISO text. The page names `vega-embed` in view.json's `libs`.

```js
thimble.chart('#posts', 'bar', counts.map((c) => ({ Agent: c.agent, Posts: c.n })), { height: 140 })
```

Beside the options above it takes three of the kit's own:

- `colour`: Color by. The group or series column's values take Color by's colors, the colors of their records' bars,
  and the chart draws no legend, since Color by's chips are its key; a value with no color, as with Off or a value
  turned off, is gray. A page groups its records by `colour.valueOf(record)` for that column.
- `onPick(row)`: a mark clicked, with its row, such as to filter by its category or to open it in the side panel.
- `height`: the plot's height in px, at most 36 px a row for the rows a chart names down its side, so a few bars stay
  bars.

The chart takes its mount's width and follows it. Called again on the same mount, it replaces the chart and leaves the
same chart as it is, so a page draws it in its `draw()` with the rows Filter by keeps. A chart of no rows says so, and a
wrong call says what is wrong in the chart's place, in the words a card's chart fails with.
`thimble.chart(mount, spec, options)` draws any other Vega-Lite spec the same way. It returns a promise of the chart's
Vega view, or null when it draws none.

Each half of the chart has one source. The kit builds no spec: it asks thimble for it with the kit's own fetch,
`{"$thimble": "chart", kind, rows, options}`, which thimble answers with the code a card's `thimble.chart` runs
(`kernel_thimble.chart_spec`, through `views.chart_answer`), so a view's chart takes a card's kinds and options and
fails as a card's does. And it draws the spec with the code the canvas draws every chart with (frontend
`lib/vegaDraw.ts`, with `lib/chartDefaults.ts` and the chart style of `lib/vizTheme.ts`), which `vite build` writes
beside the app as `kit/chart.js` and every view page inlines, so a view's charts follow the theme as a card's do.
