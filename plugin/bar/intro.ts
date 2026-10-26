// intro.ts: the line above the bar at the first session thimble runs in, a plain dim sentence that says where its
// settings are. It names no keys: the bar below names them. It goes after INTRO_MS, or at the person's first prompt,
// and no later session or reload shows it again.
//
//   introRow($, els)   the line, or null once it went
//   introDone($)       the person's first prompt: the line goes
//
//   store: introDone (true once the line went), introAt (when it first showed)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DONE = 'introDone'

export const INTRO = "Click thimble below for thimble's settings."

/** How long the line shows. */
export const INTRO_MS = 8000

/** When the line first showed (store), so a reload within INTRO_MS shows it for the time left, not again. */
const AT = 'introAt'

/** The start whose timer this load set. */
let timedFor = 0

export async function introRow($: Engine, els: Any): Promise<Any | null> {
  if ((await $.store.get(DONE)) === true) return null
  const now = Number(await $.clock.now())
  const kept = await $.store.get(AT)
  let at = typeof kept === 'number' && kept <= now ? kept : now
  if (at !== kept) await $.store.set(AT, at)
  if (now - at >= INTRO_MS) { await introDone($); return null }
  if (timedFor !== at) {
    timedFor = at
    $.clock.after(INTRO_MS - (now - at), () => { void introDone($).catch(() => undefined) })
  }
  return els.Text({ key: 'intro', dimColor: true, wrap: 'wrap', children: INTRO })
}

export async function introDone($: Engine): Promise<void> {
  if ((await $.store.get(DONE)) !== true) {
    await $.store.set(DONE, true)
    $.ui.invalidate('ui.render')
  }
}
