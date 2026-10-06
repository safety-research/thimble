# thimble-cc-mod's terminal: the visual system and the views contract

Two parts. **The visual system** says how every surface of the mod draws on Claude Code's character grid: the
panels, main's chat, cards and the rows above the prompt. **Views**, from "Views" on, is the contract a view's
builder, the checks, the reviewer and the panel code against. The builder reads both parts.

## The visual system

The terminal has one typeface and one size, so position and space carry the structure that type sizes carry on paper,
and weight and colour are kept rare so that each one means a single thing. The system follows two books: Josef
Müller-Brockmann, *Rastersysteme für die visuelle Gestaltung / Grid Systems in Graphic Design* (Niggli, 1981), for
columns and intervals fixed in whole units of the text, and Emil Ruder, *Typographie / Typography* (Niggli, 1967), for
space that follows meaning and contrast that is read only when it is rare. These rules apply to everything the mod
draws. Claude Code's own drawing (its `❯ ⏺ ✻ ⎿ ✕`, tool rows, Markdown in replies the mod does not draw) is outside
them. Colours are in `hooks/paint.ts`; `hooks/draw.ts`, `viewdraw.ts`, `home.ts`, `cite.ts`, `register.tsx`,
`reports.tsx`, `harness.tsx` and `player.tsx` draw.

### 1. Channels

Each channel has one meaning. A run the table does not cover is regular, in the text colour, on the panel's
background.

| channel | its one meaning | never used for |
| --- | --- | --- |
| position | what kind of thing a run is: the column it starts on (section 2) | |
| a blank row | the end of a group | spacing inside a group |
| a rule `─` | the end of a region that scrolls or changes on its own | the line under a heading or under column names |
| **bold** | **new**: it arrived since the analyst last opened it | titles, headings, column names, names, values, the current item |
| dim | secondary: read after the thing it belongs to | a name, a number in a number column, a flagged value, a control |
| underline | a link to evidence: a citation, the place after `↗`, a URL | hover, controls, names a click selects |
| italic | a record's own words, quoted among the model's or the mod's words | emphasis, captions, edge labels, definitions |
| inverse | the focused control: the one a click or return acts on now | anything at rest |
| selection background | the current or chosen one | hover, emphasis |
| palette hue | a value of the region's one colour field | letters, headings, backgrounds, states |
| red | a problem | negative numbers, hover, anything that is not a problem |

### 2. The grid

The horizontal unit is the cell and the indent step is 2 cells. The vertical unit is the row.

**A panel's columns.** The type area starts 1 cell inside the pane's left border and ends 1 cell before its right
edge; its width is T.

| axis | column | holds |
| --- | --- | --- |
| A0 | the type area's first cell | a region's title, group headings, a chart's left edge, hanging marks (state glyphs, tree guides) |
| A2 | A0 + 2 | item text, secondary text, prose |
| A4 | A0 + 4 | a nested item (a question's cards, a tree's child) |
| L | where the label column starts + its width (the longest label + 2) | the values of label/value rows |
| R | the type area's last cell | the right edge of the last number column, and of a region's controls |

1. **Axes.** A run that opens a row starts on A0, A2, A4, L or a table's column. Two indent steps at most. A tree
   deeper than A4 (threads asked from threads, lanes under a parent) goes on with guides `├ └ │`, 2 cells a level,
   the only place text starts right of A4.
2. **Marks hang.** A state glyph or a tree guide sits in the 2 cells left of the text it marks, so text keeps its
   axis with or without one. A list whose items have no state leaves the glyph cells empty.
3. **Space.** 1 cell is a word space, inside a phrase. ` · ` parts the items of one inline list of facts about one
   thing. 2 cells are a gutter: between columns, a label and its value, facts and controls, two controls. A gutter
   is never 1 cell, and a phrase never gets extra spaces to line something up.
4. **Columns.** The name first, then categories, then numbers, then free text, so the ragged edge falls at the end
   of the row. Text columns align left; number columns align right, each on its own axis, the last on R. A unit
   shared by a column goes in the column's name (`records`), not in each cell. Space alone parts columns, never `│`.
5. **Shared axes.** A component works out its columns once for all its groups, and the sections of one panel share
   A0, A2, their category column and R.
6. **Label/value rows.** The label is dim, lower case, with no colon, in a column as wide as the block's longest
   label + 2; values start on L. Numbers in a block align right on the widest. A value that is a list puts each
   item on its own row, `-` on L and the text at L + 2. At 80 cells and wider a block of fields runs as two blocks
   side by side, the second at A0 + ⌈T/2⌉, filled row by row.
7. **Measure.** Prose the mod wraps (a reply, a thread's answer, a report, a definition, a detail's text) wraps at
   72 cells, or the type area when that is narrower; the cells to its right stay empty. Tables, charts, lanes and
   strips take the whole type area.
8. **Flush left, ragged right.** Nothing is centred or justified: no heading, empty state or control. Only numbers
   and a region's controls sit against R.

**The chat column**, where the mod draws in Claude Code's transcript, uses the columns Claude Code already has:

| column | holds |
| --- | --- |
| 0 | marks: Claude Code's `❯ ⏺ ✻`, the mod's `↳` |
| 2 | the session's text: Claude Code's tool rows and prompt, the mod's notice rows, a `↳` row's words, the labels of the rows above the prompt; a reply's headings and its `?` |
| 4 | a reply's text: its prose, a list's `-`, cards and footer |
| 6 | a list item's text, a quote block |
| 12 | the values of the rows above the prompt |

A reply is a panel's grid moved over: its A0 is column 2 and its A2 column 4. In the panel (a report, a side
thread's answer) a reply takes the panel's own grid: its headings at A0, its text at A2, the `?` of a passage at A0; a
heading there has no `?`.

**Rows.**

9. No blank row inside a group, one between groups, never two, none at the top of a region.
10. A rule divides regions that scroll or change on their own: a panel's header from its body, the body from the
    detail or controls under it, two at most. It spans the type area exactly, in the rule grey, and stands in place
    of a blank row: no blank row is ever next to a rule.
11. A card in a stream (a reply, a report, the player) has a rule above it and one below, as wide as the card, and no
    side borders; its text stays on the stream's text axis.
12. Every item of a list takes the same number of rows: one, or a title row and a secondary row. The selected item
    may open more under it, and a transcript's turn takes its speaker's row and up to three rows of text.

### 3. Type

13. **Regular** is the weight of every run that rule 14 does not make bold.
14. **Bold means new**: the item arrived since the analyst last opened it. That is a side thread with an answer not
    yet read, a view built and not yet opened, a report written and not yet opened, a label run finished and not yet
    opened. Its name is bold wherever it shows (home, the rows above the prompt, a step of the path, a `↳` row), and
    so is an `N new` count. Opening it clears the bold. A drawing with nothing new has no bold. The mod draws the
    model's `**…**` and its headings regular, and every Button `plain` (Claude Code draws any other as a bold
    `[ label ]`). Claude Code draws a Button's label regular whatever its props, so where the new item's name is a
    Button (a step of the path, a `↳` row, the views row, the threads tree) the word `new` follows it in bold.
15. **Dim means secondary**: labels and units, the count after a heading, times, places, the `·` and `›`
    separators, axis labels, the counts in a legend, secondary rows, `○`, a script's comments, rows outside the
    zoom, and every mark no colour names (rule 20).
16. **Underline means a link to evidence**: a citation's value, the place after `↗`, a URL. A citation keeps the
    text colour. Names, rows and headings that a click selects or opens are not underlined; their place says so.
17. **Italic means a record's own words** quoted among the model's or the mod's: an example card's and a label's
    records, a quote block in a reply or a report. Views and the file browser draw records upright, since
    everything in them is a record's.
18. **Inverse means the focused control**: the citation, control word or card mark under the pointer, or the control
    with the keyboard focus. A citation's tip (its place and status) is drawn in inverse on the row above it, or
    below it when the citation is on its paragraph's first row. Rows
    have no hover state; the passage or row under the pointer shows its `?` where a thread can be asked about it (a
    reply's passage, a view's row).
19. No blink, strike-through or capitals for emphasis. Kind words, labels and steps of the path are lower case,
    names are as written, headings are in sentence case.

### 4. Colour

| colour | theme key | drawn on | means |
| --- | --- | --- | --- |
| text | `text` | letters and controls; state glyphs | content |
| dim | `inactive` (`dimColor`) | letters (rule 15); every mark no colour names (rule 20) | secondary |
| rule grey | `subtle` | lines only: rules, tracks, axes, tree guides, a diagram's boxes and edges | structure |
| palette | `SERIES`, seven hues that keep 3:1 on both panels | `●`, marks, bars, strips, swatches | a value of the colour field |
| red | `error` | a problem's words and its `×` or `!` | a problem |
| selection | `selectionBg`, a background | the current or chosen one | rule 21 |
| panel | `composerSidebarBackground`, a background | the whole panel | |

20. **One colour field per region**: a card's group or label, a view tab's colour field, a transcript's speakers, a
    report's highlight sets. While a label is on, it is that field. Its hues go on glyphs and marks; a value's word
    stays in the text colour (`● dse 3,908`). A field colours at most six values, past which its marks are drawn in
    the text colour (lanes and transcripts cycle the hues). A label's catch-all last value ("other"), and the rows the
    label that is on does not mark, take dim marks, and so does every mark of a chart with no colour field: a mark is
    in a hue when a colour names its value and dim when none does, never in the text colour, so a bar is never the
    heaviest thing on the screen. A strip's bins outside the zoom are drawn in the rule grey. A label that colours a
    card names its values on the card's label row, and no legend under the chart repeats them.
21. **The selection background** marks the current or chosen one among things shown together: the selected row or
    mark, the active tab, the layout in use, a card's parameter in use, a filter value or label that is on, the cited
    value in the citation panel, the passage or mark the open menu acts on, text being dragged. Nothing else has a
    background: no band behind tags, no grey behind the row under the pointer, no tip box.
22. **Red** marks a problem and only a problem: a failure, a value a view's `flag` names, a citation whose value is not
    at its place, lines a reader could not parse, problems a review left, a check that failed, a report's warning or
    caution. There is no warning colour; the glyph tells the two kinds apart (`×` failed, `!` usable with a problem).
    Negative numbers are drawn as positive ones are, on the other side of the axis.
23. No other colour: no link colour, code colour, success green, warning amber or accent. Inline code is text. A
    script is text with its comments dim.

### 5. Symbols

One glyph, one meaning, everywhere. A glyph and a word that say the same thing are never drawn together (`○ Wiki
Pages`, not `○ Wiki Pages proposed`). Besides the words of the corpus and the model, the mod draws no non-ASCII
character outside this table. New has no glyph: it is bold (rule 14).

| glyph | its one meaning | colour |
| --- | --- | --- |
| **state**, one per item, hanging at A0 | | |
| `○` | not started: proposed, stopped, queued, a file never opened | dim |
| `◌` | running: building, checking, answering, writing, verifying | text |
| `●` | one thing that is there: an item built, answered, written or read, a value's swatch in a legend, a record's mark (an example card's, a timeline's, a lane's) | a state: text; a mark: the hue of its value when a colour names it, else dim |
| `!` | usable with a problem: problems left after review, a flag's later values | red |
| `×` | failed: a build, a check, a call; a flag's first value | red |
| `✓` | confirmed: a script recomputed the cited value, the analyst agreed with a record | text |
| **navigation** | | |
| `›` | into: opens one level in (`details ›`); between steps of the path (`home › views`) | text; dim between steps |
| `‹` | back one level (`‹ back`) | text |
| `↗` | a place in the corpus, whose record a click opens; the place after it is underlined | text |
| `↳` | a side thread asked from what is above it | dim |
| `?` | ask a side thread about this passage or row | text |
| `▶` | play | text |
| **data** | | |
| `◆` | three or more marks in one cell | text |
| `█` and `▏▎▍▌▋▊▉` | a bar and its last eighth | hue or dim (rule 20) |
| `▁▂▃▄▅▆▇█` | a strip's bins | hue or dim; rule grey outside the zoom |
| braille | a line chart's lines | hue or dim |
| `─ │ ├ └ ┤ ┬ ┴ ╭ ╮ ╰ ╯` | lines: rules, tracks, axes, tree guides, a diagram's boxes | rule grey |
| `→ ← ↓ ↑` | the direction of a diagram's edge | rule grey |
| `┊` | the pointer's column on a chart | rule grey |
| `▼ ▲` | the column a table is sorted by, largest or smallest first | dim |
| **text** | | |
| `…` | text cut short | as the text |
| `… N more` | N rows not drawn; a click draws them | dim |
| `+N` | N values not drawn in a cell; a click shows them | dim |
| `·` | between the items of one inline list | dim |
| `"…"` | the analyst's own words (a side thread's question) | text |
| `-` | an item of a list, on the text's axis with the item 2 cells in | text |

No longer drawn: `✗ ◇ ▸ ▾ ■ □ ━ ┃ • ⌕ ✕ ❚❚ ⓘ ✦ ❢ ⚠ ≡ ╱ ▤ ❝ ┿ ∴ ▪`, the braille spinner, and `[ ]` around controls.
`▍` and `▆` are drawn only as a bar's eighth and a bin, `▶` only for play, `›` only for into.

**Words that recur.** A place reads `revisions.jsonl line 10566` or `lines 3-8`, never `#L`. A count reads with
thousands separators from 1,000 (`3,908`) wherever the mod draws it; a number that names a thing (a line, a year, an
id) reads as written. No hex or hash ids, and no file name made of a timestamp or a hash: a script is named by its file
name when that is a name, else "the script".

### 6. Controls

24. A control is a word or a few, in the text colour and plain: no brackets, bold, colour or underline at rest, inverse
    while focused. Its words say what it does (`verify`, `ask about it`, `run again`), never which key does it: no
    `b:` or `o:` prefixes, no column of hints, no line that says what a click does. The keys stay bound: each is a
    Button with no label of its own, in a Box no row tall at the top of the panel (`hiddenKeys` in register.tsx).
25. Controls come last on their row. On a row of a fixed type area (a panel's, a card's) they are one block against
    R, 2 cells apart; on a reply's footer they follow its facts after a gutter.
26. An empty region shows `none`, dim, at A2.

### 7. Surfaces

The sketches are rows as drawn; what is bold, dim or coloured is said under each.

**A panel's header**, the same on every panel:

```
‹ back  home › views › Wiki Pages                               threads  1 new
Wiki Pages  4,579 pages · 4 wikis                                     1 file ›
──────────────────────────────────────────────────────────────────────────────
```

- The path row: `‹ back`, a gutter, then each step as a lower-case kind word and its name (`thread "how many…"`,
  `citation 5884`, `card How many pages…`, `label edit purpose`, `files`, `labels.jsonl`, a view's name), parted by
  a dim `›`, a long step cut with `…`. A step whose thread has new answers is bold; one whose thread is answering
  starts with `◌`. At R: `threads`, and `N new` in bold when there are new answers.
- The title row: the subject's name, regular; its stats after a gutter, dim, parted by ` · `; a problem count in red
  (`3 unreadable lines`); the region's controls against R. When they do not fit one row, the stats go to the next
  row at A0.
- No `[ close ]` row: Claude Code's `✕` and the `x` key close the pane.

**The rows above the prompt:**

```
  threads   1 new · 1 answering                                                        [-]
  views     ● Wiki Pages  ◌ Usernames Over Time  ○ Edit Bursts  files ›
  coverage  read 4 of 4 files · <0.1% of records · <0.1% judged by a label  details ›
```

- Labels dim at column 2, values at 12. `1 new` bold. A view: its state glyph and name, the views 2 cells apart, a
  built view's name bold until it is opened. Claude Code's own `[-]` against the right edge folds the rows (the
  band above the prompt is the engine's); the mod draws no control of its own for it.
- A row shows only while it has something: threads while one is new or answering, views while one is proposed.

**Main's chat:**

```
⏺   The three cards are below. The dse wiki holds most of the corpus, and
    most of its edits came on one day, 18 June.

  dse has most of the pages
    ──────────────────────────────────────────────────────────────────
    How many pages does each wiki have?
    …
    ──────────────────────────────────────────────────────────────────
    dse has 3,908 of the 4,579 pages, about 85%.

    13 citations · 2 cards  ask about this answer ›  ▶ play  open as report

↳ thread · "How many delete events are in events.jsonl?" · answered
  label · "edit purpose" · prompt · trial of 30
```

- A heading hangs at column 2, a blank row above it and none under it; every Markdown level draws alike. A list's
  `-` or number at column 4, its text at 6. A quote block in italic at column 6. Prose wraps at 72 (rule 7).
- A citation is its value, underlined; once verified a `✓` follows it; a value not at its place is red.
- The `?` of the passage under the pointer at column 2.
- The footer, one blank row under the reply: its facts dim, its controls after a gutter, no file path.
- A `↳` row: `↳` at 0 and its words at 2, dim (`thread · "question" · answered`); the question bold while the answer
  is new; `failed` red.
- A notice row, what a mod tool call or subagent did: dim at column 2, no glyph before it.

**Cards**, alike in the chat, the card pane, a report and the player:

```
────────────────────────────────────────────────────────────────
How many pages does each wiki have?                  dorfwiki  2
dse       ███████████████████████████████████████████████  3,908
probier   ███████▎                                           601
dorfwiki  ▏                                                    2
all  4,579
────────────────────────────────────────────────────────────────
```

- The title row: the card's question at the card's A0. The mark under the pointer has its label in inverse and its
  value in the readout at R.
- A parameter row under it: the parameter's name dim, its choices 2 cells apart, the one in use on the selection
  background.
- Bars: labels in a column at A0, bars from L, numbers against R. A part of a whole (a label's shares, coverage)
  runs on a `─` track to the whole; a count has none.
- A legend on its own row under its chart at A0 (the total, `all  4,579`, has its own row above it): `● value` entries
  2 cells apart, a count after its value by one space, dim. A label that colours the card names its values on its
  label row instead.
- A line chart: y labels right-aligned in a column, axes in rule grey, x labels dim at the ends and the middle; the
  pointer's column `┊` with its readout at R.
- A table: column names dim, no rule under them. A timeline: the axis with its `●` marks, then an event per row, its
  time in a dim column at A2, its words, a bare `↗`; the axis from A0 to R with its end times under its ends. A
  diagram: boxes and edges in rule grey, node text in the text colour,
  edge labels dim, a note's number in a dim column at A0 and its text dim. Card kinds have no glyphs.
- In the card pane the card's question is the panel's title row, the rule under it; the card's last row is
  `made by <script>` (the script's file name), dim, with `script  run again` against R. The script view lists the code
  with dim line numbers and comments, and no sha.
- In a stream a card's rules stand in for blank rows: no blank row above its top rule or under its bottom one. A
  report's figure caption is dim on the row under the bottom rule, at the measure.

**Records**, in an example card, a label card and the label panel:

```
● links or data  ↗ revisions.jsonl line 10566                agree  disagree
  SEC download county JSON https://www.sec.gov/files/county.json?download …
  why  The body is mostly URLs to the SEC's county file, with a short note.
● message to agents  ↗ revisions.jsonl line 1510             agree  disagree
```

- `●` at A0 on each record's first row, in the value's hue (dim in an example card no label marks), so the records
  part without blank rows; the value and its place on the first row, the controls against R; the record's words in
  italic at A2, up to three rows; the `why` row dim. No blank row between records. Grouped by value (the label panel),
  each group under a heading, the records' first row `↗ place` at A2 with the controls against R.
- After the analyst's verdict the controls give way to `✓ agreed`, or to the value they set and `✓ set by you`.

**Home:**

```
‹ back  home                                                          threads  1 new
Home  1 view · 1 report · 2 threads · 12 cards · 1 label · 4 files    stacked  index
────────────────────────────────────────────────────────────────────────────────────
Views  1
● Wiki Pages                                               reviewed · 10 fixed
  pages.jsonl · one row per wiki page

Side threads  2  1 new
● "How many delete events are in events.jsonl? One number."
  about the last answer · earlier session
● "Which wiki got the most revisions on 18 June, and from how many labels?"
  about the last answer · earlier session

Cards  12
  On 18 June, agents rewrote the dse wiki's welcome page…  report            4 cards
    How many dse revisions came each hour on 18 June…      line
    Which labels saved the dse welcome page most…          table
  … 9 more

Files  4                                                                     records
● revisions.jsonl                                                             14,591
  14 read · lines 1-3, 305, 1007 and 9 more
○ labels.jsonl                                                                 3,104
```

- The first side thread's row is bold (its answer is new), and so is `1 new`; nothing else is.
- A heading: its name at A0, its count dim after a gutter, a blank row above it, no marker; a click on it opens the
  section's own panel. A section shows its first items, then `… N more`.
- An item: its state at A0, its name at A2, categories in the panel's shared column, numbers against R, its
  secondary row dim at A2. A question's cards at A4, their kind as a word in the category column.
- `index` sets the sections in two columns, the second at A0 + ⌈T/2⌉, each section's heading and first items.

**Lists and trees** (the threads, reports and views panes, the menu) take home's item rows: state at A0, name at A2,
a dim secondary row that leaves out what the glyph says (`1 question · about the last answer`, not `answered · …`;
`8 cards`, not `written · …`). The threads pane groups by where a thread was asked (`main  2`), and a thread asked from
a thread hangs under it after `└`. The reports list's secondary row is `document · 7 sections · 8 cards`. The views pane lists
the proposals as items with the chosen one's purpose as prose at A2 and its fields as label/value rows under the
second rule and `build again
review again  open` against R. The menu's title row names its target; its items are at A2, one per row, each saying
what it does (`open its lines`, `open in files`, `ask about it`, `verify`), the focused one in inverse.

**Tables** (a view's, a file's, a table card's): the row's glyph at A0 and its name column at A2, regular; column names
dim on the row above, with `▼` or `▲` after the sorted one; numbers right-aligned with separators; free text last. A
group: its heading at A0 with its count dim and a blank row above, its rows keeping their columns; folded, its heading
and `… N more`. The selected row is on the selection background across the type area; the row under the pointer shows
`?` against R. A view's records leave 3 cells at R for that `?` and its gutter, so their last number column ends 3
cells before R; the view's header, filter row, rules, overview and detail take the type area whole.

**A view** (Views, below, for what each part holds):

```
‹ back  home › Wiki Pages                                              threads
Wiki Pages  4,579 pages · 4 wikis                                     1 file ›
Pages  Editors
search  filter  wiki · revs · editors · first stored · labels      4,579 pages
──────────────────────────────────────────────────────────────────────────────
pages by week first stored
3,163 ┤                                                █
    0 ┤ ▂▁▁▁▁▃▁▁▁▁▁▁▁▂▁▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁█▁▁▁▁▁▁▁▃▁▁▁▁▁▁▂▁▁▁▁▁▁▂
        18 May                           8 Jun                          29 Jun
● dse 3,908  ● probier 601  ● fractal 68  ● dorfwiki 2

  page                        wiki     revs ▼  editors    IPs  chars, all revs
● WillkommenImWiki            dse       2,327      342  2,036        7,218,730
● StartSeite                  dse         456      293    434        1,040,151
──────────────────────────────────────────────────────────────────────────────
● WillkommenImWiki                                  ↗ pages.jsonl line 3804  ?
  wiki dse · first stored 18 Jun · page id dse/WillkommenImWiki
  revisions          2,327             IP /16 prefixes        139
  earlier revisions      8             chars, all revs  7,218,730
```

- The active tab is on the selection background. The filter row: `search` (the query while typing), `filter` dim,
  the fields parted by a dim ` · `, `labels` last, the rows counted against R. A field's values open on the row under
  it as `value count` (the count dim, a colour field's values after their `●`), 2 cells apart, the ones on on the
  selection background, then `+N`. The filters that are on stand on a row of their own, each `field value` on the
  selection background, `clear all` against R; a click on one turns it off.
- The overview under its title row, dim at A0; a blank row; the records; the detail under the second rule.

**The file browser**: a group per folder (`collusion-wiki/  4`), a row per file with its kind's `●`, its name, kind,
records and size. A file's path is `home › files › labels.jsonl`; its title row is its name and `3,104 records ·
3,104 lines`; its tabs `Table  Raw`. Raw draws the lines' numbers right-aligned in a dim column and the text after a
gutter, with `earlier` and `later` as controls.

**The label panel**: the title row is the label's name with `prompt · a trial on 30 of 14,591 records ·
revisions.jsonl` dim and its controls against R; the definition as prose at A2; the values' bars (a part of the whole,
on tracks, the catch-all's dim), each with its count and its share dim; `card` and the card's question with `›`; the
second rule; the records grouped by value.

**A report**: the title row is its title (wrapped at 72 if long) with `document · 7 sections · 47 citations · 8 cards`
dim on the next row; `Contents` as a heading with the sections' numbers right-aligned in a dim column at A2. A section's
heading at A0 with a blank row above and `verify` against R; its prose at A2; its cards at A2 between rules, a caption
dim under each. A callout: its kind (`note`, `tip`, `important`, `warning`, `caution`) as a dim label at A2 and its
text on L, `warning` and `caution` red. A highlight set's passages: a `●` in the set's hue at A0 on each passage's first
row. Tallies read as words (`12 verified · 1 failed`, `1 failed` red). No `▍`, no file path.

**The citation panel**: the title row is the cited value, then its status dim (`the value is at its place`), or red
when it is not, `✓` after the value once a script recomputed it, and `verify  ask about it` against R. Under the rule,
label/value rows (`from`, `in`, `output`), a blank row, then the lines: their numbers right-aligned in a dim column at
A2, the cited line's number in the text colour and the cited value on the selection background. A verification's
script follows as code. A card value's citation draws the card with the cited mark on the selection background. The
follow-up field: `follow-up` dim and an empty field. Every field the mod draws is labelled so (`ask`, `highlight`,
`definition`): its label dim and lower case before it, a gutter, no colon.

**The coverage panel**: a row per file with its state (`●` read, `○` never opened), its name, a bar of what was read on
a track that takes the room the name and the numbers leave, its records and the share read against R; a secondary row
of the lines read (line numbers as written); after a blank row, `all` dim with the corpus's records and the share seen,
and no note under it. **The player**: the title row is
`2 of 4`, a progress bar on a track, `0:08 of 0:26`, and `▶ play` (or `pause`), `back`, `next`, `restart` against R;
each scene is drawn as main's chat draws it.

### 8. Checks

Testable against what the mod draws (`render_view.mjs --check`, the home and card fixture tests, the lab's ANSI
captures):

1. A drawing of a state with nothing new has no bold.
2. No two blank rows in a row; no blank row next to a rule.
3. Every rule is as wide as its type area (a panel's, or a card's).
4. Every run that opens a row starts on A0, A2, A4, L, a table's column or a tree's guide.
5. Columns are parted by 2 spaces or more.
6. No letters in a palette hue; letters in red only for problems; no letters in any other colour.
7. No background but the panel's and the selection's; no inverse but on the focused control.
8. Prose the mod wraps is at most 72 cells wide.
9. Every non-ASCII character the mod draws, outside the corpus's and the model's words, is in section 5's table.
10. No centred row: none whose only run starts more than 4 cells past A0 with as much empty space after it.

## Views

A view shows the records of a folder in a form their files hide, drawn as text in the mod's panel. It follows
thimble's view pipeline (`prompts/dev-view.md`): a reader in Python finds the records, and a declarative spec says how
the panel draws them. The model fills the spec; the mod validates it and draws it on the grid above. No model writes
drawing code.

The code is in
`hooks/viewspec.ts` (types and validation), `hooks/viewdraw.ts` (layout, state and acts), `hooks/views.tsx` (the
panel's Client), the views block at the end of `hooks/register.tsx`, and `tools/render_view.mjs` (the same drawing
printed as text). The three worked examples are thimble's own, in `viewers/{timeline,linked-sessions,repository}/`:
each holds what a built view holds (`reader.py` with the `rows` query, `view.json`, `rows.json`), with thimble's
`sample/` and `labels.json` it was built on and a `design.md` of what thimble's page shows and how the terminal draws
it. `tests/fixtures/views/` holds trimmed rows of an earlier version of them for the drawing's own tests.

## Files

A view lives in `.thimble-cc-mod/views/<slug>/` of the folder:

| file | written by | holds |
| --- | --- | --- |
| `reader.py` | the builder | the reader (below) |
| `view.json` | the builder | the spec (below) |
| `rows.json` | the reader's runner | what the reader returned (below) |

`<slug>` is lower case letters, digits and dashes, at most 41 characters, and equals the spec's `slug`. The pipeline
may keep its own files (a proposal, check results) beside these; the panel reads only `view.json` and `rows.json`,
again whenever either file changes.

## The reader

The reader keeps thimble's contract (`plugin/viewers/*/reader.py`), with one query the panel uses. It runs with the
folder as its working directory.

- `build_index(paths)`: the claimed files' paths; returns the index. Read every claimed file whole with `open()`, as
  thimble's check counts.
- `records(index, {"op": "rows"})`: every row the view draws, as `{"collections": {<name>: [row, ...]}}`. A row is a
  flat JSON object: strings, numbers, booleans, null, or a list of those. Each row has a key unique in its
  collection and a `ref`, the place it cites (`<path>#L<n>`, `<path>#L<a>-L<b>`, `<db>#<table>/<key>`,
  `<csv>#row=<n>`, `<json>#/<pointer>`). The panel holds every row at once: past about 50,000 rows, aggregate in the
  reader (a session's calls counted, not listed), and keep the rows under 10 MB in all, a long text cut to the 12
  lines the detail draws or left out, since the row's ref opens the whole record.
- A row that stands for several records (a unit: a session, a pull request, an incident, a tool call's two lines)
  lists their refs in `refs`, so a label marks the row when it marks any of them, as thimble keeps a unit when
  `kept_unit` holds for its records.
- `problems(index)`: `[{"ref", "why"}]`, the lines the reader could not parse. The title row shows them as "N
  unreadable lines", only when there are some.
- `hidden(index)`: `[{"path", "why"}]`, claimed files left out on purpose.
- `unplaced(index)`: `[{"ref", "why"}]`, records read but not drawn (a reference to a row that is not there).
- `resolve(index, locator)` as in thimble, for citations into the view. The fields the reader makes rather than reads
  are declared in the spec (`derived`, below).

The runner, `python3 helper/viewhost.py <folder of reader.py and view.json> rows --root <corpus> --out rows.json`,
writes `rows.json`:

```json
{
  "collections": {"events": [{"ref": "alerts/a.jsonl#L3", "time": "2026-05-16T07:41:00Z", "source": "alert", "text": "..."}]},
  "problems": [{"ref": "agents.log#L38", "why": "not a log line of time, level, agent and key=value pairs"}],
  "hidden": [],
  "unplaced": [],
  "files": 39,
  "labels": [{"id": "label-1", "name": "Database connections", "values": ["connections", "other"],
              "marks": {"alerts/a.jsonl#L3": "connections"}, "colours": {"connections": "#2f7de1"}}]
}
```

When the rows take more than 3.5 MB, the runner writes rows.json in parts (Claude Code's hooks read at most 4 MiB of
a file): rows.json then holds everything but the rows, its collections empty, and `parts`, the names of files
`rows-<n>.json` beside it, each `{"collections": {...}}` with a slice of the rows in order. The panel and
`render_view.mjs` put them back in place.

`files` is how many files the reader read. `labels` are the labels over the view's files, each with its values (the
first is the one counted and filtered on), each marked record's value by its ref (`marks`), and each unit's by
`<collection>/<key>` (`units`: the first value when any of the unit's `refs` has it); `colours` is optional. The
view draws labels; only the analyst turns them on.

## The spec (`view.json`)

```json
{
  "version": 1,
  "name": "Timeline",
  "slug": "timeline",
  "description": "One sentence: what the view shows.",
  "scope": ["alerts/*.jsonl", "chat/*.json"],
  "collections": [ ... ],
  "stats": [ ... ],
  "tabs": [ ... ],
  "labels": true,
  "accepts": [{"form": "L<n>", "means": "the event on line <n>, selected in its list"}],
  "units": [{"form": "<incident>", "means": "one incident's events"}]
}
```

`scope` are the globs the reader claims, relative to the folder. `labels: false` hides the label controls. `accepts`
and `units` are thimble's citation forms, kept for citations into the view.

### Collections

A collection is one kind of row: events, sessions, calls, pull requests.

```json
{"name": "sessions", "one": "one transcript, a lead's or a subagent's", "key": "id", "title": "name", "ref": "ref",
 "fields": [
   {"name": "id", "type": "text"},
   {"name": "name", "type": "text", "derived": "computed", "from": "agent and run", "how": "the agent's name and its run"},
   {"name": "parent", "type": "text", "link": "sessions"},
   {"name": "start", "type": "duration", "derived": "cleaned", "from": "its first line's timestamp", "how": "seconds since the run's first line"}
 ],
 "detail": { ... }}
```

- `key`: the field unique per row. `title`: the field a person reads as the row's name; never a hex id or a uuid
  (the checks note titles that read as one). `ref`: the field holding the row's citation, `ref` by default.
- Every field a component names is declared, with a `type`:
  - `text`, `category` (few values: filters, colours, groups), `number`, `time` (ISO 8601, or epoch seconds or
    milliseconds), `duration` (seconds: drawn as 45 s, 12 m 05 s, 3 h 20 m), `ref`, `list` (a list of values).
  - `label` (the name shown, the field's name by default) and `unit` (shown after a column's name).
  - `link`: the collection, or a list of collections, whose key the field holds. The panel shows the linked row's
    title in place of the key, and a click follows the link to that row.
  - `derived`: `cleaned` or `computed` for a field the reader made rather than read as the file holds it, with
    `from` and `how` as short phrases without semicolons. The title row's `N files ›` lists them.
  - `flag`: the values that are problems, such as `["error", "denied"]` for a call's outcome or `["failed"]` for a
    deploy's. Every flagged value is drawn in red wherever the field shows (a cell, a tag, the detail); a flagged
    row's glyph and its mark in lanes are `×` for the first value and `!` for the others, counted under the axis, and
    a transcript names the flagged value beside the speaker. Red stays for these and for the reader's problems.

### Detail

What a selected row shows under the view. Without `detail`, every field but the key, the title and the ref.

```json
"detail": {
  "meta": ["agent", "run"],
  "fields": ["parent", "depth", "start", "end", "calls"],
  "text": "prompt",
  "related": [
    {"title": "Calls", "collection": "calls", "via": "session",
     "show": {"kind": "transcript", "speaker": "tool", "text": "input", "time": "time"}}
  ]
}
```

- `meta`: values on the row under the title, at A2 and dim, each after its field's label and parted by ` · `
  (`wiki dse · week 06-14 to 06-20`), on two rows at most (a flagged value in red). The title row starts with the
  row's glyph at A0 and ends with `↗ <place>` and `?` against R (the visual system, section 7, "A view").
- `fields`: label/value rows (rule 6), in two blocks side by side where the panel is 80 or more wide, a value too long
  for half the width on a row of its own above them; numbers right-aligned on the widest of their block; a link is
  followed by a click. The columns the tab's table leaves out at the panel's width follow them.
- `text`: a long field wrapped in full at the measure (72 cells), up to 12 lines.
- `related`: rows of another collection whose `via` field (a link to this collection) names this row, drawn as a
  `table`, `list` or `transcript` (below) under a heading (its title at A0, its count dim, a blank row above), with an
  optional `where`. A click on one follows it; `‹` goes back. A section with another after it shows its first 8 rows
  (in its sort's order) and "… N more", which opens it whole ("fewer" shortens it again), so every section is in
  reach; the last shows all its rows.

### Stats

Numbers on the title row after the view's name, dim: `{"label", "collection", "agg", "field"?, "where"?}`. `agg` is
`count`, `distinct`, `sum`, `mean`, `median`, `min`, `max` or `span` (the time between the first and last value).

### Tabs

A tab draws one collection's rows, laid out as thimble's proposal asks: an overview of all of them, what a click on it
narrows (zoom), one filter row, the records, and the selected record's details.

```json
{"name": "Events", "collection": "events", "where": {"field": "incident", "not": null},
 "overview": {"kind": "histogram", "time": "time", "color": "source"},
 "zoom": "a click on the strip narrows to that time",
 "filter": {"fields": ["incident", "source", "actor"], "search": ["text"]},
 "body": [{"kind": "table", "columns": [{"field": "time"}, {"field": "source"}, {"field": "text"}]}]}
```

- `where`: `{"field", "is"?: value or [values], "not"?: value or [values]}`, rows the tab keeps; `"not": null` keeps
  the rows with a value, `"is": null` those without.
- `overview` (required): a compact visual of every row of the tab, drawn above the records in at most a third of the
  panel (two fifths for a graph): `histogram`, `lanes`, `bars` or `graph` (below). It is drawn under the filter row's
  filters but not its own zoom, so a strip shows where the window sits. The title row above a `bars` or `histogram`
  overview (dim, at A0) names what it counts, in the words of the rows (the title row's count of the collection, else
  its name) and the field's label: `pages by week first stored`, `revs by wiki` for a sum, `mean revs by wiki`; so
  label the field by what its value means.
- `zoom` (required): one short phrase, at most 90 characters, saying what a click on the overview narrows the rows
  to. It is the proposal's record of the click, read by the reviewer; the panel does not print it, as a view carries
  no usage hints. What the click does follows from the overview's kind: a strip's bin or
  lanes' axis zooms to half the span around it, a bar or a lane of values keeps that value, a box or a lane of rows
  selects it.
- `filter` (required): `{"fields": [...], "search"?: [...]}`. `fields` are category, list or text fields, offered in
  one row as `filter  field · field · labels`; a click on a field shows its values with their counts under the row,
  and a click on a value keeps the rows with it (values of one field or'd, fields and'd); each field's counts are taken
  under every other filter. `search` are the fields the search reads; by default the title and every text, category
  and list field that is not a link. An empty `fields` leaves the row with search and labels.
- `body`: one or more components, the records, drawn top to bottom. The last that scrolls (table, list, transcript,
  lanes) takes the rows left; the others take what they need, up to under half.
- Details (required): the tab's collection has a `detail` (above), what a selected row shows under the records.

### Components

| kind | fields | draws |
| --- | --- | --- |
| `table` | `columns: [{field, label?, show?: text\|bar\|chips, width?}]`, `sort?: {field, desc?}`, `group?` | a row per line, as section 7's "Tables": the row's glyph at A0, the title column at A2, regular; the column names dim on the row above, a click on one sorts by it (`▼` or `▲` after it); numbers right-aligned; a name of three words or fewer (the title or a link) cut in the middle, a longer title at its end; the title column wide enough for its typical name, then for nine in ten names whole, before other columns widen; columns that do not fit the panel left to the detail, long text first, then the last, a column of tags last; `bar` adds a bar scaled to the column's largest value; `chips` draws a list's values as tags (a flagged one first), as many as fit whole and the rest counted (`existed before +1`), the column wide enough for each row's first tag and the count, up to 20 cells; `group` sets the rows under a heading per value of a category (its value at A0, its count dim, a blank row above), the rows keeping the columns |
| `list` | `meta?: [fields]`, `text?`, `tags?: [fields]`, `sort?`, `group?` | an item in two rows: its glyph at A0 and its title at A2, regular, its meta fields in aligned columns after it (a category in the text colour, a number right-aligned, other text dim; the colour field left to the glyph; columns that leave the title less than about half the width left to the detail); under the title, at A2 and dim, `text`, then after a gutter the `tags` (category or list fields, in the text colour), a flagged one first, in red |
| `lanes` | `lane`, `time`, `end?`, `color?`, `lanes?: {collection, label?, start?, end?, parent?, group?, meta?}` | a time axis, a lane per value of `lane`, or per row of `lanes.collection` (whose key `lane` holds, each lane under its `parent` with tree guides, its span from `start` to `end`, under a heading per value of `group`, its `meta` fields in columns beside its name; a heading, after a blank row, shows the linked row's title, regular, and its fields of the same names dim, and a click on it selects that row; a lane per value of the colour field starts with its glyph); each row a mark `●` in the hue of its `color` value or of the label on, a flagged row `×` or `!` in red, the selected one on the selection background; a click on the axis zooms in, and the zoom narrows the tab's rows |
| `graph` | `edge` (a link to the tab's collection), `label?`, `meta?` | boxes and arrows, drawn as the diagram card draws them, an arrow from the row `edge` names; a tree of more than 10 rows as an indented tree with its `meta` fields in columns; at most 40 rows |
| `bars` | `field`, `value?`, `agg?: count\|sum\|mean`, `color?` | a bar per value of the field, largest first, as the bar card draws them (labels at A0, bars from the label column, numbers against R with thousands separators), or with `color` each bar stacked by that field's values with their legend under the bars (two or three values: the first part of the whole, "7 of 8"); a click on a bar keeps the rows with its value, on a legend's value the rows with that |
| `transcript` | `speaker`, `text`, `time?`, `sort?` | turns: the speaker's `●` in its hue at A0 and its name at A2 in the text colour (a flagged turn's glyph and value after it, in red), the time dim against R; the text under the speaker at A2, upright, to three rows |
| `histogram` | `time`, `color?` | counts over the whole span in a strip two rows high, a bin per column, each bin in the hue of its commonest `color` value (or of the label on that marks most of it), in the text colour without one; its scale at its left (the most rows in a bin, and 0, right-aligned before `┤`), the axis's ends and middle under it, dim, and the colours' legend (two rows at most); bins outside the zoom dim; a click on a bin zooms to half the span around it. As the overview over `lanes` on the same time, it stands on the lanes' axis (their names under its scale), so a mark sits under its bin, and the lanes show the strip's window |
Colour (the visual system, section 4): the panel colours one field per tab, its overview's colour field (a bar's
`field`, a strip's or lanes' `color`, lanes' own field when it is a category), in thimble's palette, the same in the
overview, its legend, the `●` before each of its values in the filter row, and each row's glyph in the records and the
detail. While a label is on, it is that field. Words stay in the text colour; red stays for problems. A transcript's
speakers take hues of their own.

The worked examples use: timeline, a strip of every event over lanes by source and a table grouped by day, and lanes
of the incidents' spans over their events grouped by incident; linked sessions, a strip of the calls over a lane per
session grouped by run with calls and errors beside each, errors and denials flagged, each session's transcript and
each call's moment in its run in the details, bars over a table of calls, and the sessions compared agent by agent;
repository, the runs as stacked bars of merged, closed and open over the forge's two-line list of pull requests (its
flags as tags, the problem ones in red), the
backlog issues as stacked bars of fixed and open over each issue's runs side by side, a list of discussions, a table
of agents, and the activity as a strip over each run's lanes and a table, each pull request's story as a transcript.

## The file browser's views

`/thimble-files` draws the folder's files with this same panel code: `helper/files.py` writes a view of the tree and one
per opened file under `.thimble-cc-mod/files/<slug>/` (no reader; the helper writes `view.json` and `rows.json` itself),
and the panel names them by `@<slug>`, so they never mix with the views the pipeline builds. Three fields, which only
these views use: a collection's `opens`, a field holding a file's path, so a click (or Enter) on a row opens that file
rather than selecting it; the spec's `up`, the step the path row shows before the file's name (`files`), which ← or
backspace go back to when no followed row is left to go back to; the spec's `source`, the file the view shows, which a
side thread about a row is told. Their tabs may leave out `overview` (a file's raw lines have nothing to overview):
`validateSpec(spec, {builtin: true})`, `render_view.mjs --builtin`.

## Visual hierarchy

A view is read by skimming: what the groups are, which items matter, what state each one is in. The panel draws every
view on the visual system's grid (above): a group's heading at A0 with a blank row above it, an item's glyph at A0 and
its title at A2, its secondary text dim at A2, numbers against R. No title, heading or column name is bold, since bold
marks only what is new; colour goes only on the colour field's glyphs and marks and on flagged values. The tab's colour
field reads down the glyph column (`●` in its value's hue, `×` or `!` in red on a flagged row), so a column that also
shows the value keeps its word in the text colour, a list leaves the colour field out of its meta, and rows grouped by
it leave it to their headings. Number and duration fields, and text whose every value reads as numbers (`+9 −1`), are
right-aligned in a column of their own; a time keeps its width. Tags (a category or list field of at most eight values,
each on three rows or more on average) are drawn as their values in the text colour, a flagged one in red, parted by a
dim ` · `, with no band behind them; a field of more or rarer values (a person, a reviewer) is plain text.

The spec's part: titles that are names; a list's `meta` of the two or three fields an analyst tells items apart by;
its `text` a short line the reader makes (`#15 by elm · open for 1h 53m · closes #8`), not every fact; flags and
areas as category or list fields in `tags` or `meta`, not words inside the text; quantities as number or duration
fields rather than text, which the panel right-aligns and reads with thousands separators from 1,000 (a number that
names a thing reads as written, when its field's name or label says so: `seq`, `line`, `year`, `id`, `number`,
`#…`); `flag` on the values that are problems, and only on them; field labels that say what a value means, since
they head the columns, the overview's title and the detail's rows.

## Checks

`validateSpec(spec)` (`hooks/viewspec.ts`) returns every problem of a spec at once, each with its place, such as
`tabs[1].body[1].columns[0].field: nope is not a declared field of calls`. `validateData(spec, rows)` returns the
rows' problems (a collection missing, a key that repeats or is missing, values not of their declared type) and notes
(rows without a ref, titles that read as hex ids, links to rows that are not there, empty collections). The panel
draws a view only when both have no problems, and shows the problems in its place otherwise.

    node tools/render_view.mjs --spec view.json --rows rows.json --check [--width 96] [--height 48]

prints `{"ok", "spec", "rows", "notes", "width"}` and exits 1 unless ok: the spec's and the rows' problems, then each
tab drawn as it opens and with its first row selected, at the width and 30 columns narrower, failing on a line wider
than the width, more lines than the height, or a drawing that throws. `--labeltest` adds thimble's label check: each
tab drawn with a test label on that marks about one row in seven must draw its colour on a marked row in view
(`labels`, `marked`). The pipeline's checks (below) run it with the reader's gates around it.

## The pipeline

thimble's view pipeline (`backend/app/views.py`, `dev.py`, `view_review.py`) for the terminal. The code is
`helper/viewpipe.py` (proposals, the reader's run, the checks), `hooks/viewpipe.ts` (the prompts and each step's
state, pure) and the view pipeline block at the end of `hooks/register.tsx`.

1. **A proposal**: `proposal.json` in the view's folder, with thimble's `propose_view` fields: `name`, `why`, `claims`
   (globs), `unit`, `overview`, `zoom`, `filter`, `details`, and `proposed_by`, `build`, `files` (how many files the
   claims match) and `ts`. Main writes it with `python3 helper/viewpipe.py propose --name … --why … --claims … --unit …
   --overview … --zoom … --filter … --details … [--build]` (`prompt/chat.md`, "Views"), which refuses a field left out
   or a claim that matches no file; a `proposal.json` written by hand is read the same way. The mod reads the
   proposals when the session starts, after a tool call that runs the helper or writes a `proposal.json`, and when
   each of main's turns ends. One with `build: true` whose `ts` it has not built yet is built at once; the others wait
   in the row above the prompt. A subagent started while main's turn runs would hold that turn open until it ends,
   so a build asked for in main's turn starts when the turn ends, and so does any later builder or reviewer.
2. **A builder**: a subagent named "view · building <name>" (general-purpose, or a fork where that is refused) given
   `prompt/view-build.md`, thimble's `prompts/dev-view.md` for the terminal: the proposal, this contract, the worked
   examples in `viewers/` and the check command. It writes `reader.py` and `view.json` and runs the checks itself.
3. **The checks**, which the mod runs when the builder ends: `python3 helper/viewpipe.py check <slug> [locator …]`,
   thimble's gates (`views.py` `check`, `prompts/dev-gates.md`), all in code:
   - `reader.py` and `view.json` exist, the spec's slug is its folder's name, the scope matches files;
   - `build_index` runs (its traceback is reported), with the bytes it reads of each claimed file counted
     (`helper/viewhost.py`): a file neither read to the end nor returned by `hidden(index)` with a why fails;
   - `problems(index)` is a list of `{ref, why}`, reported as "N lines the reader could not parse";
   - `records(index, {"op": "rows"})` gives the collections, written to `rows.json` with the labels of
     `.thimble-cc-mod/labels.json` and the view's `labels.json` marked on the rows' refs;
   - the spec and the rows validate and draw within the panel (`render_view.mjs --check --labeltest`), a title that
     reads as a hex id failing, and `labels: false` failing on a view of more than one file;
   - names the reader shortened fail: a title or a lanes `label` cut in the middle ("Count…ataReview") on one row in
     twenty or more, as the panel shortens a name itself;
   - sampled rows' fields are compared with the lines they cite, and a field whose values those lines do not hold
     fails unless it is declared derived;
   - sampled lines of the claimed files and the locators given resolve (`resolve`) to an answer that cites them back
     with an excerpt that is literal text of the file, when `accepts` has `L<n>`; a unit's keys resolve too;
   - the reader runs again on a copy of the files with one missing and a JSON line cut short, and must not fail,
     must report the torn line in `problems(index)`, and must not lose every row;
   - the rows, with their parts, take at most 10 MB (`ROWS_MAX`), the problem naming the fields that take the most;
   - noted, not failed: folders beside the claimed ones that hold the same files, globs that match nothing, rows.json
     written in parts.

   It prints one line per finding and `checks passed` or `checks failed` (exit 1), and saves them as `check.json`. A
   failure goes to a new builder with the report (`prompt/view-gates.md`), 3 attempts in all.
4. **The view opens** in the panel when its first build passes, unless the panel shows something else, and main gets
   a note that it is built.
5. **A review**: a subagent named "view · reviewing <name>" given `prompt/view-review.md` (thimble's
   `prompts/view-review.md`): the proposal, the checks' notes, and the view drawn as text by `render_view.mjs` (every
   tab as it opens and with its first row selected, 96 columns wide, then the first tab 66 wide; saved as
   `render.txt`). It may draw other states itself and answers `{"problems": [...]}`. Problems go to a builder
   (`prompt/view-revise.md`, thimble's `prompts/dev-view-review.md`); the view as reviewed is kept in `reviewed/` and
   put back when the fixes never pass the checks. A review follows every build that passes, with 2 revisions an open
   review asks for (thimble's `ROUNDS`); then one more revision fixes what the last open review found, and a review
   checks those problems alone (`LAST_ROUND`): the ones it still finds are left, the rest counted fixed, so a view is
   not left with problems no builder was asked to fix. "review again" in the views pane starts a new run of reviews on
   a built view, as thimble's does.
6. **The state** of each step is `status.json`: `state` (building, checking, reviewing, revising, built, failed,
   stopped), `attempt`, `round`, the last checks' lines, the review's problems being fixed, fixed and left, and why it
   failed; while the last fixes are reviewed it reads "checking the last fixes". The row above the prompt shows each
   proposal by its glyph and name: `○` proposed or stopped, `◌` building, checking or reviewing, `●` built, `!` built
   with problems left, `×` failed; a built view's name is bold until the analyst opens it. A click on a built one
   opens the view; on any other, the views pane.
   `/thimble-views` opens the views pane (every proposal, the chosen one's fields, checks and review, and build, stop
   and open); `/thimble-views build <name>` builds one.

The builder and the reviewer are general-purpose subagents, which may hand their report back (SubagentHandback) as a
message to main. The mod takes that report as the subagent's answer at `prompt.submit` and drops the prompt, so main
never reads it; Claude Code shows the drop as one line ("Prompt dropped by a hook: thimble-cc-mod: view · reviewing
<name> · reported").

A view's folder then holds, beside its three files: `proposal.json`, `status.json`, `check.json`, `render.txt`,
`reviewed/`, `cache/` and `work/` (the builder's own files).

## Drawing for the reviewer and for screenshots

    node tools/render_view.mjs --spec view.json --rows rows.json --all --plain --width 96 --height 48

prints every tab as it opens and with its first row selected, as plain text, each under `=== <tab>`. Without
`--plain` it prints ANSI colours in Claude Code's dark theme (`--theme light` for the light one); `--tab N`,
`--select <collection>/<key>` (or `first`) and `--state '<json>'` (a ViewState, below) draw one state. The ANSI is
drawn on the panel's background, every line padded to the width and the height (`--bare` leaves it off). The lab's
`ansi2png.py` turns the ANSI into a PNG. Needs Node 22.18 or newer.

## The panel

`/thimble-view <name or slug>` opens a view (with no argument the first; when none matches, it lists them).
Inside `register.tsx`, `openView($, slug)` does the same for other code, such as a build that just passed. The
panel lays the view out at its size, its state kept per view in `$.state` (`views`, by slug; `view` is the open
one).

The panel draws, top to bottom (the visual system, section 7, "A view"): the path row; the title row (the view's name,
its stats dim, "N unreadable lines" in red when the reader reported any, and "N files ›" against R, which opens the
files read, the files left out and the fields the reader made; counts of a thousand or more with separators); the tabs,
when there are several, the active one on the selection background; the filter row (search, `filter` and each field, the
rows counted against R: in the words of the title row's `count` stats of the tab's collection that count different rows,
when those hold most of the tab's rows, each "N of M" where the filters or the tab's own `where` leave some out; else by
the collection's name), the open field's values under it, and the filters that are on, on a row of their own; a rule;
the overview under its title row; a blank row; the records; a rule and the selected record's details. The whole panel
stands on the background Claude Code gives a docked pane (`composerSidebarBackground`); the selected row, the active tab
and the filters on take the selection colour (`selectionBg`), which shows on it in light and dark themes, and nothing
else has a background.

What the analyst does, all drawn by the view and changed only by their clicks and keys:

- a tab; a field of the filter row (its values open under the row; the same field again closes them), a value (keeps
  its rows), a `+N` (the field's other values, or the fields that did not fit); a filter that is on (turns it off)
  and `clear all`; a column's name (sort), a group's heading (folds the group to its heading and `… N more`, and
  opens it again); the overview: a strip's bin or lanes' axis (zoom), a bar
  or a lane (keeps its value), a box (selects it); the zoom, shown among the filters that are on (unzooms);
- a row, a mark, a node or a lane: its detail under the view (a second click closes it); a link in the detail or a
  related row: that row, `‹` back;
- `↗ <place>` in the detail, or a line under "N unreadable lines": the citation panel on that place, as anywhere
  in the mod; a right-click on a row: the mod's menu for its record (open, ask);
- `?` beside the row under the pointer or the detail's title, or the `?` key: a side thread about the row, told the
  view, what one row is, the row's fields as shown, and its place;
- `labels` in the filter row shows each label: a click on its name turns it on (the name on the selection
  background) and makes it the tab's colour field, so the rows' glyphs, the lanes' and strips' marks and the legend
  take its values' hues and the rows it does not mark a dim `●`; the count beside it keeps only the rows it marks;
- "N unreadable lines" and "N files ›" on the title row open them under the view;
- keys once a click has given the view the focus: ↑/↓ (or j/k) step through the rows, page up and down, home and end,
  ← or backspace back, tab the next tab, `/` search (typing goes to the search until return), `[` and `]` scroll the
  detail, `o` or return open the row's place, `?` a side thread; the wheel scrolls the list, or the detail when over
  it.

### State and acts (for code)

`ViewState` (`ChatViewState` in `types/index.d.ts`): `tab`, `q`, `typing`, `facets` (`"<tab>.<field>"` → values),
`sorts` (by tab), `sel` (`{c, k}`: collection and key), `back`, `scroll`, `dscroll`, `labelsOn`, `labelFilter`,
`open` (`"<tab>.<field>"` for the field whose values show, `"<tab>.<field>.all"` for all of them,
`"rel:<collection>:<title>"` for a related section shown whole), `closed`, `panel`
(`problems`, `about` or `derived`), `zoom` (by tab). `reduce(spec, rows, state, act, meta)` is the only
way it changes; `viewLayout(spec, rows, state, cols, rows)` returns `{lines, hits, meta}`, each hit a region with its
act. The Client gets the hits packed (`packHits`: four numbers each, and a stamp naming the drawing), so a view of many
marks stays within its props limit; it posts acts as `{type: "view", view, vorigin, acts: [{seq, act}]}`, a click on a
hit as `{op: "hit", i, s}` (with `ask` for its "?", `menu` for a right-click), and register.tsx maps each to the act
the stamp's drawing gave it and applies each once. An act's effect asks the mod for a side thread (`ask`) or a place
opened (`open`).

## Limits

- One line per table row; a cell wider than its column is cut with `…`, but a number, a bar or a time keeps its width.
  A last column of text takes the room the others leave.
- A graph draws at most 40 rows; boxes and arrows read up to about 10 rows, so a larger tree is drawn indented.
- Lanes draw one mark per cell, the selected one first, then one a label marks; `◆` marks a cell where more than two
  meet. Zoom in to tell them apart. The lanes' names take what they need up to about a third of the width, a longer
  name cut in the middle.
- A legend takes two rows at most; the values that do not fit are counted (`+3`).
- A category colours its values only while it has at most six; past that its marks are drawn in the text colour
  (lanes and transcripts cycle the hues).
- The panel's Client is handed only the lines it shows. The hooks module holds every row once, reads a changed
  view once however many drawings ask for it, and keeps what it derives from the rows (a tab's rows under its
  filters, their order, the lanes, each row's search text) until they change, so a key or a scroll on a view of tens
  of thousands of rows draws in milliseconds. The view's acts apply one at a time, in the order they came.
