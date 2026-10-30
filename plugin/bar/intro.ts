// intro.ts: the hint at the first session thimble runs in, which says where its settings are. The bar shows it as
// its other hints (bar.tsx), in place of its keys. It goes after INTRO_MS, at the next key thimble takes, or at the
// person's first prompt, and no later session or reload shows it again.
//
//   introHint($, clicks)   the hint's words, or null once it went: the click on `thimble`, or the command where no click
//                          reaches thimble (clicksReach)
//   clicksReach($, e)      whether a click can reach the bar this drawing is for
//   introDone($)           the person's first prompt or key: the hint goes
//
//   store: introDone (true once the line went), introAt (when it first showed)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

const DONE = 'introDone'

export const INTRO = 'click thimble for settings.'
/** The hint where no click reaches thimble. */
export const INTRO_TYPED = 'type /thimble-settings for settings.'

/** Whether a click can reach the bar drawn for `e` (its `ui.render` input). Not in the terminal when Claude Code draws
 *  its classic layout (`viewport.isFullscreen` false), which asks the terminal for no mouse reports; nor while
 *  CLAUDE_CODE_DISABLE_MOUSE is set (no mouse reports) or CLAUDE_CODE_DISABLE_MOUSE_CLICKS is (the wheel alone), read
 *  as Claude Code reads them: 1, true, yes or on sets one, 0, false, no or off unsets it, and the first, set either
 *  way, decides alone. A drawing that does not say, or another surface's, takes clicks. */
export async function clicksReach($: Engine, e: { surface?: string; viewport?: { isFullscreen?: boolean } }): Promise<boolean> {
  if (e.surface !== 'terminal') return true
  if (e.viewport?.isFullscreen === false) return false
  const noMouse = setOrNot(await $.env.get('CLAUDE_CODE_DISABLE_MOUSE'))
  if (noMouse !== undefined) return !noMouse
  return setOrNot(await $.env.get('CLAUDE_CODE_DISABLE_MOUSE_CLICKS')) !== true
}

/** A variable as Claude Code reads a switch of its own: set, unset, or neither (undefined). */
function setOrNot(v: string | undefined): boolean | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return undefined
}

/** How long the hint shows. */
export const INTRO_MS = 8000

/** When the hint first showed (store), so a reload within INTRO_MS shows it for the time left, not again. */
const AT = 'introAt'

/** The start whose timer this load set. */
let timedFor = 0
/** Whether this load showed the hint: a key reads no state unless it did. */
let shown = false

export async function introHint($: Engine, clicks = true): Promise<string | null> {
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
  return clicks ? INTRO : INTRO_TYPED
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
