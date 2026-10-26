// intro.ts: the line above the bar at a session's start, which says what thimble's keys do and where its settings
// are: `thimble · v visualize · e explain · c cite · s rewrite · click thimble for settings`, each key only while its
// feature is on. It goes at the person's first prompt, and a resumed session does not show it again.
//
//   introRow($, els, presses)   the line, or null once it went
//   introDone($)                the person's first prompt: the line goes
//
//   state: introDone (the session whose line went)
import type { EngineInterface } from 'claude-code'

import { accent } from '../core/theme'
import { featureOn } from '../settings/features.mjs'
import type { BarPresses } from './bar'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DONE = { plugin: 'thimble', key: 'introDone' } as const

/** The keys the line names, each while its feature is on. */
export function introKeys(on: (key: string) => boolean = featureOn): [string, string][] {
  return ([['cards', 'v', 'visualize'], ['explain', 'e', 'explain'], ['cite', 'c', 'cite'], ['squeezeAnswers', 's', 'rewrite']] as const)
    .filter(([f]) => on(f)).map(([, k, w]) => [k, w])
}

async function sessionOf($: Engine): Promise<string> {
  try { return String(await $.session.id()) } catch { return '' }
}

export async function introRow($: Engine, els: Any, presses?: BarPresses): Promise<Any | null> {
  const id = await sessionOf($)
  if ((await $.state.get(DONE)).value === id) return null
  const name = els.Text({ key: 'intro-name', bold: true, color: accent(), children: 'thimble' })
  const parts: Any[] = [presses ? els.Button({ key: 'intro-thimble', plain: true, label: 'thimble settings', onPress: presses.settings, children: [name] }) : name]
  for (const [k, w] of introKeys()) parts.push(els.Text({ key: `intro-${k}`, children: [els.Text({ key: 'dot', dimColor: true, children: ' · ' }), els.Text({ key: 'k', bold: true, color: accent(), children: k }), els.Text({ key: 'w', dimColor: true, children: ` ${w}` })] }))
  parts.push(els.Text({ key: 'intro-settings', dimColor: true, children: ' · click thimble for settings' }))
  return els.Box({ key: 'intro', flexDirection: 'row', flexWrap: 'wrap', children: parts })
}

export async function introDone($: Engine): Promise<void> {
  const id = await sessionOf($)
  if ((await $.state.get(DONE)).value !== id) {
    await $.state.set(DONE, id)
    $.ui.invalidate('ui.render')
  }
}
