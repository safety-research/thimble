// register.ts: cards. Claude writes rows as a JSON file and calls the `card` tool with the file and a short view; the
// plugin runs the view in its runner, draws the card under the call (or under the answer v was pressed on), takes the
// focused card's keys at an empty prompt, and gives Claude a text copy of what it drew.
//
// The cards lane builds it here (tool.ts, runner.mjs, layout.js, client.tsx, draw.ts, store.ts). Until then this
// registers nothing.
import type { Register } from 'claude-code'

export const registerCards: Register = () => {}
