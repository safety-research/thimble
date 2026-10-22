// register.ts: labels in the session.
//
//   - a `label` line of the change feed starts the model's reads of a --prompt label beside the session (core/feed.ts
//     reads the feed after each Bash call and calls labels.ts labelFromFeed)
//   - a `thimble label` command of Claude's (main's or a fork's) may change a label: labelGen goes up, so the labels pane
//     reads the labels again
//   - the labels pane is pane.tsx (core/pane.ts kind `labels`); the bar's l and a click on its label count open it with
//     openLabels, and the person's checks there are labels.ts checkRecord
import type { Register } from 'claude-code'

import { labelsChanged } from './labels'

export const registerLabels: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (/\bthimble\b[^\n|;&]*\blabel\b/.test(String((e as { command?: unknown }).command || ''))) await labelsChanged($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
