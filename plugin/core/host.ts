// host.ts: whether thimble's drawing shows in this session, as Claude Code says when the session starts. Its terminal
// interface (the REPL, `isInteractive`) draws thimble's bar, panes, cards and marks. A `claude -p` run draws none of
// them, nor does a host that runs Claude Code through its SDK and shows the conversation itself, such as the desktop
// app's Code tab or a remote Cowork session. There a key at an empty prompt is the person's own, typed as any key, and
// thimble starts no work that only its drawing shows: the designer's fork (v), the look after each answer (observer/).
// Citations, Cards, Explainers and Heads-ups act as off there, as if the person had set them off (settings/features.mjs
// UNDRAWN): the guidance leaves out their sections and names no key for them, no card tool is registered, and no
// citation is checked.
//
//   drawsHere()   whether thimble's drawing shows in this session: true until a session's start says it does not (a
//                 reload of the plugin starts the session again, with the same answer)
import type { Register } from 'claude-code'

import { setDrawn } from '../settings/features.mjs'

let drawn = true

export function drawsHere(): boolean {
  return drawn
}

export const registerHost: Register = on => {
  // before the hooks of the modules registered after this one, which read it at the same start, as do the features'
  // modes (settings/features.mjs)
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    drawn = e.isInteractive !== false
    setDrawn(drawn)
    return next(e)
  }).catch(($, e, next) => next(e))
}
