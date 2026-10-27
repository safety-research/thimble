// hints.ts: the hints that say how to use a feature, the reminders of the features asked for on demand, and the notices
// that teach the session something once. A how-to hint (select a passage first) shows until the person has used that
// feature once in the session; after each of main's answers, one reminder names a feature set to on demand (or
// manual) that the session has not used yet, each at most once a session. Both are hints (notice.ts hintLine): the bar
// shows them in place of its keys, and they go after a few seconds, at the next key, or at a prompt. A notice told once
// a session (noticeOnce: Claude Code's default layout, what the marks on an answer mean) stands in the failure line's
// place until the next prompt.
//
//   state: hintsUsed (the features the session used), hintsReminded (the ones a reminder named, and `intro`,
//          `fullscreen` and `legend` once told)
import type { EngineInterface } from 'claude-code'

import { fullscreenNow } from '../cards/draw'
import { choiceOf, featureOn } from '../settings/features.mjs'
import { introText } from './intro'
import { failLineNow, hintLine, noticeLine } from './notice'

type Engine = EngineInterface

const USED = { plugin: 'thimble', key: 'hintsUsed' } as const
const REMINDED = { plugin: 'thimble', key: 'hintsReminded' } as const

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
async function usedNow($: Engine): Promise<string[]> {
  return list((await $.state.get(USED)).value)
}

async function remindedNow($: Engine): Promise<string[]> {
  return list((await $.state.get(REMINDED)).value)
}

/** The person used a feature (`explain`, `cite`, `heads`, `rewrite`): its how-to hint and its reminder
 *  stop for the rest of the session. */
export async function hintUsed($: Engine, feature: string): Promise<void> {
  const used = await usedNow($)
  if (!used.includes(feature)) await $.state.set(USED, [...used, feature])
}

/** A how-to hint, while the session has not used its feature. */
export async function howTo($: Engine, feature: string, text: string, about?: string): Promise<void> {
  if (!(await usedNow($)).includes(feature)) hintLine($, text, about)
}

/** The reminders, in the order they are given: each while its feature waits to be asked. */
export const REMINDERS: { feature: string; on: () => boolean; text: string }[] = [
  { feature: 'explain', on: () => choiceOf('explain') === 'on demand', text: 'select a passage in an answer and press e to explain it.' },
  { feature: 'heads', on: () => choiceOf('details') === 'on demand', text: 'press h for heads-ups on the last answer.' },
  { feature: 'cite', on: () => choiceOf('citations') === 'manual', text: 'select a passage in an answer and press c to verify the claim.' },
  { feature: 'rewrite', on: () => featureOn('squeezeAnswers') === true, text: 'press s to rewrite the last answer shorter or longer, more novice or more expert.' },
]

/** What Claude Code's default layout lacks for thimble, and the command that changes it. */
export const FULLSCREEN = "thimble's clicks, word selection and side panes need Claude Code's fullscreen layout: type /tui fullscreen. Its keys work in either layout: ] opens an answer's citations, explainers and heads-ups one by one."

/** A notice the session is told once (`id`), in the failure line's place until the next prompt, while no failure or
 *  other notice stands there (a hint gives way to it). Answers whether it was told now. */
export async function noticeOnce($: Engine, id: string, text: string): Promise<boolean> {
  const line = await failLineNow($)
  if (line && line.hint === undefined) return false
  const reminded = await remindedNow($)
  if (reminded.includes(id)) return false
  await $.state.set(REMINDED, [...reminded, id])
  noticeLine($, text, id)
  $.ui.invalidate('ui.render')
  return true
}

/** The end of one of main's answers. In Claude Code's default layout, where thimble's clicks do nothing, the session is
 *  told once to change it. Else, while no line shows (a failure, a hint), the hint that says where the settings are, at
 *  the session's first answer (intro.ts); after that, one reminder, of the first feature waiting to be asked that the
 *  session has neither used nor been reminded of. */
export async function remindAfterAnswer($: Engine): Promise<void> {
  if (fullscreenNow() === false && (await noticeOnce($, 'fullscreen', FULLSCREEN))) return
  if (await failLineNow($)) return
  const used = await usedNow($)
  const reminded = await remindedNow($)
  const intro = reminded.includes('intro') ? null : await introText($)
  const r = intro ? { feature: 'intro', text: intro } : REMINDERS.find(x => x.on() && !used.includes(x.feature) && !reminded.includes(x.feature))
  if (!r) return
  await $.state.set(REMINDED, [...reminded, r.feature])
  hintLine($, r.text, r.feature === 'intro' ? 'intro' : `remind:${r.feature}`)
  $.ui.invalidate('ui.render')
}
