// index.js: thimble's own panes, each a program on the card runtime (draw/kit.js) over thimble's stores. Both surfaces
// import this file: the terminal (shell/panes.ts) and the browser (shell/browser/src/panes/), which loads it from the
// page server, so a pane is one implementation drawn in cells and in SVG.
//
// A pane module: {name, title, reads(args) -> store names, stateKey(args) -> where its state is kept, data(stores, args,
// size) -> the program's data, program(k, data) -> node}. A new pane is a new file here and a line below.
import chips from './chips.js'
import claims from './claims.js'
import detail from './detail.js'
import proposals from './proposals.js'
import tray from './tray.js'

export default { chips, claims, detail, proposals, tray }
