Draw an interactive card, or a new version of one in its place. The card appears in the conversation at this call, before the words you write after it; refer to it by its title, not as "below".

Data: a JSON file of rows that your code wrote from the records: a list, JSON Lines, or one object. The call says what the card read.

View: plain JavaScript (no JSX) that defines `function view(props, surface)`, with no files, network, timers or modules. It returns elements of `const { Box, Text, Button } = surface.elements`, the ones Claude Code draws its own interface with (Ink's Box and Text, plus a Button), with Ink props and `children`, such as `Text({ bold: true, children: "late" })`. Colors are "#rrggbb"; nest Texts for runs of color. A Button takes `onPress` and `plain: true`; a Button around Boxes takes a click anywhere on them. `props.rows` is the rows, `props.data` the whole file. Lay out from `surface.columns`, the card's width, which changes when a side pane opens. Thousands of elements do not draw, so draw a dense grid as runs of text. Code outside view runs once per version: build indexes there (`let byDay` outside, `byDay ??= …` in view).

State: `surface.state` (undefined at first) and `surface.setState(next)` hold plain JSON, kept across resumes. Keep a selection by the record's key, not its place.

Input: `const keys = "jk"` names the letters the card takes at an empty prompt, and `function onKey(key, surface, props)` gets each. Only letters reach a card (a digit types into the prompt), and {{KEPT}} are thimble's own; j and k suit next and previous. `surface.onPointer(fn)`, in view, gets clicks as {type: "down"|"up", x, y} in cells.

The call returns a text copy of the card or the view's error. Try each key and Button with `actions`, read each copy as the analyst will, and fix what they would misread in one new version before you reply. For a change, also one the analyst asks for, call card with the `id` and `edits`, since a whole view takes half a minute to write. The new version still answers the card's first question, with the change beside it. A new question gets a new card.

Principles:
1. Overview first, zoom and filter, then details on demand. The first view shows the whole, aggregated to fit the card, not a table of raw records. The analyst narrows it with keys and clicks, and a click opens one record.
2. Mirror the data's structure and the analyst's task: events on a time axis, who works with whom as a network, a hierarchy as a tree, steps toward an outcome as a flow. Compare across the units the data repeats, such as runs, before the details within one.
3. Show what the task compares in the channels people read most accurately, position and length first, with one channel for each attribute, one scale for each quantity, and keys that match the marks.
4. The analyst's attention is limited, so use color, one encoding at a time, to make what the task needs stand out. Where values have a meaning people know, draw their glyph in that color: ✓ in green for a success, × in red for a failure. Gray is for context and "other". Show any other category as text or a glyph, never in a second palette or in purple, thimble's color.
5. Each element shows data or acts on it. The card explains nothing in words it does not need.

Advice:
- The first line states the answer, since the analyst reads it first.
- Each part of the question has its answer on the card, in words that code computes from the rows, next to the marks it explains.
- thimble draws the title.
- A color must read on light and dark backgrounds.
- Show what each color, symbol and line style means with a sample (`█ survived`); mark the selected item with bold or `▸`.
- Size each column from its longest value; a cut value keeps the part that tells it apart, and a line counts what is left out (`+47 more`).
- Numbers that touch read as one; a cell of two records shows its count.
- Put each axis label at its tick.
- About 30 rows fit; say which page shows ("rows 1-14 of 28").
