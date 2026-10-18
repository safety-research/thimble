// thimble's lean plugin: its one hooks module. The kernel's watching hook (kernel.ts: which files Claude's own calls
// read, for `lean coverage`), the shell (../shell/shell.tsx: objects drawn under replies, the detail view, verb
// hints, the browser handoff), the observer (../observer/observer.ts: one quiet look after each turn of work, notes
// to Claude, a rare line above the prompt, and the ranking of each object's hint row), the prompt registry
// (../prompts/prompts.ts: which version of each text a model reads) and the telemetry (../telemetry/telemetry.ts:
// each model call and each turn in the session's events, with the time thimble's hooks took inside each main turn)
// register side by side. The telemetry registers twice, before and after the others, so its two hooks of each event
// inside a main turn bracket thimble's other hooks and time them.
import type { Register } from 'claude-code'

import { registerObserver } from '../observer/observer'
import { registerPrompts } from '../prompts/prompts'
import { registerShell } from '../shell/shell'
import { registerTelemetry } from '../telemetry/telemetry'
import { register as registerKernel } from './kernel'

export const register: Register = (on, options) => {
  registerTelemetry(on, 'first')
  registerPrompts(on, options)
  registerKernel(on, options)
  registerShell(on, options)
  registerObserver(on, options)
  registerTelemetry(on, 'last')
}
