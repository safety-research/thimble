// hints.ts: the hints that say how to use a feature, and the reminders of the features asked for on demand. A how-to
// hint (select a passage first, the click that opens a pane in a narrow terminal) shows until the person has used that
// feature once in the session; after each of main's answers, one reminder names a feature set to on demand (or
// manual) that the session has not used yet, each at most once a session. Both are hints (notice.ts hintLine): the bar
// shows them in place of its keys, and they go after a few seconds, at the next key, or at a prompt.
//
//   state: hintsUsed (the features the session used), hintsReminded (the ones a reminder named)
import type { EngineInterface } from 'claude-code'

import { choiceOf, featureOn } from '../settings/features.mjs'
import { failLineNow, hintLine } from './notice'

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

/** The person used a feature (`explain`, `cite`, `heads`, `rewrite`, `pane:<kind>`): its how-to hint and its reminder
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

/** The end of one of main's answers: one reminder, of the first feature waiting to be asked that the session has
 *  neither used nor been reminded of. A line already showing (a failure, a hint) stays. */
export async function remindAfterAnswer($: Engine): Promise<void> {
  if (await failLineNow($)) return
  const used = await usedNow($)
  const reminded = await remindedNow($)
  const r = REMINDERS.find(x => x.on() && !used.includes(x.feature) && !reminded.includes(x.feature))
  if (!r) return
  await $.state.set(REMINDED, [...reminded, r.feature])
  hintLine($, r.text, `remind:${r.feature}`)
  $.ui.invalidate('ui.render')
}
