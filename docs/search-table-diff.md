# Search, tables, diffs and text in a view

Four parts of the view kit draw the records themselves, so a view looks like a system the analyst knows (an inbox, a
code forge's commit, a wiki page's history) in thimble's parts rather than parts of its own:

| part | call | what it is |
|---|---|---|
| the search | `thimble.search` | a box in the top row that finds text in the records, as Files' find does |
| the table | `thimble.table` | records in columns a click sorts by, for thousands of rows |
| the diff | `thimble.diff` | two versions of a text side by side or inline, the words that changed marked |
| the text | `thimble.text` | a record's text, such as a pull request's body or an email, as markdown or plain text |

Each works alone on any element with plain records: none needs Color by, a time range or the side panel. Each works
with the other parts of the kit when the page has them, through the same hooks as the rest of the kit
([color.md](color.md), [rows-and-filters.md](rows-and-filters.md)): a record's element carries its `data-anchor`, so a
label marks it, a ⌘-click asks about it and Color by draws its bar; Reset puts each back as the view opens; each draws
in the theme's tokens, light and dark. Their styles are the kit's (`thimble-search-*`, `thimble-table-*`,
`thimble-diff-*`, `thimble-text-*`): a page sets their width and place, never how they look (the view checks note a
rule that does).

## The search

`thimble.search({mount, in, placeholder, onChange})` puts a search box in `mount`, in the top row:

- Typing finds the text, case ignored, in the records under `in`, and goes to the first match at or after the top of
  what the list shows. Every match on the screen gets the find's wash and the current one a stronger one. The box says
  "3 of 120", or "No results".
- Enter or ↓ goes to the next match, ⇧Enter or ↑ to the one before, and the box's arrows do the same; the steps wrap
  at the ends. The list scrolls the current match into view. ⌘F (Ctrl+F) puts the focus in the box, and Escape
  empties it.
- The list's strip (the kit's scrollbar, [color.md](color.md)) gets a lane of ticks at its left, one per match, in the
  ink as Files' find draws them, and a click on a tick goes to that match. The loupe marks the records that hold one.
  Without Color by the list gets the kit's strip all the same: a plain scrollbar, with that lane alone while something
  is found.
- It finds the text a record shows, through its inline elements (a phrase across a link or a bold word is one
  match), and never in the kit's controls, the page's own wording around a record (`data-thimble-chrome`) or an
  action button (`.btn`).
- Reset empties the box. The search hides nothing: a page that wants to keep only the matching records asks
  `search.has(text)`, or passes `search.text` with its fetch for its reader to filter by, in `onChange`.

```html
<div class="top"><span id="search"></span><span id="colour"></span></div>
<div id="list"></div>
<script>
const search = thimble.search({ mount: '#search', in: '#list', placeholder: 'Search messages' })
</script>
```

| option | what it is |
|---|---|
| `mount` | an element or a selector in the top row, which the box fills; the page sets its width |
| `in` | the element whose records it searches, an element or a selector; the page by default. Its strip, or that of the box it scrolls in, gets the ticks |
| `placeholder` | the box's words while it is empty, `Search` by default |
| `onChange(search)` | the text changed, once typing pauses, or Reset emptied it |

| member | what it gives |
|---|---|
| `text` | the text searched for, `''` for none |
| `count`, `at` | how many matches there are (20,000 at most, the box then saying "+"), and the current one's place among them from 0 (-1 for none) |
| `set(text)` | the box's text set from the page, as if typed |
| `step(dir)`, `go(k)` | the next match (1) or the one before (-1), and match `k` |
| `has(text)` | whether a text holds what is searched for, case ignored; `true` while the box is empty |
| `rows({texts, refs, go, box})`, `rows(null)` | the rows of a list that draws only those in view (below) |
| `refresh()` | the matches found again, for a change the search cannot see; it finds them again by itself when the page draws anew |

### A list that draws only the rows in view

A list that draws only its rows near the view has the others nowhere on the page, so it gives the search every row's
text: `search.rows({texts, refs, go, box})`, `texts` each row's text as it draws it, with `'\n'` between parts drawn
apart such as cells (a match never spans them), `refs` each row's ref, so the current match stays on its row when the
rows are sorted again, `go(i)` to bring row `i` into view, and `box` the element that scrolls, whose strip gets the
ticks. The rows on the page carry `data-thimble-row="<i>"`, so the matches in the rows drawn are washed. The kit's
table does this itself when it is given the search.

### Text folded away

A part that folds text away, such as the diff's unchanged lines or the rest of a long text, keeps it in the page in an
element with `data-thimble-fold` and the `hidden` attribute. The search counts what it holds, ticks it where the fold
stands, and sends the element a `thimble-unfold` event when it goes to a match inside it; the part opens the fold
there, and the match shows. A hidden element without `data-thimble-fold` is not searched.

## The table

`thimble.table({mount, columns, rows, ...})` draws records in `mount` as the kit's `.table` looks, a caps head that
stays at the top and hairline rows, one line each with a cell's overflow cut by an ellipsis:

- It draws only the rows near its view and keeps those it drew as it scrolls, so a table of 50,000 rows opens and
  sorts in a fraction of a second. `mount` scrolls; the page gives it a height (`flex: 1; min-height: 0` in a column).
- A click on a column's head (or Enter on it) sorts by it: numbers and times the largest first, text from A; a second
  click the other way. The head shows the sort with an arrow. Rows with no value come last either way, and ties keep the rows' order.
  thimble keeps the sort per view, and Reset puts back the one it opens with.
- Each row is a record: its `data-anchor` is the row's `ref`. A label marks it, a ⌘-click asks about it, and
  `table.reveal(ref)` scrolls a cited row to the middle and highlights it for a moment. The view checks count every row
  the table holds as shown, since it anchors each row it draws.
- With the page's Color by, a row's value takes the bar on its left edge, the chips count every row (not only those
  drawn) while a field is the color, and the strip shows every row's color, scrolled to or not. The table draws its
  rows again when Color by changes.
- A click, or Enter on the chosen row, opens the row in `side` (`thimble.side`) and tells `onOpen`. ↑ and ↓ move the
  chosen row while the table has the focus, and an open side panel follows it.
- With `filter` (`thimble.filterBy`) it leaves out the rows Filter by does not keep; call `table.draw()` in Filter by's
  `onChange`. With `search` the search finds in every row (above).

```js
const table = thimble.table({
  mount: '#list',
  rows: emails,                                 // plain records, each with its `ref`
  columns: [
    { name: 'from', title: 'From', width: 180 },
    { name: 'subject', title: 'Subject' },
    { name: 't', title: 'Date', type: 'time' },
  ],
  sort: { by: 't', desc: true },
  side, search, filter,
  details: (m) => ({ title: m.subject, sub: m.from, render: (body) => (body.textContent = m.body) }),
})
```

| option | what it is |
|---|---|
| `mount` | the element the table fills and scrolls in |
| `columns` | the columns in order, each `{name, title, type, width, value, html, sort}` (below) |
| `rows` | the records, each with its `ref` |
| `sort` | how it opens, `{by, desc}` or a column's name; the rows' own order by default |
| `side` | a `thimble.side` that a row opens in |
| `details(row)` | what the side panel shows of a row: `{title, sub, html}` or `{title, sub, render(body)}`, or html alone; by default its first column as the title and every column's value whole |
| `search`, `filter` | a `thimble.search` that finds in every row, a `thimble.filterBy` whose kept rows show |
| `onOpen(row)` | a row opened, by a click or Enter |
| `key` | the name thimble keeps the sort under, the mount's id by default; give each table of a page its own |

A column is `{name, title, type, width, value(row), html(row), sort}`: `name` the field as the records hold it,
`title` its head (the name by default); `type` `'text'` (the default), `'number'` (right-aligned, in the mono face) or
`'time'` (seconds since 1970, shown as `2026-04-01 09:30` in UTC, with the seconds when the column's times have them;
a string as written); `width` px or a CSS track such as `'2fr'` (text shares what is left; numbers and times fit their
widest value); `value(row)` the value it shows and sorts by when it is not `row[name]`; `html(row)` the cell's markup
in place of its value as text; `sort: false` for a column a click does not sort.

| member | what it gives |
|---|---|
| `draw(rows)`, `draw()` | drawn with new rows, such as after a fetch, the sort and the chosen row kept; with none, drawn again, such as after Filter by changed |
| `reveal(ref)`, `open(ref)` | a cited row scrolled to, chosen and highlighted, or opened as a click opens it; `false` when no row shows it |
| `sortBy(name, desc)` | sorted by a column, as a click on its head without `desc` |
| `rows`, `sort`, `selected` | the rows that show in order, the sort (`{by, desc}` or null), and the chosen row's ref |

## The diff

`thimble.diff({mount, before, after, ...})` draws two versions of a text in `mount`, such as a wiki page's revision
against the one before or a memory file rewritten:

- The lines are aligned. A line removed is in a tint of the problem red with − before it, a line added in a tint of
  the positive green with +, and in a changed line the words that changed in a stronger tint of the same color.
- Side by side (`mode: 'split'`) the older version is on the left and the newer on the right, a changed line level
  with the line it became. Inline (`'inline'`) a changed line is the old line over the new one, each with both line
  numbers. `'auto'`, the default, is side by side in a mount 760 px wide or more, and inline in a narrower one such as
  the side panel or when one version is empty, as for a page created.
- Unchanged lines more than `context` lines from a change fold to one line, "120 unchanged lines", with Show more;
  Show less folds them again. A stretch of fewer than 4 lines shows. The folded lines stay in the page, so the search
  finds them and opens their fold.
- The line numbers and the signs are drawn by the style alone, so the search never finds them and a copy or a quote
  holds the text alone.
- `ref` names the newer version's record, which the diff carries as its `data-anchor`: a label marks it, a ⌘-click
  asks about it, and a citation's quote is found inside it.

```js
const diff = thimble.diff({ mount: '#diff', before: older.text, after: newer.text, titles: ['Revision 41', 'Revision 42'], ref: newer.ref })
diff.set({ before: newer.text, after: next.text, ref: next.ref })   // the next pair
```

| option | what it is |
|---|---|
| `mount` | the element the diff fills |
| `before`, `after` | the two texts; `null` or `''` for none, as for a page created or deleted |
| `mode` | `'auto'` (the default), `'split'` or `'inline'` |
| `context` | the unchanged lines kept beside a change, 3 by default |
| `titles` | `[older, newer]`, the two versions' names over their columns (inline, on one line) |
| `ref` | the newer version's record, the diff's `data-anchor` |

| member | what it gives |
|---|---|
| `set({before, after, mode, context, titles, ref})` | any of them changed and drawn at once; a new pair folds its stretches again |
| `expand(on)` | every fold opened, or with `false` folded again |
| `mode` | the mode drawn, `'split'` or `'inline'` |
| `added`, `removed`, `changes` | the lines added and removed (a changed line counts in both) and the stretches of changes, for the page's own header such as "+12 −3" |

A history of revisions draws a diff per revision in its own element, each its revision's text against the one before;
a long history draws the diffs of the revisions near its view, as a list draws its rows.

## The text

`thimble.text(mount, text, {format, ref, mentions, fold})` draws a record's text in `mount`, such as a pull request's
body, a comment, a post, an email or a wiki page, and returns its element. `thimble.text.html(text, opts)` gives the
same as html, for a part that takes markup: `recordCard`'s `{html}`, a table column's `html` or the side panel's
details.

- `'markdown'`, the default, is CommonMark with GitHub's tables, task lists (as disabled checkboxes), strikethrough,
  autolinks and footnotes, drawn as the File browser draws a markdown file: headings in the body face at three sizes,
  code in mono on a light tint of the ink, a table as the kit's `.table`, a quote indented in the secondary ink. The
  text takes the face, size and ink of the element around it.
- Raw HTML in the text shows as text, never parsed. An image is not loaded: its alt text shows in a neutral chip.
- A link to a URL shows its address on hover and opens nothing, since a view has no network. A link to a corpus path,
  such as `[the run](runs/r3.jsonl#L88)`, or to a view's unit, `view:<slug>/<key>`, opens with `thimble.navigate`; a
  relative path is read from the folder of `ref`'s file, as a browser reads it.
- `'plain'` is the text as written, its line breaks kept and its URLs links, for an email or a log.
- `mentions` turns words that name a record into links that open it with `thimble.navigate`, such as a forge's `#123`
  or a board's `@agent-08`. Each is `{match, ref}`: `match` a regular expression, `ref(m)` the ref for its match `m`,
  or null to leave it as text. Code and links keep their text.
- `fold` folds a text longer than that many lines after its first `fold` lines, with Show more and Show less: 12 in
  `html()`, none in a mount, `0` for none. A long line counts once for every 100 characters, as it wraps, and a fold
  hides 4 lines at least. The folded text stays in the page, so the search finds it and opens the fold, as a
  citation's quote does. Opened, the text shows as it was drawn, a list's numbers and a table's columns kept.
- `ref` is the text's record, its `data-anchor`: a label marks it, a ⌘-click asks about it, and a citation that quotes
  the record's source word for word, its `**`, backticks and list markers included, is found in the rendered text.
- A click on a link or on Show more, or Enter on it, does only that, so a card the text is in does not open as well.
  In a table's cell the text runs on as one line, and in a card's body, which shows its first lines, it has no Show
  more.

```js
const mentions = [{ match: /#(\d+)/g, ref: (m) => 'view:forge/pull/' + m[1] }]
side.open({ title: pr.title, ref: pr.ref, render: (body) => thimble.text(body, pr.body, { ref: pr.ref, mentions }) })
col.innerHTML = prs.map((pr) => thimble.recordCard({ ref: pr.ref, title: pr.title,
  body: { html: thimble.text.html(pr.body, { mentions, fold: 0 }) } })).join('')
```

| option | what it is |
|---|---|
| `format` | `'markdown'` (the default) or `'plain'` |
| `ref` | the text's record, its `data-anchor` |
| `mentions` | `[{match, ref(m)}]`, the words that open a record |
| `fold` | the lines shown before Show more: 12 in `html()`, none in a mount; `0` for none |

Without the built interface, as in a checkout that was not built, markdown shows as plain text.
