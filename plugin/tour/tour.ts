// tour.ts: the feature tour that /thimble:tour starts (skills/tour/SKILL.md). The skill gives Claude the exact words
// of each step, and Claude says one step per message. Step 1 is a fixed answer about the sample data (tour/sample/),
// with one number wrong on purpose, and ends with v. Each later step names one key or one click.
//
// When the person does what a step says, thimble sends Claude a short prompt of its own, such as `(thimble tour) Step
// 1 done. Say step 2.`, so Claude says the next step at once. The person never types to go on. A step is done at the
// moment it shows its result:
//
//   1  v      the first card that v's designer draws is on the screen (designer/v.ts)
//   2  e      the explainer of the selected words shows in the tray (explain/seam.ts)
//   3  click  a citation opens in the tray with its check (tray/tray.ts). Step 3k says ] in place of the click
//   4  s      the first text of the simpler version shows (squeeze/term.ts)
//   5         the end: where the settings are. The tour is over
//
// The next step is the first one after the current step that is not done and whose feature is on. Step 2 needs a
// selection, so it is left out where no click reaches thimble (Claude Code's classic layout: bar/intro.ts
// clicksReach), and step 3 is then 3k. A step the person did before its turn is left out when its turn comes. Each
// prompt goes once. When main's turn ends while the current step's feature is off, the tour goes on to the next step.
//
// The turns that the tour's prompts start answer nothing for thimble's features (core/answers.ts answerless). So s, ]
// and the observer act on the sample answer, not on the words of a step.
//
// The person's own prompt while a step waits: Claude answers it and says the step again (the skill says so). A second
// such prompt at the same step ends the tour, and Claude reads beside that prompt that the tour ended. So a card the
// person draws later sends no prompt. The tour is the session's: /thimble:tour starts it again, and a /clear or a
// /resume ends it (hooks/turnover.ts). Where thimble's drawing does not show (core/host.ts), no tour runs.
//
//   tourStart($)        the skill started (the person's /thimble:tour, or Claude's Skill call): step 1 waits
//   tourDid($, step)    the person did a step: `v`, `e`, `cite` or `s`
//   tourRuns($)         whether a tour runs (bar/hints.ts gives no reminder meanwhile)
//   turnTour($)         a /clear or a /resume: the tour ends
//   registerTour        the skill's start, the person's own prompts, and the end of main's turn
//
//   state: tour ({ at, done, asides } | null)
import type { EngineInterface, Register } from 'claude-code'

import { clicksReach } from '../bar/intro'
import { noticeLine } from '../bar/notice'
import { fullscreenNow } from '../cards/draw'
import { answerless } from '../core/answers'
import { drawsHere } from '../core/host'
import { tellAtNextPrompt } from '../core/tell'
import { featureOn } from '../settings/features.mjs'

type Engine = EngineInterface

/** A step the person does, in the order the tour asks for them. */
export type Step = 'v' | 'e' | 'cite' | 's'
export const STEPS: Step[] = ['v', 'e', 'cite', 's']

/** The tour now: the step that waits (`at`), the steps done, and how many of the person's own prompts came while `at`
 *  waits. */
export type Tour = { at: Step; done: Step[]; asides: number }

/** How every prompt of the tour's opens. A turn that such a prompt starts answers nothing for the features. */
export const TAG = '(thimble tour)'

/** The skill, as Claude Code names it (with the plugin's name, or without). */
export const TOUR_SKILL = /^(?:thimble:)?tour$/

/** The person's own prompts at one step that end the tour: the first gets an answer and the step again. */
export const ASIDES = 2

/** What Claude reads beside the person's prompt that ended the tour. */
export const STOPPED = `${TAG} The tour stopped: the person went on with their own work. Do not say its steps again.`

const TOUR = { plugin: 'thimble', key: 'tour' } as const

/** Whether a turn's prompt is one of the tour's: the features act on the answers before its turn, not on its words. A
 *  plugin's prompt (or one whose sender the record did not learn) with a line that opens with TAG: Claude Code may put
 *  its own line before a plugin's words. */
export const tourPrompt = (p: { text: string; by: string }): boolean =>
  (p.by === 'plugin' || p.by === 'unknown') && String(p.text).split('\n').some(l => l.trimStart().startsWith(TAG))

/** Whether a step's feature is on now. Step 2 needs a selection, which only a click reaches. */
function stepOn(s: Step, clicks: boolean): boolean {
  if (s === 'v') return featureOn('cards') === true
  if (s === 'e') return clicks && featureOn('explain') === true
  if (s === 'cite') return featureOn('cite') === true
  return featureOn('squeezeAnswers') === true
}

/** A step's name in the skill: its number, and 3k for the citation step where no click reaches thimble. */
export function stepName(s: Step | null, clicks: boolean): string {
  if (!s) return '5'
  if (s === 'cite') return clicks ? '3' : '3k'
  return String(STEPS.indexOf(s) + 1)
}

/** The step after `from` that the tour asks for next: not done, and on. Null: the end. */
export function nextStep(from: Step, done: Step[], clicks: boolean): Step | null {
  return STEPS.slice(STEPS.indexOf(from) + 1).find(s => !done.includes(s) && stepOn(s, clicks)) ?? null
}

/** Whether a click and a selection reach thimble, as the last drawing saw the layout. */
async function clicksNow($: Engine): Promise<boolean> {
  return clicksReach($, { surface: 'terminal', viewport: { isFullscreen: fullscreenNow() } }).catch(() => true)
}

export async function tourNow($: Engine): Promise<Tour | null> {
  const t = (await $.state.get(TOUR)).value as Tour | null | undefined
  if (!t || typeof t !== 'object' || !STEPS.includes(t.at)) return null
  return { at: t.at, done: Array.isArray(t.done) ? t.done : [], asides: Number(t.asides) || 0 }
}

async function save($: Engine, t: Tour | null): Promise<void> {
  await $.state.set(TOUR, t as never)
}

export async function tourRuns($: Engine): Promise<boolean> {
  return !!(await tourNow($))
}

/** The skill started: step 1 waits, whatever an earlier tour had done. Where thimble's drawing does not show (claude
 *  -p, the desktop app: core/host.ts), no step can be done, so no tour runs and thimble sends no prompt. */
export async function tourStart($: Engine): Promise<void> {
  if (!drawsHere()) return
  await save($, { at: 'v', done: [], asides: 0 })
}

/** A prompt of the tour's to Claude: it enters once main is idle. One that does not enter waits for the person's next
 *  prompt (core/tell.ts), and a notice above the bar says to type one. Not awaited: a key's hook has only a few
 *  milliseconds. */
function send($: Engine, text: string): void {
  const missed = (why: string) => {
    void tellAtNextPrompt($, 'tour', text).catch(() => undefined)
    noticeLine($, `The tour's next step did not reach Claude (${why.slice(0, 120)}). Type next to go on.`, 'tour')
  }
  void Promise.resolve($.prompt.submit({ text })).then(
    r => (r && 'drop' in r && r.drop !== undefined ? missed(String(r.drop || 'a hook refused it')) : undefined),
    (err: unknown) => missed(String((err as Error)?.message || err)),
  ).catch(() => undefined)
}

/** The tour's changes, one at a time, so that two moments at once send one prompt each at most. */
let chain: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn)
  chain = p.catch(() => undefined)
  return p
}

/** The step that waits goes on to the next one: the tour's prompt to Claude, which names it (`said`: why the step that
 *  waited ended), or the tour's end after step 5. */
async function goOn($: Engine, t: Tour, done: Step[], said: string): Promise<void> {
  const clicks = await clicksNow($)
  const next = nextStep(t.at, done, clicks)
  await save($, next ? { at: next, done, asides: 0 } : null)
  send($, `${TAG} Step ${stepName(t.at, clicks)} ${said}. Say step ${stepName(next, clicks)}.`)
}

/** The person did a step: the step that waits goes on to the next one. A later step done early counts when its turn
 *  comes. A step done again, or with no tour, does nothing. */
export function tourDid($: Engine, step: Step): Promise<void> {
  return inTurn(async () => {
    const t = await tourNow($)
    if (!t || t.done.includes(step)) return
    const done = [...t.done, step]
    if (step !== t.at) { await save($, { ...t, done }); return }
    await goOn($, t, done, 'done')
  })
}

/** The end of main's turn: a step that waits while its feature is off goes on, since the person cannot do it. Step 2
 *  with Explainers on is off only for the layout. */
async function offStep($: Engine): Promise<void> {
  await inTurn(async () => {
    const t = await tourNow($)
    const clicks = await clicksNow($)
    if (!t || stepOn(t.at, clicks)) return
    const why = t.at === 'e' && featureOn('explain') === true ? "needs Claude Code's fullscreen layout" : 'is off in the settings'
    await goOn($, t, t.done, why)
  })
}

/** The person's own prompt while a step waits: the second at the same step ends the tour. Returns what Claude reads
 *  beside it, or null. */
async function aside($: Engine): Promise<string | null> {
  return inTurn(async () => {
    const t = await tourNow($)
    if (!t) return null
    if (t.asides + 1 >= ASIDES) { await save($, null); return STOPPED }
    await save($, { ...t, asides: t.asides + 1 })
    return null
  })
}

export async function turnTour($: Engine): Promise<void> {
  await save($, null)
}

export const registerTour: Register = on => {
  answerless(tourPrompt)

  // the person's /thimble:tour starts it, and their own prompt while it runs counts as an aside
  on('prompt.submit', { origin: { kind: /^(?:composer|bridge)$/ } }, async ($, e, next) => {
    if (e.command) {
      if (TOUR_SKILL.test(String(e.command.name ?? ''))) await tourStart($).catch(() => undefined)
      return next(e)
    }
    const told = e.isMeta ? null : await aside($).catch(() => null)
    return next(told ? { ...e, context: [...(e.context ?? []), told] } : e)
  }).catch(($, e, next) => next(e))

  // Claude starts the skill with the Skill tool: the tour starts, and the skill runs as written
  on('tool.call', { tool: 'Skill', skill: TOUR_SKILL }, async ($, e, next) => {
    const skill = String((e as { skill?: unknown }).skill ?? '')
    if (e.agentId === undefined && TOUR_SKILL.test(skill)) await tourStart($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // the skill expanded some other way: the tour starts too (a second start in the same turn changes nothing)
  on('skill.prompt', { skill: TOUR_SKILL }, async ($, e, next) => {
    const r = await next(e)
    await tourStart($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: /^[\s\S]*$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await offStep($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
