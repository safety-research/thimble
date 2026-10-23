// request.ts: a request for a change, as /thimble-fix <words> makes it (or Claude, with the fix-thimble skill), a round
// of a fix whose copy is still there, and r (redo) on a fix that failed or no longer fits. Each makes the copy with the
// kernel, then starts the fixer in it. Words for a fix whose fixer still works go to that fixer, as a round of its fix.
//
//   /thimble-fix <words>      the fixer's round, else a round of the fix the line shows, else a new fix; while the fix
//                             the person applied last is on, the new fix's fixer is told of it, and its end may say
//                             `Changes fix N`: the kernel then folds the change into that fix (ready again, for y)
//   /thimble-fix N <words>    always a change to fix N (on, off or ready)
//   /thimble-fix new <words>  always a new fix
import type { EngineInterface } from 'claude-code'

import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { type Asker, liveFixer, screenNow, setAsker, startFixer } from './fixer'
import { type Fix, fixesNow, fixLineNow, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'

type Engine = EngineInterface

/** What a request came to: the words the transcript shows after the command (or Claude reads after the skill), the
 *  fix, and whether something went wrong. */
export type Requested = { text: string; fix: Fix | null; failed: boolean; round: boolean }

/** /thimble-fix <words>, or the fix-thimble skill: words for the fixer that still works (a round of its fix), a round of
 *  the fix the line shows while its copy is still there, or a new fix. */
export async function requestFix($: Engine, words: string, by: Asker = 'person'): Promise<string> {
  return (await request($, words, by)).text
}

/** The fixes a request can change: on, off or ready, with a change. */
const REFINABLE = ['on', 'off', 'ready']

/** The explicit forms: `N <words>` for fix N, when N is a fix that is on, off or ready, and `new <words>`. */
export function formOf(words: string, fixes: Fix[]): { words: string; target: number | null; fresh: boolean } {
  const n = /^#?(\d+)\s+([\s\S]+)$/.exec(words)
  if (n && fixes.some(f => f.id === Number(n[1]) && REFINABLE.includes(f.state) && f.commit)) return { words: n[2]!.trim(), target: Number(n[1]), fresh: false }
  const fresh = /^new\s+([\s\S]+)$/i.exec(words)
  if (fresh) return { words: fresh[1]!.trim(), target: null, fresh: true }
  return { words, target: null, fresh: false }
}

/** The fix the person applied last, while it is on (and their fixes are), or null. */
export function lastApplied(list: { fixes: Fix[]; on: boolean } | null): Fix | null {
  if (!list || list.on === false) return null
  const on = list.fixes.filter(f => f.state === 'on' && f.commit)
  return on.sort((a, b) => (b.on_at ?? 0) - (a.on_at ?? 0) || b.id - a.id)[0] ?? null
}

export async function request($: Engine, said: string, by: Asker = 'person'): Promise<Requested> {
  const who = by === 'claude' ? 'Claude' : 'The person'
  const form = formOf(said, (await refreshFixes($))?.fixes ?? [])
  const words = form.words
  // a fixer still works: the words go to it, and the kernel keeps them as a round of its fix (not when the person
  // names another fix, or asks for a new one)
  const live = await liveFixer($)
  if (live && !form.fresh && (form.target == null || form.target === live.fix.id)) {
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
  const named = form.target != null ? await fixOf($, form.target) : null
  // the fix the line shows, or the one the person named, while its copy is still there: a round in that copy
  const cur = named ?? (l && !form.fresh ? await fixOf($, l.id) : null)
  const round = !!(cur && cur.work && (named ? cur.state === 'ready' : l?.kind === 'ready' || l?.kind === 'failed'))
  // else a new fix; it may change the fix the person named, or the one they applied last
  const refines = round || form.fresh ? null : named ?? lastApplied(await fixesNow($))
  // the screen as the person saw it when they asked, before thimble starts on the copy
  const screen = await screenNow($)
  const r = round
    ? await kernelFix($, ['round', String(cur!.id)], { stdin: words, timeoutMs: 120000, doing: 'making a copy of thimble' })
    : await kernelFix($, ['new', '--made-in', 'terminal', ...(refines ? ['--refines', String(refines.id), ...(named ? ['--always'] : [])] : [])], { stdin: words, timeoutMs: 180000, doing: 'making a copy of thimble' })
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
    : named
      ? { text: `A fork of this session is changing fix ${named.id} in the background. Keep going.`, fix, failed: false, round }
      : { text: `A fork of this session is fixing it in the background (fix ${fix.id}: ${cut(fix.title, 60)}). Keep going.`, fix, failed: false, round }
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
