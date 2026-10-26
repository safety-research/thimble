// intro.ts: the line above the bar at the first session thimble runs in, a plain dim sentence that says where its
// settings are. It names no keys: the bar below names them. It goes at the person's first prompt, and no later
// session or reload shows it again.
//
//   introRow($, els)   the line, or null once it went
//   introDone($)       the person's first prompt: the line goes
//
//   store: introDone (true once the line went)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DONE = 'introDone'

export const INTRO = "Click thimble below for thimble's settings."

export async function introRow($: Engine, els: Any): Promise<Any | null> {
  if ((await $.store.get(DONE)) === true) return null
  return els.Text({ key: 'intro', dimColor: true, wrap: 'wrap', children: INTRO })
}

export async function introDone($: Engine): Promise<void> {
  if ((await $.store.get(DONE)) !== true) {
    await $.store.set(DONE, true)
    $.ui.invalidate('ui.render')
  }
}
