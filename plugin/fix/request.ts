// request.ts: a request for a change, as /thimble-fix <words> makes it, a round of a fix whose copy is still there, and
// r (redo) on a fix that failed or no longer fits. Each makes the copy with the kernel, then starts the fixer in it.
import type { EngineInterface } from 'claude-code'

import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { startFixer } from './fixer'
import { type Fix, fixLineNow, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'

type Engine = EngineInterface

/** /thimble-fix <words>: a new fix, or a round of the fix the line shows while its copy is still there. The words the
 *  transcript shows after the command, or a problem with what to do. */
export async function requestFix($: Engine, words: string): Promise<string> {
  const l = await fixLineNow($)
  const cur = l ? await fixOf($, l.id) : null
  const round = !!(cur && cur.work && (l?.kind === 'ready' || l?.kind === 'failed'))
  const r = round
    ? await kernelFix($, ['round', String(cur!.id)], { stdin: words, timeoutMs: 120000, doing: 'making a copy of thimble' })
    : await kernelFix($, ['new', '--made-in', 'terminal'], { stdin: words, timeoutMs: 180000, doing: 'making a copy of thimble' })
  const fix = r.ok ? jsonOf<Fix>(r.out) : null
  if (!fix) return `× thimble could not make a copy of itself to change: ${cut(r.err || 'thimble fix gave nothing', 240)}`
  if (round) await setFixLine($, null)
  await refreshFixes($)
  const bad = await startFixer($, fix)
  if (bad) {
    await kernelFix($, ['done', String(fix.id), '--request', '--no-tests', '--summary', '-'], { stdin: bad })
    await refreshFixes($)
    return `× ${bad} Your words are kept as a request: /thimble-fix lists it.`
  }
  await tellAtNextPrompt($, `fix-${fix.id}`, `The person asked thimble's fixer for a change to thimble itself (fix ${fix.id}); it works in the background in a copy, and thimble shows the person the result. Nothing for you to do.`)
  return round
    ? `thimble:fixer works on round ${fix.rounds} of fix ${fix.id}, “${fix.title}”, in its copy of thimble. Keep working.`
    : `thimble:fixer works on fix ${fix.id}, “${fix.title}”, in the background, in a copy of thimble. Your thimble stays as it is until you apply the fix. Keep working.`
}

/** r: the fix again, in a new copy cut from your thimble as it is now, with the earlier change to start from. */
export async function redoFix($: Engine, id: number): Promise<string | null> {
  const r = await kernelFix($, ['redo', String(id)], { timeoutMs: 180000, doing: 'making a copy of thimble' })
  const fix = r.ok ? jsonOf<Fix>(r.out) : null
  if (!fix) return `Fix ${id} could not start again: ${cut(r.err || 'thimble fix redo gave nothing', 220)}`
  if ((await fixLineNow($))?.id === id) await setFixLine($, null)
  await refreshFixes($)
  const bad = await startFixer($, fix, true)
  if (bad) return bad
  $.ui.toast(`thimble:fixer works on fix ${id} again, in a new copy.`)
  return null
}
