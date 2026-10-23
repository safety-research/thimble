// request.ts: a request for a change, as /thimble-fix <words> makes it (or Claude, with the fix-thimble skill), a round
// of a fix whose copy is still there, and r (redo) on a fix that failed or no longer fits. Each makes the copy with the
// kernel, then starts the fixer in it. Words for a fix whose fixer still works go to that fixer, as a round of its fix.
import type { EngineInterface } from 'claude-code'

import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { type Asker, liveFixer, screenNow, setAsker, startFixer } from './fixer'
import { type Fix, fixLineNow, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'

type Engine = EngineInterface

/** What a request came to: the words the transcript shows after the command (or Claude reads after the skill), the
 *  fix, and whether something went wrong. */
export type Requested = { text: string; fix: Fix | null; failed: boolean; round: boolean }

/** /thimble-fix <words>, or the fix-thimble skill: words for the fixer that still works (a round of its fix), a round of
 *  the fix the line shows while its copy is still there, or a new fix. */
export async function requestFix($: Engine, words: string, by: Asker = 'person'): Promise<string> {
  return (await request($, words, by)).text
}

export async function request($: Engine, words: string, by: Asker = 'person'): Promise<Requested> {
  const who = by === 'claude' ? 'Claude' : 'The person'
  // a fixer still works: the words go to it, and the kernel keeps them as a round of its fix
  const live = await liveFixer($)
  if (live) {
    const r = await kernelFix($, ['round', String(live.fix.id)], { stdin: words, timeoutMs: 60000 })
    const fix = r.ok ? jsonOf<Fix>(r.out) : null
    if (!fix) return { text: `× thimble could not add these words to fix ${live.fix.id}: ${cut(r.err || 'thimble fix gave nothing', 240)}`, fix: null, failed: true, round: true }
    await refreshFixes($)
    let sent: { isDelivered?: boolean; reason?: string } | undefined
    try {
      sent = await $.session.send({ to: { agentId: live.agentId }, text: `${who} adds to fix ${fix.id} (round ${fix.rounds}): ${words}` } as never) as never
    } catch (err) {
      sent = { isDelivered: false, reason: String((err as Error)?.message || err) }
    }
    if (!sent?.isDelivered) return { text: `× The fork fixing fix ${fix.id} did not get these words (${cut(String(sent?.reason || 'not delivered'), 160)}). They are kept with the fix: once it ends, r in /thimble-fix redoes it with them.`, fix, failed: true, round: true }
    return { text: `The fork fixing fix ${fix.id} has these words too. Keep going.`, fix, failed: false, round: true }
  }
  const l = await fixLineNow($)
  const cur = l ? await fixOf($, l.id) : null
  const round = !!(cur && cur.work && (l?.kind === 'ready' || l?.kind === 'failed'))
  // the screen as the person saw it when they asked, before thimble starts on the copy
  const screen = await screenNow($)
  const r = round
    ? await kernelFix($, ['round', String(cur!.id)], { stdin: words, timeoutMs: 120000, doing: 'making a copy of thimble' })
    : await kernelFix($, ['new', '--made-in', 'terminal'], { stdin: words, timeoutMs: 180000, doing: 'making a copy of thimble' })
  const fix = r.ok ? jsonOf<Fix>(r.out) : null
  if (!fix) return { text: `× thimble could not make a copy of itself to change: ${cut(r.err || 'thimble fix gave nothing', 240)}`, fix: null, failed: true, round }
  if (round) await setFixLine($, null)
  if (!round) await setAsker($, fix.id, by)
  await refreshFixes($)
  const bad = await startFixer($, fix, false, screen)
  if (bad) {
    await kernelFix($, ['done', String(fix.id), '--request', '--no-tests', '--summary', '-'], { stdin: bad })
    await refreshFixes($)
    return { text: `× ${bad} The words are kept as a request: /thimble-fix lists it.`, fix, failed: true, round }
  }
  if (by === 'person') await tellAtNextPrompt($, `fix-${fix.id}`, `The person asked thimble's fixer for a change to thimble itself (fix ${fix.id}); it works in the background in a copy, and thimble shows the person the result. Nothing for you to do.`)
  return round
    ? { text: `A fork of this session is fixing fix ${fix.id} again, with these words, in the background. Keep going.`, fix, failed: false, round }
    : { text: `A fork of this session is fixing it in the background (fix ${fix.id}). Keep going.`, fix, failed: false, round }
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
  $.ui.toast(`A fork of this session is fixing fix ${id} again, in a new copy.`)
  return null
}
