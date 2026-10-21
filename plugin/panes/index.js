// index.js: thimble's own panes, each a program on the card runtime (draw/kit.js) over thimble's stores. Both surfaces
// import this file: the terminal (shell/panes.ts) and the browser (shell/browser/src/panes/), which loads it from the
// page server, so a pane is one implementation drawn in cells and in SVG.
//
// A pane module: {name, title, reads(args) -> store names, stateKey(args) -> where its state is kept, data(stores, args,
// size) -> the program's data, program(k, data) -> node}. A new pane is a new file here and a line below.
//
// A pane opened in the side panel (shell/side.ts openSide) is a thread: the host draws its side thread's conversation
// under it and an input bar at the bottom, with no code of its own. Optional fields say more:
//   titleOf(args) -> the panel's title in Claude Code's chrome (default: title)
//   thread(args, state, data) -> what its thread is about now: null (no thread, no input bar), or {scope?, label?,
//     refs?, about?, key?}. Without it, one thread per pane (its state key), each question about the part the program
//     selected (k.select), named by the part's label and carrying its refs (its region's meta ref or refs).
//   ringStart (or ringStart(args)) -> 'part': the ring starts on the part the program selected when the panel takes the
//     keys, not on the input bar (a pane whose parts are walked first, the Claims graph); a letter still asks. When
//     its program also takes up and down, the ring's moves from the selected part are those keys (shell/detail.tsx
//     walkDir), so ↑↓ and tab walk the parts in the program's order rather than where Claude Code's ring would land
import chips from './chips.js'
import claims from '../claims/graph.js'
import coverage from './coverage.js'
import detail from './detail.js'
import labels from './labels.js'
import mark from './mark.js'
import proposals from './proposals.js'
import settings from './settings.js'
import threads from './threads.js'
import tray from './tray.js'

export default { chips, claims, coverage, detail, labels, mark, proposals, settings, threads, tray }
