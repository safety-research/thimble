// thimble's one hooks module: the agent bridge and file guard (thimble.ts) first, then the terminal UI (term/).
// Claude Code takes one `modules` entry per plugin, so this file registers both parts, thimble.ts first: a plugin's
// registrations nest in order, first outermost, so the file guard sees every tool call before the terminal UI does.
// Claude Code also refuses a second registration of an event without a matcher in one module, so the terminal UI's
// hooks on an event thimble.ts hooks too carry a matcher every event matches (term/register.tsx ANY).
//
// A failure in the terminal UI's register never stops the file guard or the bridge. A hooks module has no console, so
// the failure goes to the debug log ($.ui.log) at the session's start. Every file under term/ has no top-level side
// effects (only imports, constants, types and function declarations), so loading this module cannot fail at run time.
// Claude Code loads only registrations it can read in the source: each part is called by its imported name, never
// passed in. The tests are tests/one-module.test.ts.
import type { Register } from 'claude-code'

import { register as term } from './term/register'
import { register as bridge } from './thimble'

export const register: Register = (on, options) => {
  bridge(on, options)
  let failed = ''
  try {
    term(on, options)
  } catch (err) {
    failed = String(err).slice(0, 500) || 'an unknown error'
  }
  // a matcher every session matches (an empty RegExp), since thimble.ts hooks session.start without one
  if (failed) {
    on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
      const r = await next(e)
      $.ui.log(`thimble: the terminal UI did not load: ${failed}`)
      return r
    })
  }
}
