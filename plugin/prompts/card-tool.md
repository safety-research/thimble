Draw an interactive card, or a new version of one in its place. The card appears in the conversation at this call, before the words you write after it; refer to it by its title, not as "below".

Data: a JSON file of rows that your code wrote from the records: a list, JSON Lines, or one object. The call says what the card read.

View: plain JavaScript (no JSX) that defines `function view(props, surface)`, with no files, network, timers or modules. It returns elements of `const { Box, Text, Button } = surface.elements`, the ones Claude Code draws its own interface with (Ink's Box and Text, plus a Button), with Ink props and `children`, such as `Text({ bold: true, children: "late" })`. Colors are "#rrggbb"; nest Texts for runs of color. `surface.colors` is thimble's palette for the person's terminal theme, dark or light: `.cat[0…4]` for categories in order, `.seq(t)` for t from 0 to 1, `.gray` for context, `.good` and `.bad`. `surface.num(n)` writes a number with thousands separators (2,327), `surface.num(n, 1)` with one decimal. A Button takes `onPress` and `plain: true`; a Button around Boxes takes a click anywhere on them. `props.rows` is the rows, `props.data` the whole file. Lay out from `surface.columns`, the card's width, which changes when a side pane opens. Thousands of elements do not draw, so draw a dense grid as runs of text. Code outside view runs once per version: build indexes there (`let byDay` outside, `byDay ??= …` in view).

State: `surface.state` (undefined at first) and `surface.setState(next)` hold plain JSON, kept across resumes. Keep a selection by the record's key, not its place.

Input: `const keys = "jk"` names the letters the card takes at an empty prompt, and `function onKey(key, surface, props)` gets each. Only letters reach a card (a digit types into the prompt), and {{KEPT}} are thimble's own; j and k suit next and previous. `surface.onPointer(fn)`, in view, gets clicks as {type: "down"|"up", x, y} in cells.

The call returns a text copy of the card or the view's error. Try each key and Button with `actions`, and read each copy as the analyst will. Before you reply, fix in one new version what they would misread, a plot that came out mangled, and any change that makes the card easier to read or use. For a change, also one the analyst asks for, call card with the `id` and `edits`, since a whole view takes half a minute to write. The new version still answers the card's first question, with the change beside it. A new question gets a new card.

The guidance's Cards section says what makes a good card.
