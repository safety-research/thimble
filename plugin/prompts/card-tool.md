Draw an interactive card, or a new version of one in its place. The card appears in the conversation at this call: what you wrote before the call stands above it, and what you write after it stands below it. Refer to it by its title, not as "above" or "below".

Data: a JSON file of rows that your code wrote from the records: a list, JSON Lines, or one object. The call says what the card read.

View: plain JavaScript (no JSX) that defines `function view(props, surface)`, with no files, network, timers or modules. It returns elements of `const { Box, Text, Button } = surface.elements`, the ones Claude Code draws its own interface with (Ink's Box and Text, plus a Button), with Ink props and `children`, such as `Text({ bold: true, children: "late" })`. Colors are "#rrggbb"; nest Texts for runs of color. `surface.colors` is thimble's palette for the person's terminal theme, dark or light: `.cat[0…4]` for categories in order, `.seq(t)` for t from 0 to 1, `.gray` for context, `.good` and `.bad`. `surface.num(n)` writes a number with thousands separators (2,327), `surface.num(n, 1)` with one decimal. A Button takes `onPress` and `plain: true`; a Button around Boxes takes a click anywhere on them. `props.rows` is the rows, `props.data` the whole file. Lay out from `surface.columns`, the card's width, which changes when a side pane opens. Thousands of elements do not draw, so draw a dense grid as runs of text. Code outside view runs once per version: build indexes there (`let byDay` outside, `byDay ??= …` in view).

State: `surface.state` (undefined at first) and `surface.setState(next)` hold plain JSON, kept across resumes. Keep a selection by the record's key, not its place.

Input: `const keys = "jk"` names the letters the card takes at an empty prompt, and `function onKey(key, surface, props)` gets each. Only letters reach a card (a digit types into the prompt), and {{KEPT}} are thimble's own. Keys read best where their place on the keyboard matches the way they move: j down and k up a list, and j back and k forward through steps that go left to right. `surface.onPointer(fn)`, in view, gets clicks as {type: "down"|"up", x, y} in cells.

The call returns a text copy of the card or the view's error. Try each key and Button with `actions`, and read each copy as the analyst will. Before you go on, fix in one new version what they would misread, a plot that came out mangled, and any change that makes the card easier to read or use. For a change, also one the analyst asks for, call card with the `id` and `edits`, since a whole view takes half a minute to write. The new version still answers the card's first question, with the change beside it. A new question gets a new card.

Drawing for the terminal:
- The first line states the answer, since the analyst reads it first.
- Each part of the question has its answer on the card, in words that code computes from the rows, next to the marks it explains.
- thimble draws the title.
- Take colors from `surface.colors`, so they stay muted and read on light and dark terminals.
- Show what each color, symbol and line style means with a sample (`█ survived`); mark the selected item with bold or `▸`.
- When a key or click changes the card's state, every row stays where it was; what follows the selection, such as a note or details, goes on rows kept for it.
- Size each column from its longest value; a cut value keeps the part that tells it apart, and a line counts what is left out (`+47 more`).
- Numbers that touch read as one; a cell of two records shows its count.
- Put each axis label at its tick.
- A blank line between a card's sections often makes it easier to read.
- About 30 rows fit; say which page shows ("rows 1-14 of 28").

When a call fails because of the setup, not the view, try again in a later turn. When the analyst presses v under an answer, thimble draws a card of it in the background and tells you with their next message.

The guidance's Cards section says what makes a good card.
