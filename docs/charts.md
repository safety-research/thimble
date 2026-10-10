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
histogram takes a Series as its values. A named index counts as the first columns.

| kind | columns, in order | options | draws |
|---|---|---|---|
| `bar` | category, value[, group] | sort, stack, label, marks | named categories as bars lying down, the largest first; number categories as upright bars in order; times as upright bars, each spanning its time to the next |
| `line` | x, y[, series] | label, marks, panels | a line per series over numbers or times, with a dot at each value while a series has 30 or fewer |
| `scatter` | x, y[, group] | label, marks | a point per row |
| `dots` | x, row[, group] | sort, label, marks | a point per row on its row's line, such as each agent's test runs over time; rows earliest first |
| `histogram` | value | step, marks | the values counted in bins of a round width, at most 20 bins |
| `heatmap` | x, y, value | log | a cell per row, colored by its value; names by their totals, numbers and times in order |

A value, a y and a histogram's value are numbers. A line's, a scatter's and a dots chart's x is numbers or times. Text
that is all ISO dates or months ("2026-06-18", "2025-04") reads as times.

## Options

- `sort`: a list of the categories (bar) or rows (dots) in the order to show, the others after them in the default
  order; `None` keeps the frame's order.
- `stack`: with a group column, `True` (the default) stacks the groups in the legend's order, `False` sets them side by
  side, `"share"` stacks each category to 100%.
- `label`: a label's name, when the group column (else the category or row column) holds the label's values. They take
  the label's order and the label's colors, the same colors as its tags in Files.
- `marks`: `{text: x}`, a line across the chart at each x with its text, such as `{"#118 merged": "2026-08-30T16:02"}`.
  For charts whose x is numbers or times.
- `panels`: `True` draws each series of a line chart in a panel of its own, with its own y scale.
- `step`: a histogram's bin width.
- `log`: `True` colors a heatmap's values on a log scale.

A wrong frame fails with one line that names the columns the kind takes and what it got, for example `thimble.chart('bar')
takes (category, value) or (category, value, group) columns, the value numbers; `agent` holds text`.

## How it draws

`thimble.chart` shows a Vega-Lite chart (`application/vnd.vegalite.v6.json`, as Altair does) with its rows inline and no
color, font or size of its own. The card draws it in thimble's theme, as it draws every chart (frontend
`lib/vizTheme.ts` and `lib/chartDefaults.ts`), so these charts change with the theme and look alike. A chart colored by
a label takes the label's colors because the call notes the label as read (as `thimble.labels` does), and the card gives
a label it read its colors. The inline rows are the chart's table: the model reads them in the card's output and a
takeaway cites a value by column and row, as for any chart. Times without a zone show as they are, and times with a zone
at their zone's clock time.

A chart of another form is still Altair or matplotlib code in a plot card. The code is in
`backend/app/kernel_thimble.py` (`chart`, `CHARTS`), the tests in `backend/tests_public/test_charts.py`.
