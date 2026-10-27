// intro.ts: the hint at the first session thimble runs in, which says where its settings are. The bar shows it as
// its other hints (bar.tsx), in place of its keys, with a legend above it once: the colors of the heads-ups and the
// explainers in answers, and the keys that act on selected words. It goes after INTRO_MS, at the next key thimble
// takes, or at the person's first prompt, and no later session or reload shows it again.
//
//   introHint($)       the hint's words, or null once it went
//   introDone($)       the person's first prompt or key: the hint goes
//
//   store: introDone (true once the line went), introAt (when it first showed)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

const DONE = 'introDone'

export const INTRO = 'click thimble for settings.'

/** How long the hint shows. */
export const INTRO_MS = 8000

/** When the hint first showed (store), so a reload within INTRO_MS shows it for the time left, not again. */
const AT = 'introAt'

/** The start whose timer this load set. */
let timedFor = 0
/** Whether this load showed the hint: a key reads no state unless it did. */
let shown = false

export async function introHint($: Engine): Promise<string | null> {
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
  shown = true
  return INTRO
}

/** A key thimble takes: the hint goes, if this load showed it. */
export async function introKey($: Engine): Promise<void> {
  if (!shown) return
  shown = false
  await introDone($)
}

export async function introDone($: Engine): Promise<void> {
  if ((await $.store.get(DONE)) !== true) {
    await $.store.set(DONE, true)
    $.ui.invalidate('ui.render')
  }
}
