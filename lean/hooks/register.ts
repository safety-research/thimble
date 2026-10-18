// thimble's lean plugin: its one hooks module. The kernel's watching hook (kernel.ts: which files Claude's own calls
// read, for `lean coverage`), the shell (../shell/shell.tsx: objects drawn under replies, the detail view, verb
// hints, the browser handoff) and the observer (../observer/observer.ts: one quiet look after each turn of work, notes
// to Claude, a rare line above the prompt, and the ranking of each object's hint row) register side by side.
import type { Register } from 'claude-code'

import { registerObserver } from '../observer/observer'
import { registerShell } from '../shell/shell'
import { register as registerKernel } from './kernel'

export const register: Register = (on, options) => {
  registerKernel(on, options)
  registerShell(on, options)
  registerObserver(on, options)
}
