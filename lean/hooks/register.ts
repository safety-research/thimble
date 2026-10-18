// thimble's lean plugin: its one hooks module. The kernel's watching hook (kernel.ts: which files Claude's own calls
// read, for `lean coverage`) and the shell (../shell/shell.tsx: objects drawn under replies, the detail view, verb
// hints, the browser handoff) register side by side.
import type { Register } from 'claude-code'

import { registerShell } from '../shell/shell'
import { register as registerKernel } from './kernel'

export const register: Register = (on, options) => {
  registerKernel(on, options)
  registerShell(on, options)
}
