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
histogram, a density and an ecdf take a Series as its values, and a box plot or a violin its values grouped by its index
when that is named (`df.set_index("model")["score"]`). A named index counts as the first columns.

| kind | columns, in order | options | draws |
|---|---|---|---|
| `bar` | category, value[, group] | sort, stack, label, marks, interval, panels | named categories as bars lying down, the largest first; number categories as upright bars in order; times as upright bars, each spanning its time to the next |
| `line` | x, y[, series] | label, marks, interval, panels | a line per series over numbers or times, with a dot at each value while a series has 30 or fewer |
| `area` | x, y[, series] | stack, label, marks, panels | the series as areas stacked over numbers or times, the legend's first lowest, with a hover tip at each value while a series has 30 or fewer |
| `scatter` | x, y[, group] | label, marks, fit, panels | a point per row |
| `dots` | x, row[, group] | sort, label, marks, interval, panels | a point per row on its row's line, such as each agent's test runs over time; rows earliest first, groups side by side on the line; dots that would overlap move across the line |
| `box` | value, group | sort, label | a box per group lying down, the largest median first, with whiskers and a dot for each value past them; a group of fewer than 5 values as a strip of its dots |
| `histogram` | value[, group] | step, label, marks, panels | the values counted in bins of a round width, at most 20 bins; groups stacked in each bin |
| `density` | value[, group] | bandwidth, sort, label, marks, panels | each group's values as a smooth curve; up to 4 groups overlap lightly, 5 or more stand one over another (a ridgeline), the largest median on top |
| `violin` | value, group | bandwidth, sort, label | each group's density curve mirrored either side of its own line, lying down, with its quartiles; the largest median on top; a group of fewer than 5 values as a strip of its dots |
| `ecdf` | value[, group] | label, marks | each group's cumulative share: at each value, the share of its values at or below it, such as the share of PRs merged within x minutes |
| `range` | item, before, after[, group] | sort, label, marks | a dumbbell per item lying down, a line from its before to its after, each end a solid dot of its own color; the largest after first, or with times the earliest before |
| `heatmap` | x, y, value | log | a cell per row, colored by its value; names by their totals, numbers and times in order |

A value, a y and a histogram's, density's, violin's, ecdf's or box plot's value are numbers. A line's, an area's, a
scatter's and a dots chart's x is numbers or times, as are a range's before and after (both numbers or both times). Text
that is all ISO dates or months ("2026-06-18", "2025-04") reads as times. A histogram, a density, a violin and an ecdf
take any number of values and leave out missing and infinite ones; the other kinds draw 5,000 rows at most.

## Options

- `sort`: a list of the categories (bar), rows (dots), groups (box, density, violin) or items (range) in the order to
  show, the others after them in the default order; `None` keeps the frame's order.
- `stack`: with a group or series column, `True` (the default) stacks them in the legend's order; `False` sets bars side
  by side and overlaps areas lightly; `"share"` stacks each category or x to 100%.
- `label`: a label's name, when the group or series column (else the category, row or item column) holds the label's
  values. They take the label's order and the label's colors, the same colors as its tags in Files; a box plot, a
  density and a violin keep their median order and take the colors.
- `marks`: `{text: x}`, a line across the chart at each x with its text, such as `{"#118 merged": "2026-08-30T16:02"}`.
  For charts whose x is numbers or times.
- `panels`: `True` draws each group or series in a panel of its own, one under another. The panels share their scales,
  so they compare, but a line chart's, whose panels each have their own y scale. Marks repeat in every panel.
- `fit`: `"linear"` or `"smooth"` on a scatter, a trend line for each group: least squares, or a local regression
  (LOESS, as ggplot's smooth draws it, that an outlier barely moves). Each row's fitted value is a column of the chart's
  rows (`cost fit` for a y named `cost`), so a takeaway cites it.
- `step`: a histogram's bin width.
- `bandwidth`: how widely a density or a violin smooths, in the value's units; by default each group's own, by
  Silverman's rule.
- `log`: `True` colors a heatmap's values on a log scale.
- `interval`: `(lo, hi)`, the names of two more columns of a bar, dots or line chart's frame that hold each value's low
  and high ends, such as a Wilson interval's. Each value gets a line from its low end to its high end, in the theme's
  ink. A bar chart's groups then go side by side, as a dots chart's always do on their row's line, so no interval covers
  another. A line's intervals are error bars under its dots, each series' in its color, and along a line too long for
  dots a faint band.

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
as a line in ink across the box, and whiskers to the farthest values within 1.5 box widths of it (Tukey's). Each value
past the whiskers is a dot. A group of fewer than 5 values gets no box, only a strip of its dots. The chart's rows, the
table a takeaway cites, are each group's summary: `n`, `low` and `high` (the whiskers' ends), `q1`, `median` and `q3`,
so a takeaway cites a group's median by the group's name. The dots' values are in the dots' own rows.

## Density, violin, ecdf and range

A density computes each group's curve in Python (a Gaussian kernel's) over a range the curves share, at 100 to 400
points, enough that the narrowest curve shows its bumps. The range stops at 0 when no value is below it, and the
smoothing that would pass 0 is folded back inside, so a curve of values crowding 0 stays high there. Each curve's area
is 1, so the curves compare shapes, not counts. The chart's rows are those points: the value, `density` and the group.
With 5 or more groups and no panels, the groups stand one over another, each curve on a baseline of its own named on the
y axis, the curves scaled alike. The places of the ridges are laid out by the chart, not held in its rows.

A violin's rows are the same points as a density's. Each group lies on its own line, as a box plot's does, its curve
mirrored either side of the line, each curve as wide at its widest as the others, with a line in ink from its first
quartile to its third and its median as a mark in ink across it. A group of fewer than 5 values is a strip of its dots,
as in a box plot, and has no curve in the rows. The quartiles and the dots are in their layers' own rows.

An ecdf's rows are each group's distinct values with `share`, the share of the group's values at or below it, drawn as
steps; a group of more than 500 distinct values keeps 500 of them, evenly spread, the last at 100%. Its legend lists the
groups by their median, the least first, as their curves stand from the top.

A range's rows are the frame's own. Its x axis is titled by the two columns, as in `base → tuned`, and the ends are
places rather than lengths, so the axis spans them rather than starting at 0. The two ends take two series colors, which
the legend names by the columns; when a group column, or a label on the items, colors the dumbbells, the before end is
the lighter, in a legend titled `end`. An item in several groups has their dumbbells side by side on its line.

```python
thimble.chart("range", evals[["model", "base", "tuned"]])
```

## Your own marks on a chart

`thimble.chart(kind, data, show=False, **options)` shows nothing and returns the chart as an Altair chart, which the
card's code layers its own marks on: text, rules, shaded spans (a `rect` with `x` and `x2`), arrows, callouts with
leader lines. The marks take the theme's face, sizes and colors: a mark given no color takes the first series color,
and text and rules the theme's annotation ink. `thimble.theme` names the theme's colors by role, for the marks that
need one: `accent` (one thing set against the rest), `ink` (text that leads), `muted` (the rest), `pale` (leader lines
and spans), and `series[0]` to `series[6]` (a chart's groups in order). Each is a CSS variable, such as
`var(--viz-highlight)`, that the card reads when it draws the chart, so the marks follow the accent and the paper, dark
included. The chart's rows stay the table a takeaway cites wherever the chart stands among the layers, so a shaded
span can come first and lie behind it. A chart layered or concatenated in plain Altair takes its layer or panel with
the most rows as its table.

A daily bar chart with a few events called out above it, each a date in the accent over a few words, with a thin pale
leader line down to its bar:

```python
import altair as alt
import pandas as pd
import thimble

bars = thimble.chart("bar", daily, show=False)  # daily: day, merged
top = daily["merged"].max() * 1.3
ev = alt.Chart(events.merge(daily, on="day").assign(  # events: day, note
    at=lambda d: d["day"] + pd.Timedelta(hours=12),  # the middle of its day's bar
    top=top, date=lambda d: d["day"].dt.strftime("%b %-d")))
(bars
 + ev.mark_rule(color=thimble.theme.pale).encode(x="at:T", y="merged:Q", y2="top:Q")
 + ev.mark_text(color=thimble.theme.accent, baseline="bottom", dy=-16).encode(x="at:T", y="top:Q", text="date:N")
 + ev.mark_text(baseline="bottom", dy=-3).encode(x="at:T", y="top:Q", text="note:N"))
```

## How it draws

`thimble.chart` shows a Vega-Lite chart (`application/vnd.vegalite.v6.json`, as Altair does) with its rows inline and no
color, font or size of its own. The card draws it in thimble's theme, as it draws every chart (frontend
`lib/vizTheme.ts` and `lib/chartDefaults.ts`), so these charts change with the theme and look alike. A mark that only a
job sets apart names that job as a Vega-Lite style, and the theme's `style` config gives it its look: `thimble-faint` (a
line's band of intervals), `thimble-box` (a box plot's boxes and a violin's body), `thimble-median` (their medians, in
ink), `thimble-overlap` (areas side by side, and density curves), `thimble-fit` (a scatter's fitted line, in ink unless
its group colors it), `thimble-span` (a range's line, muted), `thimble-end` (a range's ends, solid and larger than a
dot) and `thimble-hover` (an area's points, unseen and wider than a dot, which show its values on hover). An interval is
a rule, which the theme draws in its annotation ink. A bar is round at its end, away from its
baseline, by 2 px (`--viz-bar-radius`), and a stacked bar at the end of its whole stack; a box plot's box is square.
Dots that would overlap on their line, a dots chart's, a box plot's or a violin's, move across it, each only as far as
it needs, their values kept: a dot within 1.25% of the x axis's span of one already on the line moves 3.5 px up, else
down, then twice that. A dots chart whose groups stand side by side on a row's line keeps its dots on their lines. A
chart colored by a label takes the label's colors because the call notes the label as read (as `thimble.labels` does),
and the card gives a label it read its colors. The inline rows are the chart's table: the model reads them in the card's
output and a takeaway cites a value by column and row, as for any chart. Times without a zone show as they are, and
times with a zone at their zone's clock time. A bar, line or area chart whose times lie more than a day apart, such as
weeks, has a tick at each of them, up to 40, so the axis names the days its bars start on and its points stand on. A
heatmap's times are named as a date axis names them (`Jun 18`), while its rows keep them whole (`2026-06-18`). Its x
ticks stand between its columns, so names that read across close together each stand between two.

Panels one under another each get 150 px unless the chart sizes them, and a y axis that names each of its ticks (a
ridgeline's) gets room for every name (`lib/chartDefaults.ts`). The terminal draws a one-layer bar, line, point or
area chart from its rows, so a density of a few groups and an ecdf draw there as lines; a ridgeline, a violin, a box
plot, a range and a chart with a fit, an interval or marks show their rows as a table.

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

- `color`: Color by. The group or series column's values take Color by's colors, the colors of their records' bars,
  and the chart draws no legend, since Color by's chips are its key; a value with no color, as with Off or a value
  turned off, is gray. A page groups its records by `color.valueOf(record)` for that column.
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
