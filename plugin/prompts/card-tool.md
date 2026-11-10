Draw an interactive card, or a new version of a card in its place.

Refer to a card by its title, not as "below". Draw and fix cards while you work. Then, as you write the answer, place each card at the step it explains, between your paragraphs. To place a card, write a line that holds only its link, `[title](card:<id>)`. The card then draws on that line instead of at its call.

Data: a JSON file of rows that your code wrote from the records. The file holds a list, JSON Lines, or one object.

View: plain JavaScript (no JSX) that defines `function view(props, surface)`. The view cannot use files, the network, timers or modules.
- `props.rows` is the rows, and `props.data` is the whole file.
- The view returns elements of `const { Box, Text, Button } = surface.elements`. Give them Ink props and `children`, such as `Text({ bold: true, children: "late" })`.
- Colors are "#rrggbb". Nest Texts for runs of color.
- `surface.colors` is thimble's palette: `.cat[0…4]` for categories in order, `.seq(t)` for t from 0 to 1, `.gray` for context, and `.good` and `.bad`.
- `surface.num(n)` writes a number with thousands separators (2,327). `surface.num(n, 1)` writes it with one decimal.
- A Button takes `onPress` and `plain: true`. A Button around Boxes takes a click anywhere on them.
- Lay out from `surface.columns`, the card's width.
- Thousands of elements do not draw. So draw a dense grid as runs of text.
- Code outside `view` runs once per version. Build indexes there.

State: `surface.state` and `surface.setState(next)` hold plain JSON. `surface.state` is undefined at first. Keep a selection by the record's key, not by its place.

Input: the analyst narrows the card with keys and clicks, and a click opens one record. `const keys = "jk"` names the letters that the card takes at an empty prompt. `function onKey(key, surface, props)` gets each of these keys. Only letters reach a card. The letters {{KEPT}} are thimble's own, so the card does not get them. `surface.onPointer(fn)`, in `view`, gets clicks as {type: "down"|"up", x, y} in cells.

The call returns a text copy of the card, or the view's error. Try each key and Button with `actions`, and read each copy as the analyst would. Before you reply, draw one new version with all your fixes: what the analyst would misread, a plot that came out mangled, and any change that makes the card easier to read or use.

To change a card, call card with its `id` and `edits`, because a whole view takes half a minute to write. Do this also for a change that the analyst asks for. The new version still answers the card's first question, with the change beside it. A new question gets a new card.

When a call fails because of the setup, not the view, try again in a later turn.

<!-- view -->
Advice on drawing a good card:
- The first line states the answer, because the analyst reads it first.
- Each part of the question has its answer on the card, next to the marks it explains. Compute the answer's words from the rows in the view's code.
- thimble draws the title, so the view does not draw it.
- The card is part of the conversation, so give it the terminal's plain look and let the data stand out. Write text in the default color, what a value is in `surface.colors.gray`, and the value in bold.
- Take colors from `surface.colors`, so they stay muted and read on light and dark terminals.
- Show what each color, symbol and line style means with a sample (`█ survived`).
- Mark the selected item with bold or `▸`.
- Choose keys whose place on the keyboard matches the way they move: j down and k up a list, and j back and k forward through steps that go left to right.
- When a key or a click changes the card's state, every row stays where it was. Put what follows the selection, such as a note or details, on rows kept for it.
- Size each column from its longest value. A cut value keeps the part that tells it apart. A line counts what is left out (`+47 more`).
- Keep numbers apart, because numbers that touch read as one. A cell of two records shows their count.
- Put each axis label at its tick.
- About 30 rows fit. When you page the rows, say which page shows ("rows 1-14 of 28").
