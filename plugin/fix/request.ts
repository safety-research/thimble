// request.ts: a request for a change, as the fix-thimble skill makes it (after the person's /thimble-fix <words>, or on
// Claude's own), and r (redo) on a fix that failed or no longer fits. Each makes the copy with the kernel, then starts
// the fixer in it. Claude decides whether the words follow up on a fix the person has: /thimble-fix gives it the list of
// their fixes (register.ts), and it starts the skill with one of these forms:
//
//   N <words>      a round of fix N itself, never a new fix: words for its fixer while one works, else a round in its
//                  copy (ready), else the kernel changes it in place (on or off): a copy holds its change, and the
//                  version the person has stays as it is until their y puts the new one on (u goes back to it)
//   new <words>    a new fix
//   <words>        the fixer that still works, else the fix the line shows while its copy is there, else a new fix
import type { EngineInterface } from 'claude-code'

import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { type Asker, liveFixer, screenNow, setAsker, startFixer } from './fixer'
import { type Fix, fixingWord, fixLineNow, fixName, fixOf, isChange, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'

type Engine = EngineInterface

/** What a request came to: the words the transcript shows after the command (or Claude reads after the skill), the
 *  fix, whether something went wrong, whether it is a round of a fix (not a new one), and whether its fixer already
 *  worked (live). */
export type Requested = { text: string; fix: Fix | null; failed: boolean; round: boolean; live?: boolean }

/** The fixes the words may change: any the person has in the list, at work or not. */
const CHANGEABLE = ['on', 'off', 'ready', 'working', 'failed', 'redo']

/** The explicit forms: `N <words>` for fix N, when N is a fix the person has, and `new <words>`. */
export function formOf(words: string, fixes: Fix[]): { words: string; target: number | null; fresh: boolean } {
  const n = /^#?(\d+)\s+([\s\S]+)$/.exec(words)
  if (n && fixes.some(f => f.id === Number(n[1]) && CHANGEABLE.includes(f.state))) return { words: n[2]!.trim(), target: Number(n[1]), fresh: false }
  const fresh = /^new\s+([\s\S]+)$/i.exec(words)
  if (fresh) return { words: fresh[1]!.trim(), target: null, fresh: true }
  return { words, target: null, fresh: false }
}

/** The person's fixes as Claude reads them when /thimble-fix runs: one line each, the number as the handle for the
 *  skill's `N <words>`, then the name and state. Empty when they have none. */
export function fixesContext(fixes: Fix[]): string {
  const shown = fixes.filter(f => CHANGEABLE.includes(f.state)).slice(0, 20)
  if (!shown.length) return ''
  const word = (f: Fix) => (f.prev?.state === 'on' && f.state !== 'on' ? `on, being changed (${f.state})` : f.state)
  return [
    "The person's thimble fixes (start the fix-thimble skill with `N <words>` to change fix N, `new <words>` for a new fix):",
    ...shown.map(f => `${f.id}  "${fixName(f, 80)}" (${word(f)})${f.summary ? `: ${cut(f.summary.replace(/\s+/g, ' '), 160)}` : ''}`),
  ].join('\n')
}

/** The fix-thimble skill (after /thimble-fix <words>, or Claude's own): words for a fix's live fixer, a round of a fix
 *  the person has, or a new fix. `tell`: Claude hears of a request it did not make at the person's next prompt. */
export async function request($: Engine, said: string, by: Asker = 'person', tell = true): Promise<Requested> {
  const who = by === 'claude' ? 'Claude' : 'The person'
  const form = formOf(said, (await refreshFixes($))?.fixes ?? [])
  const words = form.words
  // a fixer still works on the fix (the one named, or any without a form): the words go to it, as a round of its fix
  const live = form.fresh ? null : await liveFixer($, form.target)
  if (live) {
    const r = await kernelFix($, ['round', String(live.fix.id)], { stdin: words, timeoutMs: 60000 })
    const fix = r.ok ? jsonOf<Fix>(r.out) : null
    if (!fix) return { text: `× thimble could not add these words to “${fixName(live.fix)}”: ${cut(r.err || 'thimble fix gave nothing', 240)}`, fix: null, failed: true, round: true }
    await refreshFixes($)
    let sent: { isDelivered?: boolean; reason?: string } | undefined
    try {
      sent = await $.session.send({ to: { agentId: live.agentId }, text: roundText(fix, who, words) } as never) as never
    } catch (err) {
      sent = { isDelivered: false, reason: String((err as Error)?.message || err) }
    }
    if (!sent?.isDelivered) return { text: `× The fork ${fixingWord(fix)} did not get these words (${cut(String(sent?.reason || 'not delivered'), 160)}). They are kept with the fix: once it ends, r redoes it with them.`, fix, failed: true, round: true }
    return { text: `The fork ${fixingWord(fix)} has these words too. Keep going.`, fix, failed: false, round: true, live: true }
  }
  // the fix named, else (no form) the one the line shows while its copy is still there: a round of it
  const l = form.target == null && !form.fresh ? await fixLineNow($) : null
  const lineFix = l && (l.kind === 'ready' || l.kind === 'failed') ? await fixOf($, l.id) : null
  const cur = form.target != null ? await fixOf($, form.target) : lineFix?.work ? lineFix : null
  const round = !!cur
  // the screen as the person saw it when they asked, before thimble starts on the copy
  const screen = await screenNow($)
  const r = round
    ? await kernelFix($, ['round', String(cur!.id)], { stdin: words, timeoutMs: 180000, doing: 'making a copy of thimble' })
    : await kernelFix($, ['new', '--made-in', 'terminal'], { stdin: words, timeoutMs: 180000, doing: 'making a copy of thimble' })
  const fix = r.ok ? jsonOf<Fix>(r.out) : null
  if (!fix) return { text: `× thimble could not make a copy of itself to change${cur ? ` “${fixName(cur)}”` : ''}: ${cut(r.err || 'thimble fix gave nothing', 240)}`, fix: null, failed: true, round }
  if (round && (await fixLineNow($))?.id === fix.id) await setFixLine($, null)
  if (!round) await setAsker($, fix.id, by)
  await refreshFixes($)
  const bad = await startFixer($, fix, false, screen)
  if (bad) {
    await kernelFix($, ['done', String(fix.id), '--request', '--no-tests', '--summary', '-'], { stdin: bad })
    await refreshFixes($)
    return { text: `× ${bad} The words are kept with the fix: thimble fix list, in a shell, lists it.`, fix, failed: true, round }
  }
  if (by === 'person' && tell) await tellAtNextPrompt($, `fix-${fix.id}`, `The person asked thimble's fixer for a change to thimble itself (“${fixName(fix)}”); it works in the background in a copy, and thimble shows the person the result. Nothing for you to do.`)
  return round
    ? { text: `A fork of this session is changing “${fixName(fix)}” in the background${fix.prev ? '; the version you have stays until you press y' : ''}. Keep going.`, fix, failed: false, round }
    : { text: `A fork of this session is fixing it in the background (“${fixName(fix)}”). Keep going.`, fix, failed: false, round }
}

/** What a live fixer reads of a round: who adds which words to the fix it changes. */
export function roundText(fix: Fix, who: string, words: string): string {
  return `${who} adds to this fix (round ${fix.rounds}): ${words}`
}

/** r: the fix again, in a new copy cut from your thimble as it is now, with the earlier change to start from. */
export async function redoFix($: Engine, id: number): Promise<string | null> {
  const r = await kernelFix($, ['redo', String(id)], { timeoutMs: 180000, doing: 'making a copy of thimble' })
  const fix = r.ok ? jsonOf<Fix>(r.out) : null
  const was = await fixOf($, id)
  if (!fix) return `${was ? `“${fixName(was)}”` : `Fix ${id}`} could not start again: ${cut(r.err || 'thimble fix redo gave nothing', 220)}`
  if ((await fixLineNow($))?.id === id) await setFixLine($, null)
  await refreshFixes($)
  const bad = await startFixer($, fix, true)
  if (bad) return bad
  $.ui.toast(`A fork of this session is ${isChange(fix) ? 'changing' : 'fixing'} “${fixName(fix)}” again, in a new copy.`)
  return null
}
