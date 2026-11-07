// intro.ts: the first session thimble runs in, in the bar's hint row. First the hint that says where the settings are
// (bar.tsx draws it in place of its keys, or above them when it does not fit there): it goes after INTRO_MS, at the
// next key thimble takes, or at the person's first prompt. Then, after main's first answer in a session, a short tour,
// one step at a time above the bar's keys, each led by `Tour 1/4:` and naming its key: v draws a card, e explains
// selected words, a citation's evidence and what the check does when its words are wrong, s writes a shorter, plainer
// version. A step stays until the person does what it says (bar/hints.ts hintUsed names the feature), or until they
// sent TOUR_PROMPTS prompts while the bar showed it; then the next step shows. A step whose feature is off is skipped,
// and so is one that needs a selection where no click reaches thimble (clicksReach); there the citation step names ]
// in place of a click. It shows only while main does not work and no failure line or other hint shows (register.ts).
// Once the last step went, the tour is done for good. Neither shows again in a later session or reload once done. A
// tour not done goes on in the next session, after main's first answer there. Only a person who saw the intro gets
// the tour, so an install from before the tour never shows it.
//
//   introHint($, clicks)   the hint's words, or null once it went: the click on `thimble`, or the command where no click
//                          reaches thimble (clicksReach)
//   clicksReach($, e)      whether a click can reach the bar this drawing is for
//   introDone($)           the person's first prompt or key: the hint goes
//   tourHint($, clicks)    the tour's step now, its id, lead and words, or null
//   tourShown(id)          the step the bar drew last, or null when it drew none (register.ts)
//   tourStart($)           the end of main's turn: the tour may show in this session
//   tourUsed($, feature)   the person used a feature: each step about it is done
//   tourPrompt($)          the person's own prompt: the step the bar showed counts it
//   tourRuns($)            whether the tour is not done yet (bar/hints.ts gives no reminder meanwhile)
//
//   store: introDone (true once the line went), introAt (when it first showed), tour (the tour's progress: Tour)
//   state: tourAnswered (main answered in this session: the tour may show)
import type { EngineInterface } from 'claude-code'

import { mainRuns } from '../core/turn'
import { claudeCites, featureOn } from '../settings/features.mjs'

type Engine = EngineInterface

const DONE = 'introDone'

export const INTRO = 'click thimble for settings.'
/** The hint where no click reaches thimble. */
export const INTRO_TYPED = 'type /thimble-settings for settings.'

/** Whether a click can reach the bar drawn for `e` (its `ui.render` input). Not in the terminal when Claude Code draws
 *  its classic layout (`viewport.isFullscreen` false), which asks the terminal for no mouse reports; nor while
 *  CLAUDE_CODE_DISABLE_MOUSE is set (no mouse reports) or CLAUDE_CODE_DISABLE_MOUSE_CLICKS is (the wheel alone), read
 *  as Claude Code reads them: 1, true, yes or on sets one, 0, false, no or off unsets it, and the first, set either
 *  way, decides alone. A drawing that does not say, or another surface's, takes clicks. The pointer's moves are
 *  reported on the same terms (marks/register.ts pointerReported). */
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
  if (at !== kept) {
    await $.store.set(AT, at)
    // the intro's first showing ever: the tour follows it
    if (typeof kept !== 'number' && !(await $.store.get(TOUR))) await $.store.set(TOUR, { done: [], step: null, prompts: 0, over: false })
  }
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

// ------------------------------------------------------------------------------------------------ the tour

const TOUR = 'tour'
/** Main answered in this session (state): the tour shows after that, not at a session's start, where no answer is. */
const ANSWERED = { plugin: 'thimble', key: 'tourAnswered' } as const

/** The tour's progress: the steps done, the step the bar showed at the person's last prompt and how many prompts they
 *  sent while it showed, and whether the tour is over. */
type Tour = { done: string[]; step: string | null; prompts: number; over: boolean }

/** The prompts the person sends while a step shows before the next one shows. */
export const TOUR_PROMPTS = 2

/** One step: its id, the features whose use does it (bar/hints.ts hintUsed), whether it shows now (`clicks`: a click
 *  and a selection reach thimble), and its words. */
type Step = { id: string; uses: string[]; on: (clicks: boolean) => boolean; text: (clicks: boolean) => string }

/** What the check of a citation does, as each citation step says it (marks/checker.ts, marks/view.ts): words the data
 *  shows wrong are corrected in place when the check finds the right ones, else the citation is marked failed (×). */
const CHECKED = 'thimble checks it against the data, and corrects the words or marks them × when they are wrong.'

/** The steps, in order. */
export const TOUR_STEPS: Step[] = [
  { id: 'v', uses: ['visualize'], on: () => featureOn('cards') === true, text: () => 'press v to draw a card of this answer.' },
  { id: 'e', uses: ['explain'], on: clicks => clicks && featureOn('explain') === true, text: () => 'select a few words in the answer and press e to explain them.' },
  // Claude cites (auto cite, with or without verify): a click on a citation, or ] where no click reaches thimble, opens
  // it in the tray with its evidence. In manual, c on selected words cites them, which needs a selection
  {
    id: 'cite', uses: ['evidence', 'cite'], on: clicks => featureOn('cite') === true && (clicks || claudeCites()),
    text: clicks => (!claudeCites() ? `select a claim in the answer and press c: ${CHECKED}` : clicks ? `click a citation to see its evidence: ${CHECKED}` : `press ] to open a citation and its evidence: ${CHECKED}`),
  },
  { id: 's', uses: ['rewrite'], on: () => featureOn('squeezeAnswers') === true, text: () => 'press s for a shorter, plainer version of the answer.' },
]

/** Whether a click reached thimble where the bar last drew: the prompt's step is the one that showed there. */
let lastClicks = true
/** The step the bar drew last (register.ts tourShown), or null: a prompt counts only for a step the person saw. */
let drawn: string | null = null

async function tourNow($: Engine): Promise<Tour | null> {
  const t = (await $.store.get(TOUR)) as Tour | null | undefined
  return t && typeof t === 'object' && !t.over ? { ...t, done: Array.isArray(t.done) ? t.done : [] } : null
}

/** Whether main answered in this session. */
async function answered($: Engine): Promise<boolean> {
  return (await $.state.get(ANSWERED)).value === true
}

/** The steps that show where clicks reach thimble or not, with the features as set now, and the first not done. */
function stepsNow(t: Tour, clicks: boolean): { steps: Step[]; step: Step | null } {
  const steps = TOUR_STEPS.filter(s => s.on(clicks))
  return { steps, step: steps.find(s => !t.done.includes(s.id)) ?? null }
}

/** The tour is over: no step shows again. */
async function over($: Engine, t: Tour): Promise<void> {
  await $.store.set(TOUR, { ...t, over: true })
  $.ui.invalidate('ui.render')
}

/** The step that shows now: its id, its lead as the bar draws it (`Tour 1/4:`) and its words; null while there is none:
 *  no tour, main has not answered in this session yet, or works now. Once no step is left, the tour is over. */
export async function tourHint($: Engine, clicks = true): Promise<{ id: string; lead: string; words: string } | null> {
  const t = await tourNow($)
  if (!t || !(await answered($))) return null
  lastClicks = clicks
  const { steps, step } = stepsNow(t, clicks)
  if (!step) { await over($, t); return null }
  if (await mainRuns($)) return null
  return { id: step.id, lead: `Tour ${steps.indexOf(step) + 1}/${steps.length}:`, words: step.text(clicks) }
}

/** The bar drew this step (its id), or no step (null). */
export function tourShown(id: string | null): void {
  drawn = id
}

/** The end of main's turn: the tour shows from now on in this session, if the person has one. */
export async function tourStart($: Engine): Promise<void> {
  if (!(await tourNow($)) || (await answered($))) return
  await $.state.set(ANSWERED, true)
  $.ui.invalidate('ui.render')
}

/** The person used a feature: each step it does is done, so the next step shows at once. */
export async function tourUsed($: Engine, feature: string): Promise<void> {
  const t = await tourNow($)
  if (!t) return
  const done = TOUR_STEPS.filter(s => s.uses.includes(feature) && !t.done.includes(s.id)).map(s => s.id)
  if (!done.length) return
  await $.store.set(TOUR, { ...t, done: [...t.done, ...done] })
  $.ui.invalidate('ui.render')
}

/** The person's own prompt: the step the bar showed when they sent it counts it, and after TOUR_PROMPTS of them the
 *  next step shows. A prompt sent while no step showed (main worked, a failure line or a hint showed) does not count. */
export async function tourPrompt($: Engine): Promise<void> {
  if (!drawn) return
  const t = await tourNow($)
  if (!t || !(await answered($))) return
  const { step } = stepsNow(t, lastClicks)
  if (!step || step.id !== drawn) return
  // one prompt, one count: the next drawing says again whether the step shows
  drawn = null
  const prompts = (t.step === step.id ? t.prompts : 0) + 1
  await $.store.set(TOUR, prompts >= TOUR_PROMPTS ? { ...t, done: [...t.done, step.id], step: null, prompts: 0 } : { ...t, step: step.id, prompts })
}

/** Whether the person has a tour that is not over. */
export async function tourRuns($: Engine): Promise<boolean> {
  return !!(await tourNow($))
}
