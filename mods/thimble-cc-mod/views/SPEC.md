# thimble-cc-mod's terminal: the visual system and the views contract

Two parts. **The visual system** says how every surface of the mod draws on Claude Code's character grid: the
panels, main's chat and cards. **Views**, from "Views" on, is the contract a view's
builder, the checks, the reviewer and the panel code against. The builder reads both parts.

## The visual system

The terminal has one typeface and one size, so position and space carry the structure that type sizes carry on paper.
Weight and colour stay rare, so that each one means one thing. Columns and intervals follow Josef Müller-Brockmann,
*Rastersysteme für die visuelle Gestaltung / Grid Systems in Graphic Design* (Niggli, 1981); the rule that contrast is
read only when it is rare follows Emil Ruder, *Typographie / Typography* (Niggli, 1967). The panels' chrome follows
Claude Code's own panels (its Artifacts and Background panels): an accent title, an inverse tab, a bordered search box,
bold section headings, `❯` on the selected row, metadata dim at the right, and a dim italic row of key hints. These rules
apply to everything the mod draws. Claude Code's own drawing (its `❯ ⏺ ✻ ⎿ ✕`, tool rows, Markdown in replies the mod
does not draw) is outside them. Colours are in `hooks/paint.ts`; `hooks/chrome.tsx` draws the panels' chrome;
`hooks/draw.ts`, `card.tsx`, `cite.ts`, `para.tsx`, `viewdraw.ts`, `home.ts`, `register.tsx`, `reports.tsx` and
`harness.tsx` draw.

### The rules

1. One left edge: the reply's text column (4) in the chat, A0 in a panel; indent only to nest (an item, an output, a child).
2. Marks hang in a 2-cell margin left of that edge: `❯` on the selected row, `?` or `↳` by a passage, a highlight's `●`.
3. Thimble's text fills its column, with no fixed measure; cards keep their cap of 120 columns.
4. Every card has a full border in the rule grey, its title on the first row inside, a blank row, then its body.
5. Every panel opens with the path row, its title in the accent colour and bold, a dim subtitle, a rule; key hints end it.
6. A panel's actions sit at its bottom, after a rule, where their result appears; the title row holds only navigation.
7. Bold is for titles and headings: panel titles, section headings, a card table's header, speakers, the model's Markdown.
8. New is the word `new` (or `N new`) in green after the new thing; opening the thing clears it.
9. Dim is secondary: labels, counts, times, metadata against R, secondary rows, separators, key hints.
10. Links are blue and underlined: citations, the place after `↗`, a label's name on a card; the `?` and `↳` are blue.
11. Red means a problem and only a problem: `×` failed, `!` usable with a problem.
12. A palette hue goes only on the marks of a colour field; a chart's one series is a field of one value, in the first hue.
13. `❯` and the accent mark the selected row; the selection background a choice in use; inverse the tab and the pointer.
14. Code is coloured as Claude Code colours it; a record's own words are in quotation marks and italic.
15. One glyph, one meaning (section 5); groups and folders fold with `▸ ▾`; a right-click does what a click does.

### 1. Channels

Each channel has one meaning. A run the table does not cover is regular, in the text colour, on the panel's background.

| channel | its one meaning | never used for |
| --- | --- | --- |
| position | what kind of thing a run is: the column it starts on (section 2) | |
| the margin | a mark beside a row: `❯`, `?`, `↳`, a highlight set's `●` | text |
| a blank row | the end of a group; the gap under a card's title | spacing inside a group |
| a rule `─` | the end of a region: under a panel's header, above its bottom part | the line under a heading |
| a border | a card, and the search box | a panel's regions |
| **bold** | a title or a heading (rule 7) | names in a list, values, the selected row, new |
| green | new | anything else |
| dim | secondary | a name, a number in a number column, a flagged value, a control |
| blue, underlined | a link: a citation's value, the place after `↗`, a label's name on a card | controls, rows a click selects |
| blue | the `?` and `↳` in the margin | |
| accent | a panel's title, the selected row | anything else |
| italic | a record's own words (in quotation marks); the key-hint row | emphasis, captions |
| inverse | the selected tab; the control, citation, mark or bar label under the pointer | anything at rest |
| selection background | a choice in use: a card's parameter, a filter that is on, the cited value in its lines, text being dragged | rows, hover |
| tip background | the tip of the citation under the pointer | anything else |
| palette hue | a value of the region's one colour field | letters, headings, backgrounds |
| red | a problem | negative numbers, hover |
| code colours | code: a script, a label's code, a command, inline code | prose |

### 2. The grid

The horizontal unit is the cell and the indent step is 2 cells. The vertical unit is the row.

**The chat column**, where the mod draws in Claude Code's transcript, uses the columns Claude Code already has:

| column | holds |
| --- | --- |
| 0 | Claude Code's `❯ ⏺ ✻`; the `↳` that starts a `↳` row |
| 2 | the reply's margin: the `?` of the passage under the pointer, a passage's `↳`, a highlight set's `●`; the words of a `↳` row and of a notice row |
| 4 | the reply's edge: prose, headings, a list's `-`, a card's left border, the footer |
| 6 | nested: a list item's text, a quote block, a card's content (inside its border and padding) |

**A panel's columns.** The pane has 1 cell of padding at each side; the margin M is the 2 cells after the left padding;
the type area runs from A0 to R.

| axis | column | holds |
| --- | --- | --- |
| M | the 2 cells left of A0 | the margin: `❯`, a passage's `?` or `↳`, a highlight set's `●` |
| A0 | the type area's first cell | the edge: the path row, title, subtitle, tabs, search box, rules, headings, prose, field labels, a card's border, a state glyph, a fold marker, a tree's guides, the key-hint row |
| A2 | A0 + 2 | an item's name after its glyph, marker or guide; a secondary row; nested content (a command's output, a list item's text) |
| A4 | A0 + 4 | a second level: the name of a folder's file or of an unfolded group's item after its own glyph at A2 |
| L | the label column's width (its longest label + 2) | the values of label/value rows and fields |
| R | the type area's last cell | numbers, metadata (dim), the title row's navigation (`1 file ›`) |

1. **Axes.** A run that opens a row starts on M, A0, A2, A4, L or a table's column. A tree deeper than A4 goes on with
   guides `├ └ │`, 2 cells a level.
2. **Marks hang.** `❯`, `?`, `↳` and a highlight's `●` sit in the margin, so text keeps its edge with or without them. A
   state glyph or a fold marker sits on A0 with its item's name at A2. In a table the row under the pointer shows its
   `?` at R, since the margin holds `❯`.
3. **Space.** 1 cell is a word space. ` · ` parts the items of one inline list of facts. 2 cells are a gutter: between
   columns, a label and its value, two controls. A gutter is never 1 cell.
4. **Columns.** The name first, then categories, then numbers, then free text. Text columns align left; number columns
   align right, each on its own axis, the last on R. A row's metadata (a kind, a status, a time, a count of parts) is one
   dim run against R, parted by ` · `. A unit shared by a column goes in the column's name (`records`).
5. **Shared axes.** A component works out its columns once for all its groups; the sections of one panel share A0, A2
   and R.
6. **Label/value rows and fields.** The label is dim, lower case, with no colon, in the label column; values and fields
   start on L. A value that is a list puts each item on its own row after a `-`.
7. **No measure.** Prose, a thread's answer, a report, a definition and a detail's text fill the type area (in the chat,
   the terminal's width). Cards keep their cap of 120 columns.
8. **Flush left, ragged right.** Nothing is centred or justified.

**Rows.**

9. No blank row inside a group, one between groups, never two, none at the top of a region. A card has one blank row
   under its title.
10. A rule divides a panel's regions: under the header, and above the bottom part (a detail, a selected thread, the
    actions). A panel has two at most. A rule spans the type area in the rule grey, and no blank row is ever next to it.
11. **A card** has a full border with round corners in the rule grey and 1 cell of padding: in Ink, a `Box` with
    `borderStyle="round"`, `borderColor` the rule grey and `paddingX={1}`. Its left border sits on the stream's edge
    (column 4 in the chat, A0 in a panel). Inside: the title row, a blank row, then the label row, the params row and the
    body. In the card pane the question is the panel's title, so the box starts with the readout row instead (blank
    until a mark is under the pointer). In a stream a card's border stands in for blank rows next to it; a report's
    caption is dim on the row under the bottom border.
12. Every item of a list takes the same number of rows: one, or a name row and a dim secondary row. The selected item
    may open more under it. A transcript's turn takes its time-and-speaker row and up to three rows of text.

### 3. Type

13. **Bold** marks a title or a heading: a panel's title, a section heading in a panel, a card table's column names
    (a view's stay dim), a transcript speaker's name, and the model's own `**…**` and `#` headings, drawn as Claude
    Code draws Markdown. The mod adds no other bold: not on names in a list, values, the selected row or anything new.
    Claude Code draws a Button that is not `plain` as a bold `[ label ]`, so every Button stays `plain`.
14. **New** is the word `new`, or `N new` after a count, in green: a thread with an answer not yet read, a view built and
    not yet opened, a report written and not yet opened, a label run finished and not yet opened. It follows the item's
    name, which stays regular, wherever the item shows (home, a `↳` row, a step of the path, the threads tree,
    `show all threads`). Opening the item clears it.
15. **Dim** means secondary: labels and units, counts, times, places in a secondary row, the `·` and `›` separators, axis
    labels, metadata against R, secondary rows, `○`, rows outside the zoom, and the key-hint row (dim and italic).
16. **Underline** means a link: a citation's value, the place after `↗`, a label's name on a card, a URL. Links are blue.
    Names and rows that a click selects or opens are not underlined.
17. **Italic** means a record's own words quoted among the model's or the mod's, always inside quotation marks: an example
    card's records, a label's examples, a quote block. Views and the file browser draw records upright, since everything
    in them is a record's. The key-hint row is italic too, as in Claude Code's panels.
18. **Inverse** marks the selected tab, and the control, citation, chart mark or bar label under the pointer or the
    keyboard focus.
19. No blink, strike-through or capitals for emphasis. Kind words, field labels and steps of the path are lower case,
    names are as written, headings are in sentence case.

### 4. Colour

| colour | theme key | drawn on | means |
| --- | --- | --- | --- |
| text | `text` | letters and controls; state glyphs; the bar under the pointer | content |
| dim | `inactive` (`dimColor`) | letters (rule 15); the catch-all value's marks | secondary |
| rule grey | `subtle` | lines only: rules, card borders, the search box's border, tracks, axes, tree guides, a diagram's boxes and edges | structure |
| link | `remember` | links (rule 16); the `?` and `↳` in the margin | opens what it names |
| accent | `suggestion` | a panel's title; the selected row's `❯` and its text | where you are |
| new | `success` | the word `new` and `N new` | new |
| tip | `userMessageBackground`, a background | the tip of the citation under the pointer | |
| inline code | `permission` | inline code in the mod's own paragraphs | code |
| palette | `SERIES`, seven hues that keep 3:1 on both panels | `●`, marks, bars, strips, swatches | a value of the colour field |
| red | `error` | a problem's words and its `×` or `!` | a problem |
| selection | `selectionBg`, a background | a choice in use (rule 21) | |
| panel | `composerSidebarBackground`, a background | the whole panel | |

Code blocks (a script, a label's code, a command) are drawn by Claude Code's `Code` element, with its own syntax colours
and, given `startLine`, its dim gutter of line numbers.

20. **One colour field per region**: a card's group or label, a view tab's colour field, the file browser's file type, a
    transcript's speakers, a report's highlight sets. While a label is on, it is the field. Its hues go on glyphs and
    marks; a value's word stays in the text colour (`● dse 3,908`). A chart with no colour field is one series, drawn in
    the first hue. The bar or mark under the pointer turns the text colour and its readout stays plain. A field colours
    at most six values, past which its marks take the text colour (lanes and transcripts cycle the hues). A label's
    catch-all value ("other"), and the rows the label that is on does not mark, take dim marks. A field with one value
    draws dim marks. A strip's bins outside the zoom are in the rule grey.
21. **The selection background** marks a choice in use among choices shown together: a card's parameter, a field's
    value in a label panel (`prompt  regex  code`), a filter or label that is on, the cited value in the citation panel,
    text being dragged. Selected rows use `❯` and the accent instead (rule 13 of "The rules"), and the selected tab
    uses inverse.
22. **Red** marks a problem and only a problem: a failure, a value a view's `flag` names, a citation whose value is not
    at its place, lines a reader could not parse, problems a review left, a check that failed, a report's warning or
    caution. `×` is a failure and `!` something usable with a problem. Negative numbers are drawn as positive ones are.
23. No other colour: no warning amber, and no green except `new`.

### 5. Symbols

One glyph, one meaning, everywhere. A glyph and a word that say the same thing are never drawn together (`○ Edit Bursts`,
not `○ Edit Bursts proposed`). Besides the words of the corpus and the model, the mod draws no non-ASCII character
outside this table.

| glyph | its one meaning | colour |
| --- | --- | --- |
| **state**, one per item, on A0 | | |
| `○` | not started: proposed, stopped, queued, a file never opened | dim |
| `◌` | running: building, checking, answering, writing, verifying | text |
| `●` | one thing that is there: an item built, answered, written or read; a value's swatch; a record's or event's mark | a state: text; a mark: its value's hue (rule 20) |
| `!` | usable with a problem | red |
| `×` | failed | red |
| `✓` | confirmed: a script got the cited value, the analyst agreed with a record | text |
| **margin** | | |
| `❯` | the selected row | accent |
| `?` | ask a side thread about this passage (shown under the pointer; at R on a table row) | link |
| `↳` | a side thread was asked here (in a reply's margin, a click opens it); the start of a `↳` row | link in the margin; dim on a row |
| **navigation** | | |
| `›` | into: opens one level in (`1 file ›`); between the steps of the path | text; dim between steps |
| `‹` | back one level (`‹ back`) | text |
| `↗` | opens what it points at: a place in the corpus (the place after it), a label (its name before it) | link |
| `▸` `▾` | a folded or unfolded group or folder; a click toggles it | text |
| `⌕` | the search box | dim |
| **data** | | |
| `◆` | three or more marks in one cell | text |
| `█` and `▏▎▍▌▋▊▉` | a bar and its last eighth | hue (rule 20) |
| `▁▂▃▄▅▆▇█` | a strip's bins | hue; rule grey outside the zoom |
| braille | a line chart's lines | hue |
| `─ │ ├ └ ┤ ┬ ┴ ╭ ╮ ╰ ╯` | lines: rules, card borders, the search box, tracks, axes, tree guides, a diagram's boxes | rule grey |
| `→ ← ↓ ↑` | the direction of a diagram's edge | rule grey |
| `┊` | the pointer's column on a chart | rule grey |
| `▼ ▲` | the column a table is sorted by | dim |
| **text** | | |
| `…` | text cut short | as the text |
| `… N more` | N rows not drawn; a click draws them; never for one row | dim |
| `+N` | N values not drawn in a cell | dim |
| `·` | between the items of one inline list | dim |
| `"…"` | someone's own words: the analyst's question, a record's words | as the text |
| `-` | an item of a list | text |

No longer drawn: `▶` (the player is gone), `✗ ◇ ■ □ ━ ┃ • ✕ ❚❚ ⓘ ✦ ❢ ⚠ ≡ ╱ ▤ ❝ ┿ ∴ ▪`, the braille spinner, `[ ]` around
controls.

**Words that recur.** Plain, short words. A place reads `revisions.jsonl line 10566` or `lines 3-8`, never `#L`. A count
reads with thousands separators from 1,000 wherever the mod draws it; a number that names a thing (a line, a year, an id)
reads as written. No hex or hash ids; a script is named by its file name. A citation's status reads `found on the card`,
`found in revisions.jsonl line 10566`, `found in the command's output, line 1` or `not found in …`, with `, and a script
got the same number` or `, but a script got 5,883` after a verification.

### 6. Controls and fields

24. A control is a word or a few, in the text colour and plain: no brackets, bold, colour or underline at rest, inverse
    under the pointer or the focus. Its words say what it does (`verify`, `ask about it`, `run on the sample`,
    `ask for a change`, `show all threads`).
25. A panel's actions sit at its bottom, after the second rule, at A0, 2 cells apart, with their fields under them: that
    is where a reply, a run's counts or a build's state appear. The title row holds only navigation, against R
    (`1 file ›`). A reply's footer has its facts, then its controls after a gutter.
26. The key-hint row is a panel's last row: dim and italic, at A0, the bound keys in Claude Code's words, parted by
    ` · ` (`↑↓ to choose · Enter to open · v to verify · b to go back · x to close`). It names only keys that are bound
    on that panel. Nothing else in a panel or the chat says which key does what. The keys are Buttons with no label of
    their own, in a Box no row tall (`hiddenKeys`), and `keyFooter` draws the row from the same list.
27. A field: its label dim and lower case on the label column, the field on L, no colon (`ask`, `follow-up`,
    `describe a new label`, `ask for a change`, the label panel's `prompt`).
28. An empty region shows `none`, dim, at A2.
29. A right-click does what a click does. There is no menu.

### 7. Surfaces

The sketches are rows as drawn. In the panel sketches the first two columns are the margin M. What is bold, dim or
coloured is said under each.

**A panel's header**, the same on every panel:

```
  ‹ back  home › views › Wiki Pages                                     show all threads  1 new
  Wiki Pages                                                                           1 file ›
  4,579 pages · 4 wikis
   Pages   Editors
  ╭────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search pages…                                                                            │
  ╰────────────────────────────────────────────────────────────────────────────────────────────╯
  ──────────────────────────────────────────────────────────────────────────────────────────────
```

- The path row: `‹ back`, a gutter, then each step as a lower-case kind word and its name (`thread "how many…"`,
  `citation 5884`, `card "How many pages…"`, `label edit purpose`, `files`, `labels.jsonl`, a view's name), parted by a
  dim `›`, a long step cut with `…`. A step whose thread has new answers is followed by `new` in green; one whose thread
  is answering starts with `◌`. At R: `show all threads`, which opens the threads panel, then `N new` in green while
  answers wait. The threads panel itself leaves it out.
- The title row: the subject's name in the accent colour and bold; navigation against R. The subtitle under it: the
  subject's facts, dim, parted by ` · `, with a problem count in red. A panel with no facts worth a row has no subtitle.
- Tabs, where the subject has them: each tab's name with a cell of space at each side, the selected one inverse.
- The search box, where the panel has search: a bordered box across the type area, `⌕` and a dim placeholder
  (`Search pages…`), the query while typing.
- No `[ close ]` row: Claude Code's `✕` and the `x` key close the pane.

**Main's chat:**

```
⏺   The three cards are below. The dse wiki holds most of the corpus, and most of its edits came on one day, 18 June.

    dse has most of the pages
    ╭──────────────────────────────────────────────────────────────────────╮
    │ How many pages does each wiki have?                                  │
    │                                                                      │
    │ dse       ███████████████████████████████████████████████     3,908  │
    │ probier   ███████▎                                              601  │
    │ dorfwiki  ▏                                                       2  │
    │ all  4,579                                                           │
    ╰──────────────────────────────────────────────────────────────────────╯
  ? dse has 3,908 of the 4,579 pages, about 85%. probier comes next with 601. dorfwiki has only 2, so I left it out of the
    next card.
  ↳ The chart counts by the day in each revision's time field.

    13 citations · 2 cards  ask about this answer ›  open as report

↳ thread · "How many delete events are in events.jsonl? One number." · answered · new
↳ view · Wiki Pages · built · new
```

- Everything of the reply starts on column 4: prose, headings, a list's `-`, a card's border, the footer. A heading is
  bold, with a blank row above it and none under it, as the model wrote it. A list item's text and a quote block are at
  6. Prose wraps at the terminal's width.
- The model's Markdown is drawn as Claude Code draws it: `**bold**` bold, `*italic*` italic, inline code in its code
  colour, headings bold.
- A citation is its value in blue, underlined; once verified a `✓` follows it; a value not at its place is red. The
  citation under the pointer is inverse, and its tip (its place and status in plain words) sits on the tip background on
  the row below it, or above it on a paragraph's last row.
- The margin at column 2: the `?` (blue) of the passage under the pointer; a blue `↳` beside a passage a thread was asked
  about, which stays, and a click on it opens that thread in the threads panel.
- The footer, one blank row under the reply: its facts dim, its controls after a gutter, no file path.
- A `↳` row: `↳` at 0 and its words at 2, dim (`thread · "question" · answered`, `view · Wiki Pages · built`), `new` in
  green while it is new, `failed` in red. A proposed view's row reads `view · Edit Bursts · proposed` and ends with the
  control `build`. There are no rows above the prompt.
- A notice row, what a mod tool call or subagent did: dim at column 2, no glyph before it.

**Cards**, alike in the chat, the card pane and a report (rule 11 for the frame):

```
╭──────────────────────────────────────────────────────────────────────╮
│ Which ten labels have the most revisions?          AgentRelent  317  │
│                                                                      │
│ wiki  all  dse  probier  fractal                                     │
│ label                  revisions  pages  wikis                       │
│ ─────────────────────  ─────────  ─────  ──────────                  │
│ AgentRelent                  317      4  dse                         │
│ AgentMassPointer13           187      3  dse                         │
╰──────────────────────────────────────────────────────────────────────╯
```

- The title row: the card's question, regular; against its right edge the readout of the mark under the pointer
  (`dse  3,908 pages`), plain. A blank row under it.
- A label row, when the card read a label: `label` dim, the label's name in blue and underlined, then `↗`, then each
  value after its `●` in its hue (`label  edit purpose ↗  ● links or data  ● message to agents  ● other`). A click on the
  name or the `↗` opens the label panel. A label card (the label tool's) is a bar card of the label's counts with this
  row; its records live in the label panel.
- A params row: the param's name dim, its choices 2 cells apart, the one in use on the selection background.
- Bars: labels in a column at the content's edge, bars after a gutter, numbers against the right edge. The bars are in
  the first hue (or their value's hue); the bar under the pointer turns the text colour and its label is inverse. A part
  of a whole runs on a `─` track to the whole. The total has its own row (`all  4,579`).
- A line chart: y labels right-aligned in a column, axes in the rule grey, x labels dim at the ends and the middle, a
  legend row of `● series` entries; the pointer's column `┊` with its readout on the title row.
- A table: the column names bold, a `─` rule under each name as wide as its column, the rows right under it; numbers
  right-aligned with separators. Markdown tables in a reply take the same header.
- A timeline: the axis across the content with its `●` marks in hue on a rule-grey line, its end times dim under its ends;
  then one row per event: its time dim at the content's edge (the column of the axis's start label), a `●` in hue, its
  words, and a blue `↗` when it has a record.
- An example: per record, a `●` in hue at the content's edge and thimble's note after it, regular; under the note, at
  +2, the record's words in quotation marks and italic, up to three rows, then `↗` and its place in blue and underlined,
  on the quote's last row if it fits, else on the next. A blank row between records.
- A diagram: boxes and edges in the rule grey, node text in the text colour, edge labels dim; a note's number in a dim
  column and its text dim.
- The card pane: the question is the panel's title and the subtitle reads the card's kind and `made by <script>`; the
  box starts with the readout row; under the second rule `script  run again`. The script view lists the code with the
  `Code` element, its gutter at A0, no other indent.

**Home:**

```
  ‹ back  home                                                          show all threads  1 new
  Home
  ──────────────────────────────────────────────────────────────────────────────────────────────
  Views (1)
  ● Wiki Pages                                                pages.jsonl · reviewed, 10 fixed

  Reports (1)
  ● On 18 June, agents rewrote the dse wiki's welcome page 2,299 times…        document · 8 cards

  Threads (2)  1 new
  ● "How many delete events are in events.jsonl? One number."                                new
  ● "Which wiki got the most revisions on 18 June, and from how many labels?"

  Cards (12)
  ▾ answer to "Give me an overview of the wikis in three cards…"                          3 cards
    How many pages does each wiki have?                                                       bar
    How many revisions did the three biggest wikis get each day?                             line
    Which ten labels have the most revisions?                                               table
  ▸ answer to "Tell the story of 18 June in the dse wiki in three cards…"                 3 cards
  ▸ in the report "On 18 June, agents rewrote the dse wiki's welcome page…"               4 cards

  Labels (1)
  ● edit purpose                                                            ██████████▌█████▌███   30
    prompt · a sample of 30 · revisions.jsonl  ● links or data 15  ● message to agents 8  ● other 7

  Files (4)                                                                    records    read
  ▾ collusion-wiki/                                                 4 files     42,205   <0.1%
    ● revisions.jsonl                                                           14,591   <0.1%
    ● events.jsonl                                                              19,931   <0.1%
  ↑↓ to choose · Enter to open · Space to fold · x to close
```

- One layout, a single column. The title is `Home` alone.
- A section heading: its name bold, its count dim in parentheses, `N new` in green after it; a blank row above it; a
  click on it opens the section's own panel. A section shows its first five items, then `… N more` (never for one row).
- An item: its glyph at A0, its name at A2 (regular, even when new), metadata dim against R, `new` in green at R.
- Card groups say what they hold (`answer to "…"`, `in the report "…"`) with their card count at R; the newest group is
  open, the others folded. A group's cards are at A2 with their kind word at R.
- The Labels section stays as it is: each label's name, a bar of its values' shares in their hues with the total, and a
  dim secondary row of its kind, run and values.
- Files by folder: a folder row with its file count, records and share read; when it is unfolded, its files' glyphs at
  A2 and their names at A4. The first folder is open.

**The threads panel** (what `show all threads` opens, and where a thread opens):

```
  ‹ back  home › threads › "How many delete events…"
  Threads
  2 threads · 1 new
  ──────────────────────────────────────────────────────────────────────────────────────────────
  main
❯ ├ "How many delete events are in events.jsonl? One number."                               new
  │ There are 5,217 delete events in events.jsonl.
  └ "Which wiki got the most revisions on 18 June, and from how many labels?"
    dse got the most revisions on 18 June: 5,884 of the 6,543.
  ──────────────────────────────────────────────────────────────────────────────────────────────
  "How many delete events are in events.jsonl? One number."
  There are 5217 delete events in events.jsonl.
  ask       ▏
  ↑↓ to choose · Enter to open · a to ask · b to go back · x to close
```

- A tree: where a thread was asked (`main`, a report, a card) at A0; its threads under it with guides; a thread asked
  from a thread one level deeper. Each thread's row is its question in quotation marks; its secondary row is the first
  line of its latest answer, dim; `N questions` dim at R when there is more than one.
- The selected thread (`❯`, accent) shows under the second rule: its questions and answers, drawn as main's chat draws
  a reply, then the `ask` field.

**The citation panel:**

```
  ‹ back  home › citation 14591                                         show all threads  1 new
  14591 ✓
  found in the command's output, line 1, and a script got the same number
  ──────────────────────────────────────────────────────────────────────────────────────────────
  from     a command's output · line 1
  command  $ cd …/collusion-wiki && python3 -c "import json, collections; …"
  source   "To count by wiki properly, run the label on all 14591 revisions."
    1  all revisions: 14591
    2  dse revisions: 13403
  ✓ the script got 14591, as cited
     1 # Recompute how many revisions revisions.jsonl holds
     2 import json
  ──────────────────────────────────────────────────────────────────────────────────────────────
  run again  ask about it
  follow-up ▏
  r to run again · a to ask · b to go back · x to close
```

- The title is the cited value, bold, in blue and underlined (a link to its place, in place of the accent), `✓` after it
  once a script got it; red when it is not at its place. The subtitle is its status in plain words (section 5).
- Label/value rows: `from`, `command` (a command's output only, through the `Code` element as shell, at most four
  rows), `source` (the reply's sentence in quotation marks, the cited value in it blue and underlined). No `why`.
- The lines: nested at A2, their numbers right-aligned in a dim column, the cited line's number in the text colour and
  the cited value on the selection background. A card value's citation draws the card in its frame, the cited mark on
  the selection background, with no `made by`.
- A verification: `✓ the script got …` (or `× …` in red) at A0, its script nested at A2 through the `Code` element.
- The bottom: `verify  ask about it` (`run again  ask about it` once verified), then the follow-up field.

**The views pane:** one row per view (its glyph, its name, its status dim at R); under the second rule the selected
view's description (the proposal's `why`) as prose, then `open` (`build` for a proposal) and the field
`ask for a change`, whose words go to the view's builder. No unit, overview, zoom, filter, details, files, checks or
fixes.

**A view** (Views, below, for what each part holds): the header with its tabs and search box; the filter row (`filter`
dim, the fields parted by a dim ` · `, `labels` last, the rows counted against R; a field's values open under it as
`value count`, the ones that are on on the selection background, then `+N`); the rule; the overview, a blank row and the
records; the second rule and the selected row's detail. The selected row has `❯` in the margin and is in the
accent across the type area; the row under the pointer shows `?` at R. A view's records leave 3 cells at R for that `?`.
Rows have no bold.

**Tables** (a view's, a file's): the row's glyph at A0 and its name column at A2; column names dim on the row above, not
bold and with no rule under them, with `▼` or `▲` after the sorted one; numbers right-aligned with separators; free text
last. A group: `▾` or `▸` at A0, its heading and count dim; folded, only its heading shows.

**The file browser:**

```
  ‹ back  home › files                                                         show all threads
  Files
  4 files · 42,210 records
  ╭────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search files…                                                                            │
  ╰────────────────────────────────────────────────────────────────────────────────────────────╯
  filter  type · folder                                                                 4 files
  ──────────────────────────────────────────────────────────────────────────────────────────────
    name                      type      records   size (KB)
  ▾ collusion-wiki/  4
❯ ● events.jsonl              jsonl      19,931       5,255
  ● labels.jsonl              jsonl       3,104       1,040
  ──────────────────────────────────────────────────────────────────────────────────────────────
  events.jsonl                                                                 opens as records
     1  {"time": "2026-05-18T06:02:11Z", "event_type": "save", "wiki": "dse", …}
     2  {"time": "2026-05-18T06:02:40Z", "event_type": "save", "wiki": "dse", …}
  Enter to open · ↑↓ to choose · Space to fold · x to close
```

- A folder per group, foldable; an open folder shows its first 20 files, then `… N more`. A file's `●` is in its type's
  hue, or its label value's while a label is on; one type in the whole folder draws dim dots. No overview chart.
- The selected file's first lines show under the second rule, with dim line numbers; Enter or a second click opens it.
- A file: path `home › files › labels.jsonl`, title its name, subtitle `3,104 records · 3,104 lines`, tabs
  `Table  Transcript  Raw` as its kind offers. The Table tab has no overview chart. Raw draws the lines' numbers
  right-aligned in a dim column and the text after a gutter.
- A transcript: per turn, its time dim in a column at A0, then `●` in the speaker's hue and the speaker's name bold; its
  text 2 cells in under the name, up to three rows.

**The label panel**, after the browser's label editor (`frontend/src/files/LabelCard.tsx`):

```
  ‹ back  home › labels › edit purpose                                         show all threads
  edit purpose
  a sample of 30 of 14,591 revisions · 2 min ago
  ──────────────────────────────────────────────────────────────────────────────────────────────
  type    prompt  regex  code
  scope   revisions.jsonl · field body
  prompt  Decide what the revision's body is mainly for. 'message to agents': the body speaks to
          other agents, runs or cohorts, such as asking them to post, relay, confirm or coordinate…
  values  links or data · message to agents · other
  sample  30

  ● links or data      ███████████████████████████─────────────────────────────────    15    50%
  ● message to agents  ██████████████──────────────────────────────────────────────     8    27%
  ● other              ████████████────────────────────────────────────────────────     7    23%

  ▸ examples  12
  ▸ cards  2
  ──────────────────────────────────────────────────────────────────────────────────────────────
  run on the sample  run on all 14,591
  Enter to save and run · e for examples · c for cards · x to close
```

- The subtitle says the last run only (`a sample of 30 of 14,591 revisions`, `all 14,591 revisions`, or
  `◌ labeling 12 of 30`), with its time.
- The fields, each editable: `type` (the kind in use on the selection background), `scope` (the files and the field),
  the definition under its kind's name (`prompt`, `pattern` or `code`; code through the `Code` element), `values`, and
  `sample` (a trial's size). Enter in a field saves the label and runs it on the sample.
- The counts: each value's `●` in its hue, its name, a bar on a track to the whole, its count and its share dim.
- `▸ examples` and `▸ cards` are folded. Open, the examples are grouped by value, each `● value  N` heading at A2 and its
  records at A4: `↗` and the place, `agree  it is …` against R, the record's words in quotation marks and italic, `why`
  dim; after a verdict `✓ agreed` or `✓ set by you`. The cards are their questions, each with `›`.
- The bottom: `run on the sample` and `run on all N` (`stop` while it runs). Errors in red under them.
- The labels list (`home › labels`): one row per label (glyph, name, `prompt · a sample of 30` dim at R), then under the
  second rule the field `describe a new label`, whose words go to main, which makes the label with a trial.

**A report:** the title (in the accent and bold, wrapped) with no subtitle; `Contents` as a bold heading, the sections
numbered in a dim column at A0; then each section drawn as main's chat draws a reply, at A0: its heading bold with
`verify` against R, its prose filling the type area, its cards in their frames, a caption dim under each. A callout: its
kind (`note`, `tip`, `important`, `warning`, `caution`) as a dim label and its text on L, `warning` and `caution` red. A
highlight set's passages: a `●` in the set's hue in the margin. No stats row, no highlight field, no file path. The
reports list: one row per report, its kind and card count dim at R.

**The coverage panel:** a row per file with its state (`●` read, `○` never opened), its name, a bar of what was read on a
track that takes the room the name and the numbers leave, its records and the share read against R; a secondary row of
the lines read (line numbers as written); after a blank row, `all` dim with the corpus's records and the share read. It
does not say how many records a label judged.

### 8. Checks

Testable against what the mod draws (`render_view.mjs --check`, the home and card fixture tests, the lab's ANSI
captures):

1. Bold only on titles, section headings, a card table's column names, transcript speakers, and the model's Markdown.
2. Green only on `new`; accent only on panel titles and the selected row; blue only on links, `?` and `↳`.
3. No letters in a palette hue; letters in red only for problems; no other coloured letters but check 2's and code's.
4. No two blank rows in a row; no blank row next to a rule; one blank row under each card's title.
5. Every card has a full border in the rule grey.
6. Every rule is as wide as its type area; a panel has two rules at most.
7. Every run that opens a row starts on M, A0, A2, A4, L, a table's column or a tree's guide.
8. Columns are parted by 2 spaces or more.
9. No background but the panel's, the selection's and the tip's; no inverse but on the selected tab and under the pointer.
10. No prose is cut at a fixed measure.
11. Every panel starts with the path row and a bold title in the accent (the citation panel's is a blue link), and ends
    with its key-hint row.
12. Every non-ASCII character the mod draws, outside the corpus's and the model's words, is in section 5's table.
13. A right-click opens no menu.
14. No centred row.

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
- `text`: a long field wrapped in full across the type area, up to 12 lines.
- `lines`: a list field whose values are lines as written, drawn under a dim heading with their numbers dim in a
  column (the file browser's first lines of a file).
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
| `table` | `columns: [{field, label?, show?: text\|bar\|chips, width?}]`, `sort?: {field, desc?}`, `group?`, `color?` | a row per line, as section 7's "Tables": the row's glyph at A0, the title column at A2, regular; the column names dim on the row above, a click on one sorts by it (`▼` or `▲` after it); numbers right-aligned; a name of three words or fewer (the title or a link) cut in the middle, a longer title at its end; the title column wide enough for its typical name, then for nine in ten names whole, before other columns widen; columns that do not fit the panel left to the detail, long text first, then the last, a column of tags last; `bar` adds a bar scaled to the column's largest value; `chips` draws a list's values as tags (a flagged one first), as many as fit whole and the rest counted (`existed before +1`), the column wide enough for each row's first tag and the count, up to 20 cells; `group` sets the rows under a heading per value of a category (`▾` or `▸` at A0, its value, its count dim; a click or Space folds it to its heading), the rows keeping the columns; `color` names the category whose hue each row's glyph takes when the tab has no overview |
| `list` | `meta?: [fields]`, `text?`, `tags?: [fields]`, `sort?`, `group?` | an item in two rows: its glyph at A0 and its title at A2, regular, its meta fields in aligned columns after it (a category in the text colour, a number right-aligned, other text dim; the colour field left to the glyph; columns that leave the title less than about half the width left to the detail); under the title, at A2 and dim, `text`, then after a gutter the `tags` (category or list fields, in the text colour), a flagged one first, in red |
| `lanes` | `lane`, `time`, `end?`, `color?`, `lanes?: {collection, label?, start?, end?, parent?, group?, meta?}` | a time axis, a lane per value of `lane`, or per row of `lanes.collection` (whose key `lane` holds, each lane under its `parent` with tree guides, its span from `start` to `end`, under a heading per value of `group`, its `meta` fields in columns beside its name; a heading, after a blank row, shows the linked row's title, regular, and its fields of the same names dim, and a click on it selects that row; a lane per value of the colour field starts with its glyph); each row a mark `●` in the hue of its `color` value or of the label on, a flagged row `×` or `!` in red, the selected one on the selection background; a click on the axis zooms in, and the zoom narrows the tab's rows |
| `graph` | `edge` (a link to the tab's collection), `label?`, `meta?` | boxes and arrows, drawn as the diagram card draws them, an arrow from the row `edge` names; a tree of more than 10 rows as an indented tree with its `meta` fields in columns; at most 40 rows |
| `bars` | `field`, `value?`, `agg?: count\|sum\|mean`, `color?` | a bar per value of the field, largest first, as the bar card draws them (labels at A0, bars from the label column, numbers against R with thousands separators), or with `color` each bar stacked by that field's values with their legend under the bars (two or three values: the first part of the whole, "7 of 8"); a click on a bar keeps the rows with its value, on a legend's value the rows with that |
| `transcript` | `speaker`, `text`, `time?`, `sort?` | turns: the speaker's `●` in its hue at A0 and its name at A2 in the text colour (a flagged turn's glyph and value after it, in red), the time dim against R; the text under the speaker at A2, upright, to three rows |
| `histogram` | `time`, `color?` | counts over the whole span in a strip two rows high, a bin per column, each bin in the hue of its commonest `color` value (or of the label on that marks most of it), in the text colour without one; its scale at its left (the most rows in a bin, and 0, right-aligned before `┤`), the axis's ends and middle under it, dim, and the colours' legend (two rows at most); bins outside the zoom dim; a click on a bin zooms to half the span around it. As the overview over `lanes` on the same time, it stands on the lanes' axis (their names under its scale), so a mark sits under its bin, and the lanes show the strip's window |
Colour (the visual system, section 4): the panel colours one field per tab, its overview's colour field (a bar's
`field`, a strip's or lanes' `color`, lanes' own field when it is a category, or a table's `color` when the tab has no
overview), in thimble's palette, the same in the
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
these views use: a collection's `opens`, a field holding a file's path, so a second click (or Enter) on a row opens that
file, where the first selects it; the spec's `up`, the step the path row shows before the file's name (`files`), which
← or backspace go back to when no followed row is left to go back to; the spec's `source`, the file the view shows,
which a side thread about a row is told. Their tabs may leave out `overview` (a file's raw lines have nothing to
overview): `validateSpec(spec, {builtin: true})`, `render_view.mjs --builtin`. Their title row has no `N files ›`, since
they read no file but their own (the tree shows it only when it left files out).

The tree (the visual system, section 7, "The file browser"): one tab with no overview, its filter row `type · folder`,
a table grouped by folder (`▾` or `▸`, the folder and its file count; the first folder open, a folder of more than 20
files showing its first 20 and `… N more`), with the columns name, type, records and size. Each file's glyph takes the
hue of its type (its extension: the table's `color`). The selected file's detail is `opens as` and its first lines
(`head`, at most 6 lines of 160 characters, as written; a binary file has none). A table of records has no overview
either: its filter narrows the records.

## Visual hierarchy

A view is read by skimming: what the groups are, which items matter, what state each one is in. The panel draws every
view on the visual system's grid (above): a group's heading at A0 after `▾` or `▸`, an item's glyph at A0 and its title
at A2, its secondary text dim at A2, numbers against R. The view's title is the only bold, in the accent; a group's
heading and the column names are regular and dim, and the rows are never bold. The selected row has `❯` in the margin
and is in the accent. Colour goes only on the colour field's glyphs and marks and on flagged values. The tab's colour
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
   not left with problems no builder was asked to fix. `ask for a change` in the views pane sends the analyst's words to
   a new builder (`prompt/view-change.md`), whose view then goes through the checks and reviews again.
6. **The state** of each step is `status.json`: `state` (building, checking, reviewing, revising, built, failed,
   stopped), `attempt`, `round`, the last checks' lines, the review's problems being fixed, fixed and left, and why it
   failed; while the last fixes are reviewed it reads "checking the last fixes". A proposal of main's has a
   `↳ view · <name> · <state>` row under the answer that proposed it, `new` in green after a built view until the
   analyst opens it, and `build` after a proposal; a click on a built one opens the view, on any other the views pane.
   The views pane lists each proposal by its glyph, its name and its state: `○` proposed or stopped, `◌` building,
   checking or reviewing, `●` built, `!` built with problems left, `×` failed. `/thimble-views` opens it (the chosen
   view's description, then `open`, `build` or `stop`, and `ask for a change`); `/thimble-views build <name>` builds
   one.

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

The panel draws, top to bottom (the visual system, section 7, "A view"): the path row; the title row (the view's name in
the accent and bold, and "N files ›" against R, which opens the files read, the files left out and the fields the reader
made); the subtitle, dim (its stats, "N unreadable lines" in red when the reader reported any, and the window of a long
file's lines; counts of a thousand or more with separators); the tabs, when there are several, the active one inverse;
the bordered search box (`⌕` and a dim `Search <collection>…`, or the query while typing); the filter row (`filter` and
each field, the rows counted against R: in the words of the `count` stats of the tab's collection that count different
rows, when those hold most of the tab's rows, each "N of M" where the filters or the tab's own `where` leave some out;
else by the collection's name), the open field's values under it, and the filters that are on, on a row of their own; a
rule; the overview under its title row; a blank row; the records; a rule and the selected record's details; the key-hint
row. The whole panel stands on the background Claude Code gives a docked pane (`composerSidebarBackground`); the filters
on take the selection colour (`selectionBg`), which shows on it in light and dark themes, and nothing else has a
background.

What the analyst does, all drawn by the view and changed only by their clicks and keys:

- a tab; a field of the filter row (its values open under the row; the same field again closes them), a value (keeps
  its rows), a `+N` (the field's other values, or the fields that did not fit); a filter that is on (turns it off)
  and `clear all`; a column's name (sort), a group's heading (folds the group to its heading, `▸`, and opens it again,
  `▾`); the overview: a strip's bin or lanes' axis (zoom), a bar
  or a lane (keeps its value), a box (selects it); the zoom, shown among the filters that are on (unzooms);
- a row, a mark, a node or a lane: its detail under the view (a second click closes it); a link in the detail or a
  related row: that row, `‹` back;
- `↗ <place>` in the detail, or a line under "N unreadable lines": the citation panel on that place, as anywhere
  in the mod; a right-click does what a click does (there is no menu);
- `?` beside the row under the pointer or the detail's title, or the `?` key: a side thread about the row, told the
  view, what one row is, the row's fields as shown, and its place;
- `labels` in the filter row shows each label: a click on its name turns it on (the name on the selection
  background) and makes it the tab's colour field, so the rows' glyphs, the lanes' and strips' marks and the legend
  take its values' hues and the rows it does not mark a dim `●`; the count beside it keeps only the rows it marks;
- "N unreadable lines" and "N files ›" on the title row open them under the view;
- keys once a click has given the view the focus: ↑/↓ (or j/k) step through the rows, page up and down, home and end,
  ← or backspace back, tab the next tab, `/` search (typing goes to the search until return), `[` and `]` scroll the
  detail, `o` or return open the row's place, Space folds the selected row's group, `?` a side thread; the wheel scrolls the list, or the detail when over
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
hit as `{op: "hit", i, s}` (with `ask` for its "?"), and register.tsx maps each to the act
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
