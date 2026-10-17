# The terminal UI's visual system

How every surface of terminal mode draws on Claude Code's character grid: main's chat, cards and the panel. The
hooks' comments cite its rules and sections by number ("SPEC.md rule 7", "SPEC.md, section 7, "Home""). A view built
in terminal mode is drawn by its own program on the terminal view kit (docs/terminal-views.md), in this visual system; a
view built in browser mode is one line, and it opens in the browser.

## The visual system

The terminal has one typeface and one size, so position and space carry the structure that type sizes carry on paper.
Weight and color stay rare, so that each one means one thing. Columns and intervals follow Josef Müller-Brockmann,
*Rastersysteme für die visuelle Gestaltung / Grid Systems in Graphic Design* (Niggli, 1981); the rule that contrast is
read only when it is rare follows Emil Ruder, *Typographie / Typography* (Niggli, 1967). The panel's chrome follows
Claude Code's own panels (its Artifacts and Background panels): an accent title, an inverse tab, bold section headings,
`❯` on the selected row, metadata dim at the right, and a dim italic row of key hints. Where Claude Code has a way of
drawing something, thimble-term draws it that way. These rules apply to everything thimble-term draws. Claude Code's
own drawing (its `❯ ⏺ ✻ ⎿ ✕`, tool rows, subagent rows, Markdown in replies thimble-term does not draw) is outside
them. Colors are in `hooks/paint.ts`; `hooks/chrome.tsx` draws the panel's chrome; `hooks/reply.tsx`, `draw.ts`,
`card.tsx`, `cite.ts`, `para.tsx`, `home.ts`, `homeview.tsx`, `panel.tsx` and `register.tsx` draw.

### The rules

1. One left edge: the reply's text column (2, Claude Code's own) in the chat, A0 in a panel; indent only to nest (an item,
   an output, a child).
2. Marks hang in a 2-cell margin left of that edge: `❯` on the selected row, `?` or `↳` by a passage; in the chat the
   margin is the ⏺'s, and a mark takes the ⏺'s cell on the row where both fall.
3. Thimble's text fills its column, with no fixed measure; cards take the same width as the text.
4. Every card has a full round border in the rule gray; inside it, its title in bold (wrapped, never cut) with its id
   dim at the right of the first row (`card:<name>`, the words its chips read), a blank row, then its plot or body, and
   everything else (the readout, the label rows, the params, then after a blank row the takeaway) below the plot.
5. Every panel opens with its title row, the path from home with the current step last in the accent color and bold, then
   a dim subtitle, a rule; key hints end it.
6. A panel's actions sit at its bottom, after a rule, where their result appears; the title row holds only navigation.
7. Bold is for titles and headings: panel titles, a card's title, section headings, a card table's header, speakers,
   the model's Markdown.
8. New is the word `new` (or `N new`) in green after the new thing; opening the thing clears it.
9. Dim is secondary: labels, counts, times, metadata against R, secondary rows, separators, key hints.
10. Links are blue and underlined: citations, the place after `↗`, a label's name on a card; the `?` and `↳` are blue. A
    chip (a citation that names only its place) is blue in brackets, `[ card ]`, not underlined.
11. Red means a problem and only a problem: `×` failed, `!` usable with a problem.
12. A palette hue goes only on the marks of a color field; a chart's one series is a field of one value, in the first hue.
13. `❯` and the accent mark the selected row; the selection background a choice in use; inverse the tab and the pointer.
14. Code is colored as Claude Code colors it; a record's own words are in quotation marks and italic.
15. One glyph, one meaning (section 5); groups and folders fold with `▸ ▾`; a right-click does what a click does.

### 1. Channels

Each channel has one meaning. A run the table does not cover is regular, in the text color, on the panel's background.

| channel | its one meaning | never used for |
| --- | --- | --- |
| position | what kind of thing a run is: the column it starts on (section 2) | |
| the margin | a mark beside a row: `❯`, `?`, `↳` | text |
| a blank row | the end of a group; the gap under a card's title | spacing inside a group |
| a rule `─` | the end of a region: under a panel's header, above its bottom part | the line under a heading |
| a border | a card, and a text field | a panel's regions |
| **bold** | a title or a heading (rule 7), a plan step's title; a citation or a card's evidence link under the pointer | names in a list, values, the selected row, new |
| green | new; a citation panel's `checked` | anything else |
| diff green and red | the lines a diff added and removed, and their marks | anything else |
| dim | secondary | a name, a number in a number column, a flagged value, a control |
| blue, underlined | a link: the place after `↗` outside a card, a label's name on a card | controls, rows a click selects |
| purple, underlined | a citation's value; in a card, every citation and evidence link (`↗ events.jsonl line 197`), so a card has one underline color; an example's `●` is purple too, so a card has one evidence color | controls |
| blue, in brackets `[ … ]` | a chip: a citation that names only its place (`[ card ]`) | controls, a citation with words |
| blue | the `?` and `↳` in the margin | |
| accent | a panel's title, the selected row, the acts of the rows above the prompt and the thimble line's names | anything else |
| italic | a record's own words (in quotation marks); the key-hint row | emphasis, captions |
| inverse | the selected tab; the control, mark or bar label under the pointer; a card's title under the pointer | anything at rest, a citation |
| selection background | a choice in use: a card's parameter, a label's type, the chosen record of a file, the words a find matched, text being dragged | rows, hover |
| citation purple background | the cited value where it stands in its place: its lines, a card's data row or code (paint.ts citeHighlight) | anything else |
| tip background | the tip of a view's region under the pointer | anything else |
| check tint | a passage a check commented on: its check's color blended toward the theme's ground (a pale wash on a light theme), its plain words in the theme's text color; a theme key (`userMessageBackground`, `selectionBg` while open) while thimble cannot tell the theme | anything else |
| palette hue | a value of the region's one color field | letters, headings, backgrounds |
| red | a problem | negative numbers, hover |
| code colors | code: a script, a label's code, a command, inline code | prose |

### 2. The grid

The horizontal unit is the cell and the indent step is 2 cells. The vertical unit is the row.

**The chat column**, where thimble-term draws in Claude Code's transcript, uses the columns Claude Code already has:

| column | holds |
| --- | --- |
| 0 | Claude Code's `❯ ⏺ ✻`; the reply's margin: a passage's dim `·`, the `?` that takes its place (or the ⏺'s) under the pointer, a passage's `↳`, each in the ⏺'s cell on the row where both fall; the `↳` that starts a `↳` row |
| 2 | the reply's edge, where Claude Code's own reply text starts: prose, headings, a list's `-`, a card's left border, the footer; the words of a `↳` row; the toast above the prompt |
| 4 | nested: a list item's text, a quote block, a card's content (inside its border and padding) |

**A panel's columns.** The pane has 1 cell of padding at each side; the margin M is the 2 cells after the left padding;
the type area runs from A0 to R.

| axis | column | holds |
| --- | --- | --- |
| M | the 2 cells left of A0 | the margin: `❯`, a passage's `?` or `↳` |
| A0 | the type area's first cell | the edge: the title row, subtitle, tabs, rules, headings, prose, field labels, a card's border, a state glyph, a fold marker, a tree's guides, the key-hint row |
| A2 | A0 + 2 | an item's name after its glyph, marker or guide; a secondary row; nested content (a command's output, a list item's text) |
| A4 | A0 + 4 | a second level: the name of a folder's file or of an unfolded group's item after its own glyph at A2 |
| L | the label column's width (its longest label + 2) | the values of label/value rows and fields |
| R | the type area's last cell | numbers, metadata (dim), navigation (`earlier  later`, `show all threads`) |

1. **Axes.** A run that opens a row starts on M, A0, A2, A4, L or a table's column. A tree deeper than A4 goes on with
   guides `├ └ │`, 2 cells a level; the file browser's folders go on 2 cells a level with no guides, as the browser's
   tree indents them.
2. **Marks hang.** `❯`, `?` and `↳` sit in the margin, so text keeps its edge with or without them. A state glyph or a
   fold marker sits on A0 with its item's name at A2. In a file's table the chosen record shows its `?` under the
   panel's header, since the margin holds `❯`.
3. **Space.** 1 cell is a word space. ` · ` parts the items of one inline list of facts. 2 cells are a gutter: between
   columns, a label and its value, two controls. A gutter is never 1 cell.
4. **Columns.** The name first, then categories, then numbers, then free text. Text columns align left; number columns
   align right, each on its own axis, the last on R. A row's metadata (a kind, a status, a time, a count of parts) is one
   dim run against R, parted by ` · `. A unit shared by a column goes in the column's name (`records`).
5. **Shared axes.** A component works out its columns once for all its groups; the sections of one panel share A0, A2
   and R.
6. **Label/value rows and fields.** The label is dim and lower case, in the label column; values and fields start on
   L. It has no colon, except in the label panel's fields, which Matt laid out as `name:`, `kind:`, `scope:`. A value
   that is a list puts each item on its own row after a `-`.
7. **No measure.** Prose, a thread's answer, a document, a definition and a detail's text fill the type area (in the
   chat, the terminal's width less the margin). Cards take the same width as the text.
8. **Flush left, ragged right.** Nothing is centered or justified.

**Rows.**

9. No blank row inside a group, one between groups, never two, none at the top of a region. A card has one blank row
   under its title.
10. A rule divides a panel's regions: under the header, and above the bottom part (a detail, a selected thread, the
    actions). A panel has two at most. A rule spans the type area in the rule gray, and no blank row is ever next to it.
11. **A card** has a full border with round corners in the rule gray and 1 cell of padding: in Ink, a `Box` with
    `borderStyle="round"`, `borderColor` the rule gray and `paddingX={1}`. Its left border sits on the stream's edge
    (column 2 in the chat, A0 in a panel). Inside: the title rows in bold (the question wrapped, never cut, the card's id
    `card:<name>` dim at the right of the first), a blank row, then the plot or body; below the plot, the readout row
    (the value under the pointer, plain, or what thimble is doing to the card), the label rows, the params row and,
    after a blank row (the readout row where it is the last), the takeaway. In the card pane the question is the panel's title, so the box starts with the
    plot. In a stream a card's border stands in for blank rows next to it; a document's caption is dim on the row under
    the bottom border.
12. Every item of a list takes the same number of rows: one, or a name row and a dim secondary row. The selected item
    may open more under it. A transcript's turn takes its time-and-speaker row and up to three rows of text.

### 3. Type

13. **Bold** marks a title or a heading: a panel's title, a card's title, a section heading in a panel, a card table's
    column names, a transcript speaker's name, and the model's own `**…**` and `#` headings, drawn as Claude Code draws
    Markdown. thimble-term adds no other bold: not on names in a list, values, the selected row or anything new. Claude
    Code draws a Button that is not `plain` as a bold `[ label ]`, so every Button stays `plain`.
14. **New** is the word `new`, or `N new` after a count, in green: a thread with an answer not yet read, a view built and
    not yet opened, a document written and not yet opened, a card or a label run that home has not shown yet. It
    follows the item's name, which stays regular, wherever the item shows (home, a `↳` row, a step of the path, the
    threads tree, `show all threads`, the toast above the prompt). Opening the item clears it.
15. **Dim** means secondary: labels and units, counts, times, places in a secondary row, the `·` and `›` separators, axis
    labels, metadata against R, secondary rows, `○`, and the key-hint row (dim and italic).
16. **Underline** means a link: a citation's value, the place after `↗`, a label's name on a card, a URL. Links are blue.
    Names and rows that a click selects or opens are not underlined. A chip is a link its brackets mark, so it has no
    underline (section 7, "Main's chat").
17. **Italic** means a record's own words quoted among the model's or thimble-term's, always inside quotation marks: an
    example card's records, a label's examples, a quote block. A file is drawn upright, since everything in it is a
    record's. The key-hint row is italic too, as in Claude Code's panels.
18. **Inverse** marks the selected tab, and the control, citation, chart mark, bar label or card title under the pointer
    or the keyboard focus.
19. No blink, strike-through or capitals for emphasis. Kind words, field labels and steps of the path are lower case,
    names are as written, headings are in sentence case.

### 4. Color

| color | theme key | drawn on | means |
| --- | --- | --- | --- |
| text | `text` | letters and controls; state glyphs; the bar under the pointer | content |
| dim | `inactive` (`dimColor`) | letters (rule 15); the catch-all value's marks | secondary |
| rule gray | `subtle` | lines only: rules, card borders, a field's border, tracks, axes, tree guides, a diagram's boxes and edges | structure |
| link | `remember` | links (rule 16); the `?` and `↳` in the margin | opens what it names |
| accent | `suggestion` | a panel's title; the selected row's `❯` and its text; the acts of the rows above the prompt and the thimble line's names, underlined under the pointer; the label panel's actions, underlined | where you are; a button |
| new | `success` | the word `new` and `N new` | new |
| tip | `userMessageBackground`, a background | the tip of a view's region under the pointer; a check's passage while the theme is not known | |
| prompt | `userMessageBackground`, a background | a side thread's question, across the type area, as Claude Code draws a prompt | the analyst's question |
| inline code | `permission` | inline code in thimble-term's own paragraphs | code |
| palette | `SERIES`, the browser's seven series hues; `LABEL_HUES` and `PICKED_HUES`, its eighteen label colors (palette.gen.ts, from tokens.css: the light paper's on a light theme, Dark's on any other) | `●`, marks, bars, swatches; a check's tint (its place blended 16% toward the ground, 30% while open) and its `⚑` | a value of the color field; a check's comment |
| red | `error` | a problem's words and its `×` or `!`; the label panel's `delete` and `y to delete` | a problem; a delete |
| diff | `diffAddedWord`, `diffRemovedWord` | the lines a diff added and removed, and their marks | a diff, as Claude Code colors one |
| selection | `selectionBg`, a background | a choice in use (rule 21) | |
| panel | `composerSidebarBackground`, a background | the whole panel | |

Code blocks (a script, a label's code, a command) are drawn by Claude Code's `Code` element, with its own syntax colors
and, given `startLine`, its dim gutter of line numbers.

20. **One color field per region**: a card's group or label, the file browser's labels that are on, a transcript's
    speakers. While a card reads a label, the label is its field; while a label that is on marks a file's records, it is
    the file's field, and a transcript's speakers' `●` take the text color. Its hues go on glyphs and marks; a value's word stays in the
    text color (`● dse 3,908`). A chart with no color field is one series, drawn in the first hue. The bar or mark
    under the pointer turns the text color and its readout stays plain. A field colors at most six values, past which
    its marks take the text color (transcripts cycle the hues). A label's values take the colors their classes have,
    the browser's label colors (`LABEL_HUES`, then `PICKED_HUES` for red, purple and pink, which the analyst picks in
    the label panel by the names show_label takes), wherever they show: the label panel, home, a label card and a card that read the label; a label with no
    classes takes the series in its values' order. A label's catch-all value ("other", a class with no color) takes dim
    marks. A field with one value draws dim marks.
21. **The selection background** marks a choice in use among choices shown together: a card's parameter, a label's
    type (`prompt  regex  code`), the chosen record of a file, the words a find matched in a line, text being dragged.
    The cited value where it stands in its place (the citation panel's lines, a card's data row or code, a thread's
    subject lines) is on the citation's purple instead (v9 review: "the cited value highlighted in purple"): Claude
    Code's violet blended toward the theme's background, the words on it in their own color. Selected rows use `❯` and the accent instead (rule 13 of "The rules"), and the selected tab uses inverse.
22. **Red** marks a problem and only a problem: a failure, a citation whose value is not at its place, a card that
    cannot be drawn, a run's error, a document's warning or caution. `×` is a failure and `!` something usable with a
    problem. Negative numbers are drawn as positive ones are.
23. No other color: no warning amber, and no green except `new`, a citation panel's `checked` and a diff's added lines. A diff's added and removed
    lines and their marks take Claude Code's own diff colors, `diffAddedWord` and `diffRemovedWord`, not `success` or
    `error`.

### 5. Symbols

One glyph, one meaning, everywhere. A glyph and a word that say the same thing are never drawn together (`○ Edit Bursts`,
not `○ Edit Bursts proposed`). Besides the words of the corpus and the model, the terminal UI draws no non-ASCII character
outside this table.

| glyph | its one meaning | color |
| --- | --- | --- |
| **state**, one per item, on A0 | | |
| `○` | not started: proposed, stopped, queued, a file never opened | dim |
| `◌` | running: building, checking, answering, writing, labeling | text |
| `●` | one thing that is there: an item built, answered, written or read; a value's swatch; a record's or event's mark | a state: text; a mark: its value's hue (rule 20) |
| `!` | usable with a problem | red |
| `×` | failed | red |
| `✓` | confirmed: thimble's links check found the cited value, the analyst agreed with a record | text |
| **margin** | | |
| `❯` | the selected row | accent |
| `❯` on the prompt background | the analyst's question in a side thread, as Claude Code marks a prompt | dim |
| `❯` between an entry box's rules | where the analyst types a question, as Claude Code's prompt box marks it | text |
| `⏺` | an answer: main's reply (Claude Code's own) and a side thread's answer; dim, a side thread's turn at work | text |
| `⎿` | under a side thread's question or its turn at work: its latest words, or how it ended without an answer, as Claude Code writes a result under a call or an interrupt under a prompt | dim |
| `⚑` | a check commented on the passage that starts on this row (it wins over `↳` and `?` there) | the check's color |
| `?` | ask a side thread about this passage (shown under the pointer; under the header for a file's chosen record) | link |
| `↳` | a side thread was asked here (in a reply's margin, a click opens it); the start of a `↳` row | link in the margin; dim on a row |
| **navigation** | | |
| `›` | into: opens one level in (`open ›`, `all documents ›`); between the steps of the path | text; dim between steps |
| `‹` | back one level (a slide's `‹ 3 of 9 ›`) | text |
| `↗` | opens what it points at: a place in the corpus (the place after it), a label (its name before it) | link |
| `▸` `▾` | a folded or unfolded group or folder; a click toggles it | text |
| **data** | | |
| `◆` | three or more marks in one cell | text |
| `█` and `▏▎▍▌▋▊▉` | a bar and its last eighth | hue (rule 20) |
| `▁▂▃▄▅▆▇█` | a strip's bins | hue |
| braille | a line chart's lines | hue |
| `─ │ ├ └ ┤ ┬ ┴ ╭ ╮ ╰ ╯` | lines: rules, card borders, a field's border, tracks, axes, tree guides, a diagram's boxes; an entry box's rules | rule gray; an entry box's in the prompt box's border color (`promptBorder`) |
| `→ ← ↓ ↑` | the direction of a diagram's edge | rule gray |
| `┊` | the pointer's column on a chart | rule gray |
| `▼ ▲` | the column a table is sorted by | dim |
| **text** | | |
| `…` | text cut short | as the text |
| `… N more` | N rows not drawn; a click draws them; never for one row | dim |
| `+N` | N values not drawn in a cell | dim |
| `·` | between the items of one inline list | dim |
| `"…"` | someone's own words: the analyst's question, a record's words | as the text |
| `-` | an item of a list | text |
| `[ … ]` | a chip: a citation that names only its place, its short name inside (`[ card ]`, `[ events.jsonl line 12 ]`) | link |

Not drawn: `▶`, `✗ ◇ ■ □ ━ ┃ • ✕ ❚❚ ⓘ ✦ ❢ ⚠ ≡ ╱ ▤ ❝ ┿ ∴ ▪`, a braille spinner, `[ ]` around controls (brackets are a
chip's only).

**Words that recur.** Plain, short words. A place reads `revisions.jsonl line 10566` or `lines 3-8`, never `#L`. Every
cut is one cut (`hooks/lib.ts` `cut`): at the last word that fits, mid-word only when a word fills more than half the
room, `…` right against the last word kept, with no space or punctuation before it; a row, a title, a path step, a
preview, a context line (cut at a word at each end) and a tip all cut that way. Words in quotation marks that end what
is cut are cut inside the marks, and the closing mark stays (`thread "Which line of…"`); words in quotation marks that
open in what is kept and close after the cut keep their closing mark too (`citation card "How…"`). An inline list of
facts parted by ` · ` (a label example's other fields) keeps whole items and ends ` · +N` for the N left out, never a
`…` against a whole value (which reads as a cut one), `·…` or a key without its value. A file's line of code or data (JSON, a tag) is cut at the cell edge, so a file's rows end
together; prose is cut at a word. Someone's words in quotation marks take straight ones, curly ones (`“…”`) when they
hold straight ones of their own, and none when they hold both. A count
reads with thousands separators from 1,000 wherever thimble-term draws it; a number that names a thing (a line, a year,
an id) reads as written. No hex or hash ids: a card is named by its question, a thread by its first question, a script
by its file name. A citation's status reads `found on the card`, `found in revisions.jsonl line 10566`, `found in the
command's output, line 1` or `not found: …`, then why for a problem; a citation in a card's takeaway reads `checking`
while thimble's links check runs. Words that show no value (`the event`) read `found in …; only its place is checked`,
and never what a script got. In the citation panel's bar, a citation still checked reads `◌ checking …`.

### 6. Controls and fields

24. A control is a word or a few, in the text color and plain: no brackets, bold, color or underline at rest, inverse
    under the pointer or the focus. Its words say what it does (`run again`, `put in the prompt`, `run on a sample`,
    `as slides`, `show all threads`). The label panel's actions are the exception: underlined in the accent (a delete
    in red), so they read as buttons (Matt, deck/video v9 review and mockup labelpanel2; `chrome.tsx` `actionEl`). A question to a side thread is typed into an entry
    box (rule 27), never asked through a control (Matt, 2026-10-16: an entry box in Claude Code's style in place of
    `ask about it`).
25. A panel's actions sit at its bottom, after the second rule, at A0, 2 cells apart, with their fields under them: that
    is where a reply, a run's counts or a writer's state appear. A panel with an entry box ends with it: its actions
    stand above the box after a blank row, and the box's top rule is the panel's second rule (a citation, a card, a
    check's comment, a document's chosen comment, a thread). The title row holds only navigation, against R
    (`earlier  later`). A reply's footer has its facts, then its controls after a gutter.
26. The key-hint row is a panel's last row: dim and italic, at A0, the bound keys in Claude Code's words, parted by
    ` · ` (`↑↓ to choose · Enter to open · a to ask · b to go back · x to close`), in one order on every panel: choosing,
    Enter, Space, the panel's own keys, going back, closing. It names only keys that are bound on that panel (`b to go
    back` only where there is a way back). Nothing else in a panel or the chat says which key does
    what. The keys are Buttons with no label of their own, in a Box no row tall (`hiddenKeys`). While a text field
    holds the panel's focus (a label's name being renamed, the field `describe a new label`), a letter goes into the
    field, so the row reads what Enter does and `Esc to leave the field` (`Enter to rename · Esc to leave the field`);
    while an entry box holds it (a new thread's, which takes it as the view opens; any other once `a`, Enter or a click
    gives it the keys) the panel draws no hint row, as Claude Code's prompt box has none (Matt, 2026-10-16: no
    `Enter to ask · Esc to leave the field` row). Esc gives the keys back to
    the prompt, and while the prompt holds them the row names none of the panel's keys (a letter or Enter would go to
    the prompt, and Enter to main), only `click the panel for its keys`; so does every panel that opened without the
    keys (home from the toast's `open ›`), which asks for them once more a moment after it opened. A list (home, the
    threads tree, the lists, the file browser, a file's lines) is drawn by a Client, which takes keys only after a
    click, so the pane's own keys reach it: an Input between two Buttons, all no row tall (`RELAY`), the focus ring on
    the Input (`autoFocus`). While an Input holds the ring, ↑ and ↓ move the ring and never scroll the pane, so a move
    onto either Button is turned into ↑ or ↓ for the list; Enter submits the Input; a letter, a digit or Space goes into
    it and is the panel's hotkey by its letter, Space for the list where the row names it (`Space to fold`), and
    Backspace shortens it (`Backspace for the files` in a file's view). ←, →, the page keys, Home and End reach no
    element then, so no row names them. A letter the panel does not bind goes to the prompt; the panel then draws
    neither the relay nor its hotkeys until the prompt has the keys, and its row says `click the panel for its keys`.
    The row names the list's keys only once a `ui.focus` says the ring rests there. A click on a list, on a row or on
    an empty part, hands the keys back to the pane. A list taller than its pane is cut to the rows the pane leaves it
    around the chosen row, `↑ N more` and `↓ N more` dim above and below (a click moves a page, the wheel a row), so
    the chosen row and the hint row always show. A choice that moves up to the first row shown, or above it, starts the
    rows shown at the row that leads it: on home its section's heading, and the top for the first row the keys choose,
    so every row can be reached by keys. No letter is a hotkey unless the hint row names it, or, in a view, the list
    its `?` opens: a word typed while the panel holds the keys (`table`) then reaches the prompt whole.
27. A field: its label dim and lower case on the label column, the field on L, no colon (`describe a new label`, the
    label panel's `prompt`). A field that shows all of its text (the label's prompt) has a border in the rule gray; a
    click gives it the keyboard. An entry box, where the analyst asks a side thread (`entry.tsx`), is Claude Code's own
    prompt box: a rule above and a rule below in the prompt box's border color, each from the margin's edge to R; `❯`
    in the margin; Claude Code's Input on L, two rows tall, taller as its text wraps (at most 10, then it scrolls
    within), its placeholder dim saying what it asks about (`ask about this citation`, `ask about this card`, `ask
    about this comment`, `ask a follow-up question`, a new thread's `type your question`); Enter's word is `ask`,
    Shift+Enter breaks the line. No label, and no other row says how to use it.
28. An empty region shows `none`, dim, at A2.
29. A right-click does what a click does. There is no menu.

### 7. Surfaces

The sketches are rows as drawn. In the panel sketches the first two columns are the margin M. What is bold, dim or
colored is said under each.

**A panel's header**, the same on every panel:

```
  home › files › events.jsonl
  jsonl · 19,931 records · lines 201-400 of 19,931                                    earlier  later
  Table   Transcript   Raw
  ──────────────────────────────────────────────────────────────────────────────────────────────
```

- The title row, one row for the path and the title (Matt, 2026-10-07: "If we show Home > Threads (where threads is
  bold & colored) where home is clickable, we don't need to show < back and home > threads above. can just be one line
  for title. it already says 'b to go back'"): the steps from home parted by a dim ` › `, each earlier step dim and a
  click away (a click on a step goes back to it; a click on the list a step stands in, such as `files` before a file
  opened from a citation, goes to that list in its place), each as a lower-case kind word and its name (`thread "how
  many…"`, `citation 5884`, `card "How many pages…"`, `edit purpose`, `files`, `events.jsonl`); then the current step,
  its title in the accent color and bold: a list's title (`home › Threads`, `home › Documents`, `Home` alone on home), a
  subject by its step's words with its whole name (`home › card "How many pages does each wiki have?"`, `home ›
  documents › "Agents used the dse wiki…"`, `home › threads › "How many delete events…"` for a thread chosen in the
  threads panel), a citation's value as its link after `citation` (section 7, "The citation panel"). No `‹ back` and no
  row of its own for the path: b goes back, and the hint row says so. A step whose thread has new answers is followed by
  `new` in green; one whose thread is answering starts with `◌`. Navigation stands against R (`◌ loading…` on a view).
  On home, at R: `show all threads`, which opens the threads panel, then `N new` in green while answers wait. Every
  other panel leaves them out (Matt, 2026-10-07: "does 'show all threads' really need to be there when you're not in a
  thread?"): the threads panel is the threads, and on a view, a file, a card, a citation, a label or a document they are
  not the subject, and home is one click away. The row never wraps: in a narrow pane `show all threads` shortens to
  `threads` (with `N new`, then alone), so the threads stay one click away, then gives way to the steps; where the path
  does not fit, the earlier steps shorten first (each to 34 cells, then down to 12, then folded, oldest first, into one
  `…` after home), then the current step is cut with `…`. No key shows all threads.
- The subtitle under the title row: the subject's facts, dim, parted by ` · `, with a problem in red. A panel with no
  facts worth a row has no subtitle.
- Tabs, where the subject has them: each tab's name with a cell of space at each side, selected or not, the selected one
  inverse, so choosing a tab moves none; the row starts one cell left of A0, so the first tab's left cell hangs in the
  margin and its name starts at A0 with the title.
- Claude Code's pane title says what the panel shows (`Citation`, `Threads`, `Label: …`, a card's question, a
  document's title).
- No `[ close ]` row: Claude Code's `✕` and the `x` key close the pane.

**Main's chat:**

```
⏺ The dse wiki holds most of the corpus [ card ], and most of its edits came on one day, June 18.
  ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ How many pages does each wiki have?                                                                            │
  │                                                                                                                │
  │ dse       ███████████████████████████████████████████████████████████████████████████████████████████   3,908  │
  │ probier   ██████████████▎                                                                                 601  │
  │ dorfwiki  ▏                                                                                                 2  │
  │ all  4,579                                                                                                     │
  │                                                                                                                │
  │ dse has 3,908 ✓ of the 4,579 ✓ pages, about 85%. probier comes next with 601 ✓.                                │
  ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
↳ The chart counts by the day in each revision's time field.

  13 citations · 2 cards  ask about this answer ›

↳ thread · "How many delete events are in events.jsonl? One number." · answered · new
↳ view · Wiki Pages · built · new

  thimble   cards 2 •   threads 1   citations 13   labels 0   checks 0   coverage 15%
```

The same reply's first row under the pointer, and a passage a thread was asked about:

```
? The dse wiki holds most of the corpus [ card ], and most of its edits came on one day, June 18.
↳ Most of the deletions came later.
```

- Everything of the reply starts on column 2, where Claude Code's own reply text starts after its ⏺ (Matt,
  2026-10-07: "can we keep the same left indent for thimble content while keeping our ability to show the question
  mark? we could still indent 2 chars and replace the dot with ? when they overlap"): prose, headings, a list's `-`, a
  card's border, the footer. A heading is bold, with a blank row above it and none under it, as the model wrote it. A
  list item's text and a quote block are at 4. Prose wraps at the terminal's width, and cards take the same width.
- The model's Markdown is drawn as Claude Code draws it: `**bold**` bold, `*italic*` italic, inline code in its code
  color, headings bold.
- **A chip** is a citation that names only its place, with no words of its own (`[[card:<id>]]`, `[↗](<ref>)`), which
  the browser draws as a chip: its own kind of citation (Matt, 2026-10-07). It reads as its place's short name in
  brackets, a space inside each, in the link color with no underline, kept whole on one row: `[ card ]` for a card cited
  whole or one of its cells, `[ card output line 1 ]` for a line a card printed, `[ events.jsonl line 12 ]` for a file's
  line (`lines 3-8`, `row 12`, `item 4`; a long name cut in its middle, its line kept; at most 30 cells inside),
  `[ edit purpose ]` for a label by its name (`[ edit purpose · yes ]` for a value), `[ report ]`, `[ slides ]` or
  `[ story ]` for a document or a passage of one, `[ output line 1 ]` for a command's output. It stands where main put
  it, mid-sentence or at its end, the same in a reply, a thread's answer, a document, a card's takeaway and every line of
  plain words (a preview: the threads tree's answer row, the New thread view's passage, a caption, a `source` row),
  where it reads `[ card ]` in that line's own color, as the line's other citations read as their words. It stays where
  the card it names is drawn under the reply or as a figure. In a side thread's answer a chip of a whole card is the
  card itself, drawn after the paragraph that cites it (section 7, "The threads panel"), never `[ card ]`. Brackets main put around it alone are left out
  (`([[card:<id>]])` reads `[ card ]`). A click opens its place as any citation's does (the card, the file at its line,
  the label, the document at its passage); under the pointer it turns bold, nothing more; a place that does not exist
  is red. The footer does not count a card's chip. Claude Code's tool rows, which draw no link, and a thread's
  subject (`about card "How many pages…"`) name a chip's place in words (`events.jsonl line 12`; a card by its
  question). A label's link with a value
  (`[33](concept:<id>/yes)`) is neither a chip nor a problem in the footer.
- A citation is its value in purple, underlined (MATT-NOTES "Citation behavior"). While it is checked (its place not
  resolved yet; in a card's takeaway, while thimble's links check runs) a purple `◌` follows it one cell after the
  value, neither the space nor the `◌` underlined (`3,934 ◌`, MATT-NOTES "Mockup feedback"), its cells the citation's;
  nothing once it is found, never `✓`; red, with a red `×` one cell after it, when its value is not at its place or the
  check found another. A citation a check rewrote reads as it is now, with no words beside it: its panel's `history`
  says what Claude wrote. A value is a number, quoted words, a date in words or a clock time (`14:52`, `14:52:11`),
  checked at its place; other words name their place, and only their place is checked. The citation under the pointer
  turns bold, still purple and underlined, with no background and nothing beside it (the owner, 10-17: "the citation
  text on hover is very hard to see"); a press opens its panel, which says where it was found or why not. While main streams, a citation
  shows as a link and a card's line as `◌ <its question>`, never `[[…]]`.
- The cards a turn added or changed stand under the turn's last reply, each once, in its last state: those a
  `thimble-run` command ran too, a shell loop over several cards included. They, the footer and the `↳` rows are drawn
  again after `thimble --continue` or `--resume`.
- The margin at column 0, the ⏺'s: a dim `·` beside each passage and card a side thread can be asked about, which
  becomes the `?` (blue) of the passage under the pointer (a heading's asks about its whole section, a card's about the
  card); a blue `↳` beside a passage or a card a thread was asked about (a passage also
  when the thread was asked about a citation of a value or a place in it; a card also when the thread was asked about a
  value it shows or a passage of its takeaway, a citation in it), which stays, and a click on it opens that thread in
  the threads panel. On the reply's first row the mark takes the ⏺'s cell: the `?` drawn over it under the pointer, a
  `↳` in its place. A mark never adds indent.
- The footer, one blank row under the turn's answer (its last part that cites or embeds a card): its facts dim
  (`· N problems` in red), its control after a gutter, no file path. No footer for the prompts thimble-term gives main
  itself.
- A `↳` row: `↳` at 0 and its words at 2, dim (`thread · "question" · answered`, `view · Wiki Pages · built`), `new` in
  green while it is new, `failed` in red. A thread's row names the turn's question; a stop is not news. A view's row
  stands under the answer that proposed it.
- The thimble line, the last row above the prompt while thimble is on, after one blank row, at column 2: `thimble`
  bold in the accent and underlined (its press opens home), then `cards`, `threads`, `citations`, `labels`, `checks`
  and `coverage`, each a name in the accent and its value bold, a purple `•` for what is new since its section was
  last seen; each name's press opens its section (band.tsx has the whole design). No `open ›`, no `dismiss`. Side
  threads have their `↳` rows and thimble's agents Claude Code's agent tray, so no row repeats them.
- Every row above the prompt but the thimble line is one line (the owner's live test, 10-17): a dim label column, then
  its words cut at a word with `…` where its acts begin, then its acts at the right, two cells apart, each in the
  accent and underlined under the pointer (no inverse), as the thimble line's names are, the row's main act bold. A
  press on words cut short shows them whole, wrapped, and a second press cuts them again. Where the acts would leave
  the words fewer than 12 cells, they take a row of their own under the words.
- The view proposal's row above the prompt, while one waits for the analyst's answer, whatever the panel shows:
  `view proposal` dim on the label column, the view's name in bold, then as much of what the view would show as fits,
  and not the task a proposal names; then `accept` (bold), `reject`, `don't ask again` and `dismiss`. A press on the
  name shows what it would show whole (for a viewer of a file type, then the files it claims after `files` dim). Why
  accept could not start its build, and the fix, is one red row under it. A press shows `◌ accepting` or `◌ rejecting` until
  thimble has written the answer. The rows go once the proposal is answered, and while view proposals are off; `don't
  ask again` turns them off (`views.propose: false` in thimble's config) and a toast says how to turn them back on. They
  bind no key: a letter typed goes to the prompt.
- The notice rows, under them, newest first: every open notice of every agent thimble runs (the orientation and its
  helpers, the critic, writers, view builds and reviews, report checks, code tickets and the dev agent, card checks,
  labels, the view proposer), since Claude Code's own output shows only main's requests (a notice of main's own reply,
  a switch of Claude's safeguards or an API error, is left out, as Claude Code shows those). One row each: `notice` red on the label
  column, then the notice's words in the text color, which name the agent and the failure (a safeguard's block, or
  its switch to another model; an API error that stopped the agent; an agent that ended failed or was refused; a view
  build, a check or a label run that failed; a check for a view proposal that failed or that a fallback model
  answered); then the acts that fix it (`try again`, `retry`, `turn off view proposals`, `how to fix it`, `allow in
  the browser ›` for a code ticket), the press that opens the agent's thread, named for what opens (`see the
  orientation ›`, `see the view build ›`, `see the thread ›` for a side thread in the threads panel), and `dismiss`.
  Each act's words say what its press does. A fix that is a command (`/login`, `thimble server restart`) is in the
  notice's words; `how to fix it` says in a toast where thimble's config is (which the terminal has in place of the
  browser's Settings), or for the terminal's own notices to run `thimble doctor`, and leaves the row. An act or
  `dismiss` takes the row away at once and thimble writes the dismissal, so it stays gone after a relaunch; a failure
  that comes again is a new row. An act thimble refuses leaves the row, with why in a toast. A notice that thimble
  clears (a later success) goes when home's state is read again. Two notices that are not failures show the same way:
  the Manual-mode notice while main runs in Claude Code's Manual mode, which says how to switch to auto mode and goes by
  itself when main reports auto mode, and the notice of a browser's sign-in, with no act (its words name `thimble
  unpair`).
- The panel's row above the prompt, only while Claude Code leaves the panel undrawn (an open it was not asked for, from
  main's tool or a click in a card, on a terminal narrower than 144 columns, or 110 for a panel opened before): `panel`
  dim, `Home is ready`, then `open panel` (bold) and `dismiss`. `open panel` opens the panel from its press, as `/thimble`
  does, at any width, and says so in a toast when the terminal is still too narrow; the row is gone once the panel is
  drawn.
- Claude Code's tool rows and subagent rows stay Claude Code's, folded as it folds them, with no hex id, in the row and
  in ctrl+o's detailed view: a thimble tool's row names a card by its question (a `card` value is the question alone,
  which the key says is a card; a card named inside other words is in curly quotation marks, which Claude Code does not
  escape as it escapes straight ones), a citation by its words, the label tool's result its name and counts, and a
  `thimble-run` command's row is `thimble-run card "<question>"` (each card of a loop by its question), never the install
  path; each question cut at a word. A side thread's fork row and the notice that it finished name the thread by its
  first question (`thread "How many of the 2,994…"`), never the fork's slug, and so do the fork's prompt and result in
  ctrl+o (`Prompt:`). Main's Agent call for a fork runs with the thread's question as its description
  (`thread: How many of the 2,994…`, thimble-term's `tool.call`, with no quotation marks of its own, since Claude Code
  quotes a description: `Agent "thread: How many…" finished`; its prompt keeps `thread:<name>`, by which thimble
  knows the fork), and the fork's name is a slug of that question, so Claude Code's agent tray (`◯ how-many-of-the-2994
  thread: How many of the 2,994…`) and its exit dialog (`subagent · thread: …`) name the thread by its question too. A
  second fork call that thimble refuses names the thread by its question in its error row. A thimble tool's words (a question, a takeaway) draw their straight quotation marks curly, which
  Claude Code does not escape (`“Agent”`, never `\"Agent\"`); code stays as written. The running `thimble-run` row
  (`⎿ $ thimble-run card <id>`), which no hook reaches, has no install path: the tools give the command by its name and
  the launcher puts the plugin copy's bin/ first on the session's PATH. thimble's tool results keep their card ids:
  main cites cards by them. Main's own `↳ thread <name>:` line names the thread by its first question in quotation
  marks, never its fork's slug, and is not drawn for a thread whose `↳` row thimble-term drew, which says the same
  (ctrl+o's view still draws the reply's time and model over the hidden line: no hook reaches that header). A run of
  one of thimble's agents reaches main twice, as its hand-back and as Claude Code's task notification, and main answers
  each with a `↳` line (prompts/main.md); its line answering the second, after a row that said the first, is not drawn,
  also atop main's reply to the analyst's next prompt when the notification started no turn of its own (in a reply to
  several reports, a line each in their order, only that report's line), so `↳ The view builder finished; …` shows
  once, as the browser shows neither.
- Claude Code draws a hook's `systemMessage` as its own row under the hook's name (`⎿ UserPromptSubmit says: …`), which
  no render hook reaches. thimble's held hook prints there the lines of the events that reached main, so in terminal
  mode it shortens or leaves out those the chat's own rows already say: a thread's question (its fork's row and its `↳`
  row) is one short line, `new thread: "Make a small table…"`, since its wake opens a `● thimble` row (the hook's
  rewakeSummary) that no hook removes and that would otherwise stand empty; a writer's end (its hand-back's row) none.
  The other events' lines (a label run finished, a view built, the orientation's coverage line) still show in that
  row.
- After `claude` exits, the launcher (not thimble-term) prints `Resume with thimble --continue instead; it loads thimble's
  plugin.` under Claude Code's own `Resume this session with: claude --resume …`, which would resume the session without
  thimble; and
  `thimble --continue` says `continuing the last thimble session in this folder`, with no session id.

**Cards**, alike in the chat, the card pane, the citation panel and a document (rule 11 for the frame):

```
╭──────────────────────────────────────────────────────────────────────╮
│ Which ten labels have the most revisions?        card:top-ten-labels │
│                                                                      │
│ label                  revisions  pages  wikis                       │
│ ─────────────────────  ─────────  ─────  ──────────                  │
│ AgentRelent                  317      4  dse                         │
│ AgentMassPointer13           187      3  dse                         │
│ AgentRelent  317                                                     │
│ wiki  all  dse  probier  fractal                                     │
│                                                                      │
│ AgentRelent made the most revisions, 317 ✓.                          │
╰──────────────────────────────────────────────────────────────────────╯
```

- The title row: the card's question in bold, inverse under the pointer (a press asks a side thread). A blank row
  under it, then the plot or body.
- Below the plot: the readout row, the value of the mark under the pointer (`AgentRelent  317`), plain, or what
  thimble is doing to the card; the label rows; the params row; then the takeaway, drawn as main's chat draws a reply,
  its citations links and its chips chips. A card the card check rewrote shows no note of it (Matt, 10-08: "don't show
  this").
- A label row, when the card read a label: `label` dim, the label's name in blue and underlined, then `↗`, then each
  value after its `●` in its hue (`label  edit purpose ↗  ● links or data  ● message to agents  ● other`), and
  `changed since` once the label changed after the card ran. A click on the name or the `↗` opens the label panel. A
  label card (the label tool's) is a bar card of the label's counts, each with its share of all, with this row, which
  says after the `↗`, dim, how the label is defined and what it ran on (`label  edit kind ↗  code · revisions.jsonl`);
  its records live in the label panel.
- A params row: the param's name dim, its choices 2 cells apart, the one in use on the selection background.
- Bars: labels in a column at the content's edge, bars after a gutter, numbers against the right edge; in the order the
  chart's label axis sorts them (its `sort`: `-y` by the value high to low, a list, `descending`), A to Z with none, as
  the browser draws the chart. The bars are in
  the first hue (or their value's hue); the bar under the pointer turns the text color and its label is inverse. A part
  of a whole runs on a `─` track to the whole. The total has its own row (`all  4,579`). A chart with a color field
  (two series or more) has one row per label, its series stacked on it in their hues in the data's order, the label's
  total against the right edge, and its key on a row under the bars (`● page saved  ● page deleted`); the readout names
  the part under the pointer and its series (`May 24 · page deleted  14 events`). Labels that are timestamps read as the
  browser's date axis writes them, all in one form: `May 24`, the time only when one is not midnight (`May 24 12:30`),
  the year only when they span more than one, never an ISO stamp.
- A line chart (an area and a scatter too): axes in the rule gray, with a `┤` or `┬` at each tick and its label dim
  beside or under it. Numbers tick at round steps, whole for whole data (`0 100 200 300 400`, never `209.5`), the y
  labels right-aligned in a column and the x labels as many as fit with 2 cells between (`0 1 2 … 8`, never `4.024`),
  without separators (`2019`, never `2,019`). Times tick as the browser's date axis names their span: `09:00` within a
  day, `Aug 28 12:00` within three days, `May 24` within 540 days, else `Oct 2019`; seconds only over a few minutes;
  where the span crosses a year, the first tick and the first of each new year name it (`Dec 1, 2019 … Jan 1, 2020 …
  Feb 1`). An axis that names its own values (Vega-Lite's `axis.values`, as thimble.chart's weekly and monthly lines
  do) ticks at those, as the browser's does, every second or third where they do not all fit. Categories stand at the
  ends and the middle. A legend row of `● series` entries; the pointer's column `┊` with its readout on the readout row.
- A table: the column names bold, a `─` rule under each name as wide as its column, the rows right under it; numbers
  right-aligned in the card's column formats, as the browser's table writes them (`1,446`). Markdown tables in a reply take the same header.
- A timeline: the axis across the content with its `●` marks in hue on a rule-gray line, its two end times dim under
  its ends, both or neither: neither when the list under it starts at the first time and ends at the last; then one
  row per event: its time dim at the content's edge, a `●` in hue, its words, and a `↗` in the citation's purple when
  it has a record (its evidence).
- An example: per record, a `●` at the content's edge (in the citation's purple, or in hue when a label the card read
  marks the record) and thimble's note after it, regular; under the note, at
  +2, the record's words in quotation marks and italic, up to three rows, then `↗` and its place in the citation's
  purple, the place underlined (MATT-NOTES "Mockup feedback": no two underline colors in a card; the link blue stays
  for actions), on the quote's last row if it fits, else on the next. A blank row between records.
- A plan: per step, its number, its state's glyph (`○` not started dim, `◌` running in the accent, `●` done, `!` needs
  you in red) and its title in bold, the clause before the first colon, its time dim at the right edge; under the
  title, indented to it, the rest of its words in the text color, then what it makes (`→ 7 participant memos`) and its
  agent's note, dim. Every step wraps at the same width, and a blank row stands between steps (the owner, 10-17).
- A diagram: boxes and edges in the rule gray, node text in the text color, edge labels dim; a note's number in a dim
  column and its text dim.
- A note, a custom card, a code card and a card type's card: their words. A chart that is not a simple bar or line
  chart (a bar chart with its values written on its bars is one): a table of its rows.
- A card that cannot be read: one red line named by its place (`× card 2 cannot be drawn: …`).
- The card pane: the question is the panel's title and the subtitle reads the card's id (`card:<name>`), its kind, who
  made it, `last run ok` or `last run failed` (in red), and, when its card check ended in an error, `its check's revision would not run` or
  `its check could not finish`, dim like the rest, since the card itself is fine (red is only for a problem with the
  card); the box starts with the plot; at the bottom `code  run again`, then the entry box (`ask about this card`),
  whose question starts a side thread about the card, opened over it. The
  code view lists the script with the `Code` element, its gutter at A0, no other indent, then `output`, the last lines
  its run printed.

**Home:**

```
  Home                                                                          show all threads  1 new
  ──────────────────────────────────────────────────────────────────────────────────────────────
  Views (1)
  ● Wiki Pages                                                                     pages.jsonl  new

  Documents (1)
  ● On June 18, agents rewrote the dse wiki's welcome page 2,299 times…                     report

  Threads (2)  1 new
  ● "How many delete events are in events.jsonl? One number."                                new
  ● "Which wiki got the most revisions on June 18, and from how many labels?"

  Cards (12)
❯ ▾ Your work                                                                             3 cards
    How many pages does each wiki have?                                                       bar
    How many revisions did the three biggest wikis get each day?                             line
    Which ten labels have the most revisions?                                               table
  ▸ Orientation                                                                           9 cards

  Labels (1)
  ● edit purpose   prompt · a sample of 30 · revisions.jsonl         █████████████▒▒██████▒████████░░  30
    ● links or data      15   ● message to agents   7   ● other               6
    ▒ unsure              3   ░ no fit              2
  ↑↓ to choose · Enter to open · x to close
```

- One layout, a single column. The title row is `Home` alone, the path's one step.
- A section heading: its name bold, its count dim in parentheses, `N new` in green after it; a blank row above it; a
  click on it opens the section's own panel. A section shows its first five items, then `… N more` (never for one
  row). An empty section shows `none`.
- An item: its glyph at A0, its name at A2 (regular, even when new), metadata dim against R, `new` in green at R.
- Views by state, each with the files it claims. Documents under the browser's word, newest first. Threads by their
  first question, with `about <its subject>` at R when a card or a citation names it (a card by its question, a
  citation by its words; never a passage's sentence, and left out when it would leave fewer than 32 cells of the
  question, which is cut at a word to make room), `earlier session`
  for one from an earlier conversation (a resumed one is the same conversation), a failed one `×`.
- Card groups by thimble's group, with their card count at R; the newest group is open, the others folded. A side
  thread's group is named by the thread's first question (`in the thread "…"`), never its title, which is a slug. A group's
  cards are at A2 with their kind word at R.
- Labels (Matt, 2026-10-17: "a colored bar of their distribution and subcategories like we see in the detail view"):
  each label's `●` in its color (as the label panel's), its name, its kind, run and files dim in a column after the
  longest name where they fit (fewer of them, else none), a stacked bar of its values in their hues, every label's bar
  at the same column and of the same width (0.3 of the row, at most 40 cells, less where the names would keep fewer
  than 16), and its total right-aligned in one column at R. Under it, its legend at A2: each value's `●`, its name and
  its count dim in aligned columns, as many as fit in two rows, then `+N more` (unsure and no fit stay, then the values
  with the most records); a value is cut only at a word. The records the label is unsure of are `▒` at the end of the
  values that answer, in their hues (shared by their counts: the counts do not say which value each has), `▒ unsure N`
  in the legend; the records no category fit and no value names (no value, or a failed one) are `░` in gray, `░ no
  fit N`; a quiet value that fits no category (`other`) keeps its name and its gray. The records themselves are in the
  label's panel, a press away. A label with no run (one a stopped thread left) has a dim `○`, `not run yet` where the
  bar and total stand and no legend, as its panel says. A run going says `◌ labeling 3,000 of 4,579`, and a
  first run that stopped part way (a quit) `stopped at 3,150 of 4,579`, alike on home, the labels list, the label panel
  and the label card.
- No Files section (Matt, 2026-10-16): the terminal has no file browser. Coverage lists the files, what Claude read
  and what it searched; a file's lines show only to verify a place (a citation's, a label's records, a card's source)
  or in a custom view. `/thimble files` with no path opens Coverage.
- The orientation's coverage line, when an orientation ran.

**The threads panel** (what `show all threads` opens, and where a thread opens). A thread open alone, with no other
thread (Matt, 2026-10-15, of such a thread: "presentation of the chat has bad information hierarchy in terminal mode in a
side thread"):

```
  home › threads › "what's the breakdown of file size? 3.6gb is mostly video?"
  about "The files show 7 participants, P1 to P7. Each one has a…"
  ──────────────────────────────────────────────────────────────────────────────────────────────
❯ what's the breakdown of file size? 3.6gb is mostly video?

⏺ Yes. The 7 screen recordings are about 3.7 GB, 95 of every 100 bytes. The thimble session
  logs are 174 MB and the 7 transcripts are under 1 MB.

  ╭────────────────────────────────────────────────────────────────────────────────────────────╮
  │ How much of the corpus's 3.6 GB is video, and how much is logs and transcripts?            │
  │                                                                                            │
  │ video (.mp4)                          ██████████████████████████████████████████    3695.5 │
  ╰────────────────────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────────────────────
❯ ask a follow-up question

────────────────────────────────────────────────────────────────────────────────────────────────
  a to ask · v to show the passage · b to go back · x to close
```

With several threads, one open:

```
  home › threads › "How many delete events are in events.jsonl? One number."
  ──────────────────────────────────────────────────────────────────────────────────────────────
  main                                                                        2 threads  1 new
❯ ├ "How many delete events are in events.jsonl? One number."
  └ "Which wiki got the most revisions on June 18, and from how many labels?"                 new
  ──────────────────────────────────────────────────────────────────────────────────────────────
  about events.jsonl line 12

❯ How many delete events are in events.jsonl? One number.

⏺ There are 5,217 delete events in events.jsonl.
────────────────────────────────────────────────────────────────────────────────────────────────
❯ ask a follow-up question

────────────────────────────────────────────────────────────────────────────────────────────────
  ↑↓ to choose · Enter or a to ask · v to show the lines · b to go back · x to close
```

A thread at work, and turns that ended with no answer:

```
❯ And the logs, by participant?

⏺ ◌ 2 tool calls
  ⎿  Counting by participant now.

  stop
────────────────────────────────────────────────────────────────────────────────────────────────
```

```
❯ And the logs?
  ⎿  stopped by the analyst.

❯ By participant?
  ⎿  × the fork ended: overloaded
```

- No subtitle. A tree: a root per place a thread was asked from (`main`, `report "…"`) at A0, its count of threads
  dim at R and `N new` in green (Matt, 2026-10-16: the count on a line of its own read as a row), a blank row between
  roots; its
  threads under it with guides; a thread asked from a thread one level deeper. Each thread's row is its question in
  quotation marks; while no thread is open, its secondary row is the first line of its latest answer, dim (`stopped` dim
  for a stop, the analyst's or the end of the Claude Code session; a failure `×` in red; before its answer is read, only
  what its record says, never `answered`); while one is open below, no secondary row, so no line of an answer repeats
  the open thread's chat; `N questions` dim at R when there is more than one.
- The selected thread (`❯`, accent) shows under the second rule: what it is about on one dim row (`about <what>`,
  named as home names it, cut at the type area), then its chat as Claude Code draws one: each question after `❯` (dim)
  in the margin, its words in the text color on Claude Code's prompt background across the type area, unquoted; a
  blank row; the answer after Claude Code's `⏺` in the margin, drawn as main's chat draws a reply; a blank row between
  turns. A turn at work, after a blank row: `⏺ ◌ N tool calls` dim (`◌ answering` before its first), then its latest
  words dim on a row after `⎿` at A0, cut at R, as Claude Code draws a call at work. A turn that ended with no answer
  says so on a `⎿` row right under its question, as Claude Code writes an interrupt or an error under a prompt: a
  stop dim (`stopped by the analyst.`), a failure red after `×`. `stop` while it answers, after a blank row, then the
  entry box for the next question (rule 27, `ask a follow-up question`), whose top rule is the panel's second rule.
  1-9 open the first nine threads. A thread's answer is its first
  reply (`reply_in_thread`) or its run's end: what its fork writes after the reply, as it makes a card, is its working
  and is not drawn, and two texts a tool call parts are two paragraphs. A card the answer cites by a chip alone
  (`[[card:<id>]]`) is drawn where it is cited, after the paragraph that cites it, never as `[ card ]`; the other cards
  the turn made stand after the answer; each in its frame, once, with a blank row before it and after it (none next to
  a rule).
- A thread open alone, with no other thread, has no list: the title row's last step is its question, and what it is
  about is the row under it, in the subtitle's place; its entry box stands under its chat.
- A new thread (one with no question yet): `about <what>` as its dim subtitle, its subject (below), then the entry box
  alone (rule 27, `type your question`), which takes the keys as the view opens; with no subject the header's rule is
  its top rule. A thread asked from a citation, a card or a comment needs no new thread's view: their panels have an
  entry box of their own. `<what>` is a card by its question (`card "…"`), a
  citation's words in quotation marks (a value alone, `4579`, as it shows; a chip by its place in full words, which
  no tip names here: `card "How many pages…"`, `agent-chat.jsonl line 2`), a passage's words in quotation marks, or `this answer` for a whole answer (its footer's `ask about this
  answer ›`), which the thread keeps. Its placeholder is drawn dim with the terminal's reset, which drops the panel's
  background behind it in a light theme.
- A thread's subject, the thing it is about (Matt, 2026-10-07: "keep that thing above the chat so I know what I'm
  referencing"): above a new thread's entry box, and in an open thread on demand, whole, between its `about` row and its
  first question (`v`, or a press on the `about` row; the hint row names what it shows: `v to show the card`, `the
  lines`, `the passage`, `the answer`): a card in its frame (section 2, rule 11), a value the thread was asked about lit
  on it; a file's cited line with up to two lines on each side, as the citation panel draws lines (the cited one in the
  text color, the value or the whole line on the citation's purple, the others dim, their numbers in a dim column at
  A2); a passage or a quote as its words, wrapped, a heading bold, unless `about` holds them whole (then there is no
  `v`). Above a new thread's entry box at most 6 rows of it (a card's plot or body, the rows under it then left out), then
  `… N more` dim, which shows it whole; never `… 1 more`.

**The citation panel** (MATT-NOTES "Mockup feedback": panel C, `mock3/citepanel2/panels.png`):

```
  home › citation 14:52
  ──────────────────────────────────────────────────────────────────────────────────────────────
  from the card  Was anything force-pushed in this run, and by whom?

  ↗ events.jsonl line 197

    195  {"id": 195, "ts": "2026-08-30T14:52:11.185+00:00", "agent": "agent-07", "actio…
    196  {"id": 196, "ts": "2026-08-30T14:52:11.225+00:00", "agent": "agent-07", "actio…
    197  {"id": 197, "ts": "2026-08-30T14:52:11.325+00:00", "agent": "agent-07",
         "action": "git.ref", "params": {"ref": "refs/heads/pr/118", "forced": true}}
    198  {"id": 198, "ts": "2026-08-30T14:54:00.490+00:00", "agent": "agent-07", "actio…

  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  checked ›   history 1 ›

────────────────────────────────────────────────────────────────────────────────────────────────
❯ ask about this citation

────────────────────────────────────────────────────────────────────────────────────────────────
  a to ask · f for its file · v for how it was verified · h for its history · s for a script · x to close
```

```
  home › citation 3908
  ──────────────────────────────────────────────────────────────────────────────────────────────
  source  "dse has 3908 pages."

  ↗ card "What does the export hold per wiki?"

  data  wiki  pages  revisions
        ────  ─────  ─────────
        dse    3908      13403
  code  1  pages = pd.read_json('pages.jsonl', lines=True)
        2  # one row per wiki
        3  df

  the card's code computed it, and thimble found it in the card's output

  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  checked ⌄   history 0

────────────────────────────────────────────────────────────────────────────────────────────────
❯ ask about this citation

────────────────────────────────────────────────────────────────────────────────────────────────
  a to ask · c for the card · v for how it was verified · x to close
```

- The title, the title row's current step after `citation` (in the accent and bold), is the cited value, bold, purple
  and underlined (a link to its place, in place of the accent); red when it failed. It has no mark (no ` ◌`, no `×`)
  and there is no subtitle: the bar says its state. A citation with no value is titled by its place in words, and then
  has no place row, so the place is named once; its `source` marks its chip in the sentence (purple, `[
  agent-chat.jsonl line 2 ]`), and its step on the title row is its chip's words (`citation agent-chat.jsonl line 2`).
- Under the rule, where the citation stands: `from the card` and the card's question for a citation in a card's
  takeaway, else `source`, the sentence in quotation marks with the cited value in it purple and underlined; a blank
  row. Then its place as a link, `↗` and the place in the citation's purple, the place underlined (`↗ events.jsonl line
  197`, `↗ card "What does the export hold per wiki?"`, `↗ card "…" output line 2`); a press on it opens the place, as
  `f` or `c` does; a blank row.
- The bar, above the entry box after a blank row and a dotted rule `┄` in the rule gray: the state word, then three
  cells on `history N`. The state word is `checked` in green, underlined, then ` ›` dim, once thimble found the value at
  its place (and the card's links check got the same, for a takeaway); `◌ checking …` (the `◌` purple, the words dim,
  nothing to press) while its place is read or its card's links check runs; `failed` red and underlined, then a red
  ` ×` and ` ›`, when the value is not at its place, the place does not exist, or the links check got another value or
  found it typed in the card's code. `history` is in the accent and underlined, then its count and ` ›` dim: the
  revisions a check made (1 where it rewrote the citation in place); `history 0` is dim and opens nothing. A part that
  is open ends ` ⌄`. The panel reads its verdict and its card as they change (a card whose links check runs is read
  again at each pass), so the bar says what the check found once it ends.
- A press on the state word (or `v`, `v for how it was verified`) opens how it was verified above the bar, after a
  blank row, dim, and a second press closes it: what thimble read and what computed or printed the value (`thimble read
  the cited line and found the value there`, `the card's code computed it, and thimble found it in the card's output`,
  `the command printed it, …`, `the card's code types it in rather than computes it`, `thimble looked for its place and
  found none`), then what its card's links check got (`, and its card's links check found the same value`, `, but its
  card's links check found 5,883`); for words that show no value `; its words show no value, so only its place is
  checked`; for a place no code verified (a file's line, a record), `; no script recomputed it`, and `ask for a script`
  on its own row under the words (`s`), which asks a side thread about the citation for a script that recomputes the value (cite.ts scriptQuestion)
  and opens it; why it failed on its own row; `script` once a side thread was asked for one (`◌ a side thread is
  writing it`, then `a side thread's script` and its first code block, numbered, at most 8 rows, `… N more` and `open
  ↳` opening the thread). A press on `history` (or `h`) opens, in its place, `Claude wrote` and the value or place as
  written, then `the check made it`, the one it reads now, and ` · ` why, the values bold. One part is open at a time;
  a citation opened anew opens with both closed.
- A command's output has `command` (`$ <the command>`, in the code color) above its lines; a passage an example quotes
  that the lines do not hold, `quoted` under them.
- Where the value stands, on the citation's purple (section 4): a file's lines (below); for a value on a card (v9
  review (i): "the code or data holding the literal, not the plot") `data`, the card's data row that holds it (a
  table's row by its first cell, a bar by its label, a line's point by its series and x: the column names bold, a rule
  under each, the row, numbers right-aligned, the cited cell lit; the row's name and the cited column stay where the
  columns do not fit), then `code`, the card's code numbered at most 8 rows, the rows around the first line that types
  the value with its literal lit where it does (`3908`, `3_908`, `3,908`), `… N more` opening the card's code. A card
  whose data keeps no rows (a diagram, a timeline) is drawn in its frame with the cited mark lit. `c` (or a click on
  the title) opens the card.
- The lines: nested at A2, their numbers right-aligned in a dim column, the cited line's number in the text color and
  the cited value on the citation's purple (the whole line where the citation shows no value, or the line does not
  hold it, and no example's quote marks a passage); each record around the cited one on one dim row, drawn as the cited one
  is: its words where thimble reads words in it (a transcript's message, an event's params), else as Raw draws it (a
  JSON record as its line of JSON); the cited record over its rows, and never a record cut after its first rows; a cited line wrapped over 3 to 8 rows by the pane's height, with two
  lines of context when it wraps. A citation of lines a card printed (`card:<id>@out0#L1`) draws those lines of the output, two
  on each side, the cited value (the whole line, for a citation with no words) on the citation's purple, never the
  card's table, then the card's `code`; it is named `card "<question>" output line 1`, never `card L1`. A place cited with a passage of its line
  (`#L2.b0:c0-120`) reads as its line (`agent-chat.jsonl line 2`).
- A file's lines are a window over the whole file (Matt, 2026-10-07: "you can't see beyond the few lines it picks"),
  as tall as the rows the panel's other parts leave: it opens with the cited lines a third of the way down, `↑ N more`
  and `↓ N more` dim on a row each count the file's lines above and below it, and a click on one moves it a page; ↑↓
  (`↑↓ to scroll`) and the wheel move it a line, through the whole file, the next page of the file read as the window
  nears it; at the file's end its last line is on the window's last row. Opened anew, a citation's window starts at its
  cited lines again; `b` back from its file finds it where it was. `f` (or a click on the title) opens the file view at
  the cited line.
- The bottom: the bar, then the entry box (rule 27). Its question starts a side thread about the citation (`ask about this
  citation`), opened over the citation, so b comes back to it; in a citation opened from a side thread it goes on in
  that thread, about the citation (`ask a follow-up question`), and the panel returns to the thread. `a` gives it the
  keys.

**The views pane:** `N views · N built`; one row per view, newest first: its glyph, its name, the files it claims dim
at R, `new` in green until a built one is opened.

**A view:** the title row, the view's name its current step, the facts its program gives as the subtitle, the rule; then
the rows its program draws (`view.term.js` on the terminal view kit, docs/terminal-views.md), with their margin; then
the hint row, one row: `↑↓ to choose · Enter to open`, the program's first two keys of its own, `? for all keys` and
`b to go back · x to close`, whole hints, the most needed kept where the row has no room (↑↓, Enter, b, ?, x, then the
program's own). The top row shows the kit's controls (Color by, Filter by, Rows, the search), so their keys stand in
the list `?` opens, which names every key the program binds; each key it binds works whether the row names it or not.
The program hears Claude Code's theme, `light` or `dark`. From the moment it opens until its program's first frame the
view says `◌ starting the view…`, and `◌ loading…` stands dim against R on the title's row while a reader query of its is
out. A region under the pointer that is not a whole row is inverse, and its tip shows on the tip background on the row
below it; a chart's region (a strip, a lane) is never inverse: only the pointer's column is marked, `┊` in an empty cell
and a bar in the text color, on every chart region over the same columns, with that cell's tip. Its keys reach it through the list's
relay (↑↓, Enter, Space, Backspace, a sign typed) and as hotkeys (a letter, a digit); while a field of the view takes
typing, every key. The wheel over it reaches it with the frame's cell under the pointer, so that it moves the list
there alone. A view built in browser mode is one line that says so, and how to open it in browser mode.

**The file browser** (removed in 0.9.0, Matt 2026-10-16: people view files their own way; the terminal shows a file
only to verify a place, and Coverage lists the files). What follows of the tree, its find and its preview is kept as
the record of 0.8.0; a file (below) still opens at a place, and b goes back where it was opened from.
After the browser's Files (`frontend/src/files`: its tree, its search, its reader's modes):

```
  home › Files
  7 files · 1 label on
  ──────────────────────────────────────────────────────────────────────────────────────────────
      name                                                                       type       size
  ▾ wiki/  3                                                                               94 KB
      pages.csv                                                                  csv        2 KB
      README.md                                                                  markdown   2 KB
  ▸ logs/only/deep/  1                                                                     300 B
  ▾ runs/  3                                                                              9.2 MB
    ▾ 2026-06/  2                                                                         9.2 MB
❯       agent-a.jsonl  ●                                                         agent    4.0 MB
        agent-b.jsonl  ●                                                         agent    5.2 MB
      notes.txt                                                                  txt       900 B
  ──────────────────────────────────────────────────────────────────────────────────────────────
  runs/2026-06/agent-a.jsonl                                                 opens as transcript
  ●  07:40:01  ● alice  Who saved the welcome page this morning? It changed three times before…
  ●  07:41:30  ● agent-a  I did, twice: once to fix the broken link through r.jina.ai and once…
  ↑↓ to choose · Enter to open · Space to fold · f to find · x to close
```

- The tree, as the browser's: the corpus's own files under the corpus folder's name first, then each folder; in a
  folder its folders first, then its files, each in natural order. A folder nests 2 cells further in per level, its
  fold marker on its level's edge and its name 2 cells after it, its files 2 cells further in than its name, with no
  dot. A folder that holds one folder and no files joins it on one row (`logs/only/deep/`). A folder's row: its file
  count dim after its name (every file under it), its size under `size`, as home's. The first folder is open, the
  others folded; an open folder shows its first 20 files, then `… N more`. The type column goes before a name is cut,
  as on home; a name too long even then is cut in its middle. A row is chosen as the browser opens (the first file the
  tree shows, or the file Backspace came back from, its folders open); a folder's row is chosen like a file's, Enter
  folds it, and Space on a file folds its folder with the choice moving onto the folder's row.
- The labels that are on (`shown`, as show_label or the browser's Files turns them on) are the tree's color field: a
  `●` in each label's hue after the name of each file it labeled (its last run read it, or its scope names it), a space
  between two; the subtitle counts them (`1 label on`).
- `f` begins the find (the browser's Files search): `find` dim in the header, under the subtitle, and the words typed
  after it, an inverse cell after them while its field takes typing. Its field is the relay's Input, so every letter
  goes into it while ↑↓ still choose a row of what it found; Enter opens the chosen row, Esc leaves the field and keeps
  the words, `f` takes typing again, and Backspace (out of the field) clears the find. The hint row while it types:
  `↑↓ to choose · Enter to open · Esc to leave the field`.
- What the find found stands in place of the tree. `Named` and its count: the files whose path holds every word
  (`thimble state find`), each path at A2, its type and size against R. A blank row, then `In the text` and its count,
  the matches against R: each file whose text holds the words (`thimble state grep`, from 2 letters on, read for at most
  20 seconds), its path at A2 and its matches against R (`7 matches`, `+` when the count stopped short), then its first
  matching lines at A4, each line's number right-aligned in a dim column and the words around the match, the match on
  the selection background; `◌ searching the files' text` while it reads, and `searched N of M files` when it stopped
  short. Enter or a second click on a file opens it (a file found in the text at its first match), on a line opens its
  file at that line, chosen. Words that end in `:<n>` (`README.md:3`) find the name before it and open its file at
  line n, as the browser's search reads them.
- The chosen row's file shows under the second rule (at most 6 rows, fewer in a short pane, so the list keeps eight):
  its path, what it opens in at R (`opens as transcript`, `table`, `text`, `lines`, `tables`), then its first rows in
  that mode: a transcript's turns one row each (its clock, its speaker bold, its words after a gutter), a table's column
  names and first rows, text wrapped, lines as the file holds them, a database's tables with their rows at R; a
  matching line's file from that line, wrapped, the line lit.
- A file: its title row `home › files › labels.jsonl`, its name the current step; subtitle its type (as the file
  browser's), its records (a CSV file's `rows`) and the lines shown, `earlier  later` at R; the tabs of the modes it reads in, as the browser's
  Files offers them, and it opens in the best by the browser's scores (`frontend/src/files/views/registry.ts`): a
  transcript the sniff is sure of, then a text file, then records that share their keys or a CSV file as a table, else
  Raw. The chosen record (a citation's, a click's) is on the selection background or `❯` in the accent, with its place
  as a link and a blue `?` under the header. Backspace goes back to the file browser (`Backspace for the files`; ←
  reaches no element of a pane).
- `f` in a file begins its find (the browser's find bar): `find` dim under the tabs, the words typed after it with an
  inverse cell after them while its field takes typing, and against R how many lines of the whole file hold them
  (`thimble state findin`), `2 of 41 lines` while the chosen line is one of them, `none` when none does. The first such
  line at or after the chosen one is chosen as the words come in, and ↑↓ choose the one before or after it while the
  field takes typing (`↑↓ for the lines it found · Enter to stay there · Esc to leave the field`), reading its page when
  it is on another. In the Raw and Text tabs the words are on the selection background wherever a line holds them. The
  find goes with the file: Backspace back to the files clears it.
- The labels that are on and labeled the file: a label row each under the chosen record's row, as a card's (`label`
  dim, the name in blue and underlined, `↗`, each value after its `●` in its hue; `file` and the value it gave the file
  whole for a label over files), a click on the name opens the label's panel; before each record a column of marks, a
  `●` per label in the hue of the value it gave the record (dim for the catch-all), a space where it gave none, then a
  gutter (`thimble state marks`, the rows on the page's lines).
- The Table tab: the records' keys as columns (a CSV or TSV file's: the names its first line gives), names dim on the
  row above, `▼` or `▲` after the sorted one, a click on a name sorts by it; numbers right-aligned with separators,
  those that name things (an `id`, a `number`, a line, a year, a table's key) as written; free text last.
- The Text tab (a Markdown file, a .txt file, a prompt; the browser's Rendered view): each line wrapped over the rows
  it needs, its number in a dim column, a Markdown heading bold without its marks, blank lines left out.
- The JSON tab (a file of JSON records, a line of a .json file): the chosen record whole (the first when none is),
  indented, colored as Claude Code colors JSON, its long lines wrapped; ↑↓ the record before or after it.
- Raw draws each line as the file holds it (a JSON record as its JSON line, never a transcript's words), its number
  right-aligned in a dim column and the text after a gutter, a Markdown file's headings bold.
- A transcript: per turn, its clock dim in a column at A0 (`07:40:01`; the day on a dim row of its own where it
  changes), then `●` in the speaker's hue and the speaker's name bold; its text 2 cells in under the name, wrapped to
  up to three rows, the last cut with `…`; a tool call one dim line.
- A whole-file JSON transcript (a chat export, an agent's store of messages): its turns as thimble parses the whole
  file (`thimble state turns`), 200 at a time, `turns 1-200 of N` in the subtitle and `earlier  later` paging them;
  each conversation's title on a dim row where it starts; a turn chosen by its place among the turns, since its
  turns may share a line. Where the parse finds no turns, the file opens as its lines and its type is its format.
- A database (`.db`, `.sqlite`; the browser's Database view): `database · N tables`, then its tables, each with its rows
  against R, Enter opening one; a table's rows as the Table tab draws them (`thimble state rows`, 100 at a time,
  `earlier  later`; a click on a column's name sorts by it), `table <name> · rows 1-100 of N` in the subtitle; the
  chosen row's place (`↗ forge.db · prs · 7131`) and `?` under the header, Enter opening its citation. Backspace goes
  from a table to its tables, from the tables to the files.

**The label panel**, as Matt laid it out (mockup `mock3/labelpanel2`), every field exposed and editable as in the
browser's label editor (`frontend/src/files/LabelCard.tsx`):

```
  home › labels › message to agents
  name:      ● message to agents
  kind:      prompt   regex   code
  model:     claude-haiku-5-5 ▾
  unit:      records of files   cards   sentences
  scope:     board.jsonl                         · 1 file matches · 44 lines
  mark records in Files and views:   on   off
  ──────────────────────────────────────────────────────────────────────────────────────────────
            ╭──────────────────────────────────────────────────────────────────────────────────╮
  prompt:   │ Is this post a message addressed to one or more other agents, rather than a      │
            │ status note to no one in particular?                                             │
            ╰──────────────────────────────────────────────────────────────────────────────────╯

  values:
            ● yes     ━━━━━━━━━━━━━━━━━━━━            17
            ● no      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  25
            ● unsure  ━━                               2

  last run on all 44 lines
  run on a sample   run on all   rename   delete

  ▸ examples  12 · 80% agreed on 10 values you set, not counting the 4 given as examples
  ▸ cards  2

  ↑↓ to choose · Enter to press or edit · b to go back · x to close
```

- The fields, each label dim in a column of 10 cells, its value after it. A choice (`kind:`, `unit:`, the marks) has
  one cell around each word and one between them: the one in use on the selection background, the others dim, a
  click away where the browser lets them change.
  - `name:` the name in a field (an Input, 40 cells, on the selection background) after a `●` in the label's color;
    Enter renames it (`thimble act label`).
  - `kind:` prompt, regex or code; another kind picked is saved with its definition, by Enter in it or a run.
  - `model:`, a prompt label's: the model its calls run on by its id (the label's own, else Settings' row for labels),
    on the selection background with a dim `▾`. A click shows the models under it (`model_choices`: the one it runs
    on, every role's, the aliases' models), the one in use lit; a pick saves it (`thimble act label {model}`, `''`
    for the labels role's, as the browser saves it). With one model to choose from it is plain.
  - `unit:` records of files, cards or sentences: only the one the label has, since its rows are of that unit (the
    browser's `Over`, fixed once a label is made).
  - `scope:` a label over files: its glob in a field (36 cells, on the selection background; Enter saves it), then dim
    how many files it matches and how many records they hold, by the word their type gives them (`· 1 file matches ·
    44 lines`; `rows` of a table or CSV file, `pages` of a PDF, `entries` of a JSON document, `records` for files of
    several types; backend local._record_noun; Matt, 2026-10-16: a bare count read as a link). A label over cards or
    sentences: `the canvas's cards · 9 cards`, `the report's sentences · N sentences`.
  - `mark records in Files and views:  on  off`, a label over files: whether Files and the views mark its records with
    its values (f, `thimble act label-show`); a view opens colored by a label that is on (Matt, v9 review: `in files:
    on off` did not say what it turns on).
- Then the rule and the definition whole in a field to edit (field.tsx), in a round border from the label column to
  the pane's edge, its name (`prompt:`, `pattern:` or `code:`) on its first row of text. A click gives it the
  keyboard; Enter saves it (in code, ctrl+s). Code has its keywords in the citation violet and its strings in green,
  its comments dim, on every row but the one the cursor is on. A pattern says under it, dim, what a match gives and
  whether case counts (`a match is yes, the rest no · case-sensitive`; `case-insensitive` when it holds `(?i)`).
- `values:`, then each value at the label column: its `●` and its bar in its color, the bar to the largest count (30
  cells at most, fewer in a narrow pane), its count bold at the row's end. The counts apply the analyst's verdicts,
  as thimble.labels() reads the rows, and `values:` says how many the analyst set and the value a filter keeps (`1 set
  by you · filtered to yes`), that value on the selection background. A click on a value shows under it `color` (a
  label over files) and `filter` (`clear filter` on the value the filter keeps), then the values to edit (`values  yes
  · no`, Enter saves them). `color` shows the eighteen label colors under it around the color wheel, as the browser's
  pickers show them: a column per hue (red, orange, gold, green, teal, sky, blue, purple, pink), its light place above
  its dark, each `●` in its hue and its name as show_label names it, the one it has on the selection background, a
  click giving it that color (`thimble act label-show`, a value that had it taking the old one); a narrow pane wraps
  the columns, a blank row between their rows. `filter` keeps only the units of that value in the label's scope
  (Files, the canvas or the report, `thimble act label-filter`, as a label card's value does). The whole files or runs
  a prompt label's last run read only in part, one dim row under the values. A link to the label in a reply
  (`[33](concept:<id>/yes)`) opens the panel with its examples open and the value on the selection background, its
  examples first. In a card's takeaway such a link is red once the label counts another number (a verdict or a run
  changed the counts), its tip the count now (`the label counts 179 now, with your verdicts`).
- The last run dim on its own row (`last run on all 44 lines`, `last run on a sample of 30 lines`), then the actions,
  3 cells apart, their words underlined in the accent, `delete` in red (Matt, v9 review: they read as text; this
  overrides rule 24 for the label panel): `run on a sample` and `run on all`, which save what was typed first and run
  it; `◌ labeling …  stop` while it runs, and the fields as plain text. A run's first error is a red `!` row under
  them. `rename` (n) gives the name's field the keyboard. `delete` (k), not offered while a run goes, asks once in
  their place: `delete label "…"? its marks and card go too · y to delete · n to keep`; y deletes the label with its
  marks, its card and any filter that uses it (`thimble act label-delete`) and opens the labels list, which offers to
  undo it until another label opens: `deleted the label "…"  undo` under its second rule (u, `thimble act
  label-undelete`, the browser's Undo), which puts it back with its marks, card and filters and opens it; once a later
  change stands above the delete, a red `×` row says why.
- `▸ examples` and `▸ cards`, folded under the actions (e, d), nothing of them shown until one is opened.
  Examples: its toggle row gives the label's held-out agreement in the browser's words (`80% agreed on 10 values you
  set, not counting the 4 given as examples`); grouped by value (a record the analyst set or agreed with under the
  value they gave), each value's row with how many records have it, then its records, then `… N more`, which reads
  the next ten of that value (`thimble state label --rows`), each record with `↗`
  and its place, `agree` or another value, the record's words in quotation marks and italic, `why` dim; a JSON record
  shows the field the rule reads first (a code label's `unit['name']`, the field a pattern matches, a field the prompt
  names) as a label/value row, its words in quotation marks and italic, then its other fields on one dim row, never its
  JSON inside quotation marks; after a verdict `✓ agreed` or `✓ set by you`; each value's button as wide as
  the longest value, so `agree  it is  …` stands in one place under every value. Cards: the cards that use the label,
  each a click away, at most 8. A blank row stands between an opened part and the next toggle.
- The hint row: `↑↓ to choose · Enter to press or edit` (Claude Code's ring walks every field, choice and action;
  Enter presses one or gives a field the keyboard), `s to stop` while a run goes, then the way's. The letters r, n, k,
  f, e, d and l stay bound, unnamed.
- The labels list (`home › labels`): each label as home draws it (its name row with its bar and total, its legend,
  four rows of it at most), 1-9 the first nine, then under the second rule the field `describe a new label`, whose words go to main, which makes the label
  with a trial. `l` in a label's panel opens the list in place of the label's step (`home › labels`), the label it came
  from chosen; b then goes where the path shows, home. A document's `l` does the same for the documents list.
- The scope's records (`14,591 records`, `run on all 14,591`): the last full run's count, else the scope's size thimble
  counts for a label whose first run never ended.

**Documents:** the documents list (`home › documents`) has one row per document, `◌` while its writer writes, `●`
written, its title, its kind dim at R, at most 40. **A document:** its title in quotation marks the title row's current step (`home › documents › "…"`), in the accent and bold, cut with `…` where the row ends; while its
writer writes, `◌ writing · N tool calls · <its latest words>`. A report: `Contents` as a bold heading, the sections
with a heading numbered in a dim column at A0, each a click or a digit away (an opening section with no heading is not
listed, and starts with its words); then each section drawn as main's chat draws a reply, at A0: its heading bold, its
bullets a list, one item a row, its prose filling the type area, its cards in their frames, a caption dim under each. A callout:
its kind (`note`, `tip`, `important`, `warning`, `caution`) as a dim label and its text on L, `warning` and `caution`
red. A figure's caption stands dim under its card, then a blank row before the words after it. A deck steps one slide at a time (`‹ 3 of 9 ›`, `previous  next`, its `notes`); a story one beat at a time, its
figure lit at the beat's step, or `read as a page`. At the bottom `all documents ›` and the retell controls, `as slides`
and `as a story`, which ask main to write it again in that form, their keys hinted by what each retells as (`s slides,
y story`). No stats row and no file path.

**A document's comments** (a check's, Claude's note from `add_comment`, the analyst's) stand under the passage they are
on, as the browser's margin shows them (a check's only while the check is on; the citation check's unverified tag
too): at A2 a `●` in the check's hue (dim for a note) and its name, what it is dim at R (`check`, `comment`, `citation
check`, then ` · resolved`), its words under the name at A4; a blank row before the words after them, none before a
card. The title's stand under the header. The subtitle counts them (`4 open comments · 1 resolved`) and names a check
that runs on the document (`◌ Judgment calls checking`). ↑↓ choose one (`❯`, its name in the accent, its refs as chips
under its words), scrolled into view, the slide or section that holds it shown first; `r` resolves it, as the margin's
✓ does, or opens a resolved one again; the chosen one's entry box (rule 27, `ask about this comment`) stands at the
panel's bottom under the actions, and its question starts a side thread about the comment on its passage (Enter or `a`
gives it the keys); `v` shows the resolved ones, dim. The Checks view of a comment on main's answer ends with its acts
(`put in the prompt  dismiss  open in the browser`) and the same entry box.

```
  The corpus is an export of four wikis [ README.md line 3 ]. It holds 4579 pages.
❯   ● Judgment calls                                                                         check
      The card counts 4,579 pages across all four wikis; say so, since the sentence reads as one wiki.
      [ card ]
  ╭──────────────────────────────────────────────────────────────────────────────────────────────╮
```

**A report edited** (`e`): its step reads `"<title>" · edit`, the subtitle `editing as Markdown · a card is its line
![caption](card:<id>)`, then `unsaved edits`. The document's Markdown whole in a field with a border, as tall as the
pane leaves it, `↑ N more` and `↓ N more` dim where rows are cut off: `# ` its title, `##` a heading, `- ` and `1. ` a
list, a card its line, citations as written. A click gives it the keys; ctrl+s saves it (`s` once Esc gave the keys
back), `d` discards the edit, back keeps it for the next `e`. The save goes through the browser editor's route, so a
passage the edit kept keeps its id and its comments. A document changed meanwhile stops the save with a red `!` row
until `s` again saves over it.

### 8. Checks

Testable against what thimble-term draws (`tests/visual.test.ts`, the panel and card tests, and ANSI captures of a live
session):

1. Bold only on titles, a card's title, section headings, a card table's column names, transcript speakers, and the
   model's Markdown.
2. Green only on `new`; accent only on panel titles and the selected row; blue only on links (chips among them), `?`
   and `↳`.
3. No letters in a palette hue; letters in red only for problems; no other colored letters but check 2's and code's.
4. No two blank rows in a row; no blank row next to a rule; one blank row under each card's title.
5. Every card has a full round border in the rule gray.
6. Every rule is as wide as its type area; a panel has two rules at most. An entry box's rules are its border, from
   the margin's edge to R, and its top rule stands for the panel's second rule.
7. Every run that opens a row starts on M, A0, A2, A4, L, a table's column, a tree's guide or a folder's level in the file browser.
8. Columns are parted by 2 spaces or more.
9. No background but the panel's, the selection's and the tip's; no inverse but on the selected tab and under the pointer.
10. No prose is cut at a fixed measure.
11. Every panel starts with its one title row, the path with its current step bold in the accent (the citation panel's
    value a blue link), and ends with its key-hint row; no `‹ back`.
12. Every non-ASCII character thimble-term draws, outside the corpus's and the model's words, is in section 5's table.
13. A right-click opens no menu.
14. No centered row.
15. Every chip is `[ <its short name> ]` in the link color, with no underline, whole on one row; no citation that names
    only its place is left out, put in parentheses or drawn as words of the sentence.
