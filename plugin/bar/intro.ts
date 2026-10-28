// intro.ts: the hint at the first session thimble runs in, which says where its settings are, and the legend of the
// marks in answers. The bar shows the hint as its other hints (bar.tsx), in place of its keys. It goes after INTRO_MS,
// at the next key thimble takes, or at the person's first prompt, and no later session or reload shows it again.
// The legend stands above the bar (bar.tsx legendRow) once: from the first answer whose words show heads-ups or
// explainers (explain/seam.ts explainSpans) until the person's next prompt, in that session alone.
//
//   introHint($)       the hint's words, or null once it went
//   introDone($)       the person's first prompt or key: the hint goes
//   legendFor($, row)  the answer `row` shows heads-ups or explainers: the legend shows with it, if it never showed
//   legendNow($)       the answer the legend shows with, or null
//   legendGone($)      the person's prompt: a legend that showed goes, and no later answer shows it again
//
//   store: introDone (true once the line went), introAt (when it first showed), legendAt (the session and the answer
//   it showed with), legendDone (true once a prompt took it)
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

const LEGEND = 'legendAt'
const LEGEND_DONE = 'legendDone'

export async function legendFor($: Engine, row: string): Promise<void> {
  if ((await $.store.get(LEGEND_DONE)) === true || (await $.store.get(LEGEND))) return
  await $.store.set(LEGEND, { session: String(await $.session.id()), row })
  $.ui.invalidate('ui.render')
}

export async function legendNow($: Engine): Promise<string | null> {
  if ((await $.store.get(LEGEND_DONE)) === true) return null
  const at = (await $.store.get(LEGEND)) as { session?: string; row?: string } | null | undefined
  return at?.row && at.session === String(await $.session.id()) ? at.row : null
}

export async function legendGone($: Engine): Promise<void> {
  if ((await $.store.get(LEGEND_DONE)) === true || !(await $.store.get(LEGEND))) return
  await $.store.set(LEGEND_DONE, true)
  $.ui.invalidate('ui.render')
}
