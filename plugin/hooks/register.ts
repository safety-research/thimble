// thimble's one hooks module: the agent bridge and file guard (thimble.ts) first, then the terminal UI (term/).
// A failure in the terminal UI's register never stops the file guard or the bridge.
import type { Register } from 'claude-code'
import { register as bridge } from './thimble.ts'
import { register as term } from './term/register.tsx'
export const register: Register = (on, options) => {
  bridge(on, options)
  try { term(on, options) } catch (err) { console.error('thimble: the terminal UI did not load', err) }
}
