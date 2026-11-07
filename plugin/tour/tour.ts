// tour.ts: the feature tour that /thimble:tour starts (skills/tour/SKILL.md). Claude writes one thing: step 0, a fixed
// answer about the sample data (tour/sample/), with one number wrong on purpose. thimble draws every other word of the
// tour itself, in two rows it places in the transcript ($.ui.place, drawn at ui.render for `Placed`). The model never
// reads them, and the tour sends Claude no prompt.
//
//   the intro    placed as the tour starts, so it stands above the sample answer: what thimble does, and what comes
//   the step row placed under the sample answer when Claude ends it. It shows the tour's progress, the steps done, and
//                the one action that waits. It draws again in place as each step is done, so it stays right under
//                what the action drew under the answer (a card, the simpler version). When the person's own prompt
//                gets an answer meanwhile, the row is placed again under that answer, and the old one draws nothing
//
// A step is done at the moment it shows its result:
//
//   answer    main's turn that the skill started ends with an answer: the sample answer
//   e         the explainer of the selected words shows in the tray (explain/seam.ts)
//   cite      the marked citation, the wrong number, opens in the tray with its check (tray/tray.ts tourOpened). By
//             then the checker has corrected it, so the tray shows the old value and the check. Where no click reaches
//             thimble, ] opens it
//   v         the first card that v's designer draws is on the screen (designer/v.ts). A design that ends with no
//             card counts too (tourMissed), so the tour goes on
//   s         the first text of the simpler version shows (squeeze/term.ts)
//
// The steps that act on the answer's words come first, while the answer is on the screen. The step that waits is the
// first one not done whose feature is on: e needs a selection, which only a click reaches (bar/intro.ts clicksReach).
// While e or cite waits, the sample answer marks what to select or click (tourSpans, drawn by core/answerview.ts).
//
// While the tour runs after the sample answer, main's turns answer nothing for thimble's features (core/answers.ts
// holdAnswers). So v, e, ], s and the observer act on the sample answer, not on a reply to the person's own prompt. The
// observer does not look at the sample answer itself (tourSample): Claude wrote it without reading the data, on
// purpose, and the checker checks its numbers. A /clear or a /resume ends the tour (hooks/turnover.ts). Where
// thimble's drawing does not show (core/host.ts), no tour runs.
//
// After an install inside Claude Code, the installer writes the session's id to $THIMBLE_HOME/tour-next. When thimble
// loads in that session (the person's /reload-plugins), it runs /thimble:tour once.
//
//   tourStart($)          the skill started: step 0 waits, and the intro is placed
//   tourDid($, step)      a step done: `answer`, `e`, `cite`, `v` or `s`
//   tourMissed($, step)   a step that the person did but that did not work (v drew no card): the tour goes on
//   tourOpened($, row, n) citation n of a row opened in the tray: the cite step done when it is the marked one
//   tourRuns($)           whether a tour runs (bar/hints.ts gives no reminder meanwhile)
//   tourSample($, row)    whether a row is the tour's sample answer, or the answer of the turn that writes it now
//   tourSpans($, row, t)  the marks on the sample answer's words while e or cite waits
//   turnTour($)           a /clear or a /resume: the tour ends
//   registerTour          the start, the end of main's turn, the rows' drawing, and the start after an install
//
//   state: tour (TourState, or null), tourSample (the row of the sample answer, kept after the tour ends)
import type { EngineInterface, Register } from 'claude-code'

import { clicksReach } from '../bar/intro'
import { fullscreenNow } from '../cards/draw'
import { holdAnswers, messageOf, turnOf, type TurnRec } from '../core/answers'
import type { Span } from '../core/answerview'
import { thimbleHome } from '../core/home'
import { drawsHere } from '../core/host'
import { accent, themeNow } from '../core/theme'
import { marksIn } from '../marks/message.js'
import { featureOn } from '../settings/features.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A step that is done, in the order the tour asks for them: the sample answer, then what the person does. */
export type Step = 'answer' | 'e' | 'cite' | 'v' | 's'
export const STEPS: Step[] = ['answer', 'e', 'cite', 'v', 's']

/** The tour: the step that waits (`end` once all are done), the steps done, those that did not work, when it started,
 *  and the ids of its two rows (`row` null until the sample answer is written; `k` counts the rows placed). */
export type TourState = { at: Step | 'end'; done: Step[]; missed: Step[]; startedAt: number; intro: string; row: string | null; k: number }
export type Tour = TourState & { at: Step }

/** The skill, as Claude Code names it (with the plugin's name, or without). */
export const TOUR_SKILL = /^(?:thimble:)?tour$/

/** The file in thimble's home that an install inside Claude Code writes the session's id to (scripts/install.sh). */
export const NEXT_FILE = 'tour-next'

/** A start this soon after the last one is the same start: the command, the skill and the Skill call each start it. */
const SAME_START_MS = 10_000

const TOUR = { plugin: 'thimble', key: 'tour' } as const
const SAMPLE = { plugin: 'thimble', key: 'tourSample' } as const

/** What the intro says. */
export const INTRO = [
  "thimble works on Claude's answers. It checks their numbers, draws cards, explains words and writes simpler versions.",
  'Below, Claude writes an answer about the made-up orders of a tea shop. One number in it is wrong on purpose.',
]

/** What the end says. Where no click reaches thimble, the settings are named by their command alone. */
export const END = (clicks: boolean): string[] => [
  'The tour is over.',
  clicks ? "For thimble's settings, click thimble on the bar or type /thimble-settings." : "For thimble's settings, type /thimble-settings.",
  'Type /thimble:tour to take the tour again.',
]

/** One step's action while it waits: its words, with each key as `{k}`. */
export function stepAction(s: Step, clicks: boolean): string {
  if (s === 'e') return 'Select the highlighted words with the mouse, then press {e}.'
  if (s === 'cite') return clicks
    ? 'One number was wrong on purpose. Click the highlighted number to see how thimble checked it.'
    : 'One number was wrong on purpose. Press {]} until the tray above the prompt shows the highlighted number.'
  if (s === 'v') return 'Press {v} to draw a card of the answer.'
  if (s === 's') return 'Press {s} for a shorter, plainer version of the answer.'
  return ''
}

/** One step once done. */
export function stepDone(s: Step, missed: boolean): string {
  if (s === 'e') return 'e explained the words.'
  if (s === 'cite') return "The tray showed thimble's check of the wrong number."
  if (s === 'v') return missed ? 'v drew no card this time.' : 'v drew a card.'
  if (s === 's') return 's wrote a simpler version.'
  return ''
}

/** Whether a step's feature is on now. Step e needs a selection, which only a click reaches. */
function stepOn(s: Step, clicks: boolean): boolean {
  if (s === 'answer') return true
  if (s === 'v') return featureOn('cards') === true
  if (s === 'e') return clicks && featureOn('explain') === true
  if (s === 'cite') return featureOn('cite') === true
  return featureOn('squeezeAnswers') === true
}

/** The step after `from` that the tour asks for next: not done, and on. Null: the end. */
export function nextStep(from: Step, done: Step[], clicks: boolean): Step | null {
  return STEPS.slice(STEPS.indexOf(from) + 1).find(s => !done.includes(s) && stepOn(s, clicks)) ?? null
}

/** The person's steps the row shows, in order: those whose feature is on, and those done. */
function shownSteps(t: TourState, clicks: boolean): Step[] {
  return STEPS.filter(s => s !== 'answer' && (t.done.includes(s) || stepOn(s, clicks)))
}

/** Whether a click and a selection reach thimble, as the last drawing saw the layout. */
async function clicksNow($: Engine): Promise<boolean> {
  return clicksReach($, { surface: 'terminal', viewport: { isFullscreen: fullscreenNow() } }).catch(() => true)
}

async function stateNow($: Engine): Promise<TourState | null> {
  const t = (await $.state.get(TOUR)).value as TourState | null | undefined
  if (!t || typeof t !== 'object' || !(STEPS.includes(t.at as Step) || t.at === 'end')) return null
  return {
    at: t.at, done: Array.isArray(t.done) ? t.done : [], missed: Array.isArray(t.missed) ? t.missed : [],
    startedAt: Number(t.startedAt) || 0, intro: String(t.intro ?? ''), row: t.row ? String(t.row) : null, k: Number(t.k) || 0,
  }
}

/** The tour that runs now, or null (none, or over). */
export async function tourNow($: Engine): Promise<Tour | null> {
  const t = await stateNow($)
  return t && t.at !== 'end' ? (t as Tour) : null
}

/** The tour, saved. After the sample answer, main's turns answer nothing while the tour runs. */
async function save($: Engine, t: TourState | null): Promise<void> {
  await $.state.set(TOUR, t as never)
  await holdAnswers($, !!t && t.at !== 'answer' && t.at !== 'end')
}

export async function tourRuns($: Engine): Promise<boolean> {
  return !!(await tourNow($))
}

/** Whether `row` is the tour's sample answer: the row kept when step 0 was done, or, while step 0 waits, the answer of
 *  the turn that ends now. */
export async function tourSample($: Engine, row: string | null | undefined): Promise<boolean> {
  if (!row) return false
  if ((await $.state.get(SAMPLE)).value === row) return true
  return (await tourNow($))?.at === 'answer'
}

/** A row placed at the transcript's end. A failure leaves the tour without it. */
async function place($: Engine, id: string): Promise<void> {
  try { await $.ui.place({ id }) } catch { /* the tour goes on without the row */ }
}

/** The tour's changes, one at a time. */
let chain: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn)
  chain = p.catch(() => undefined)
  return p
}

/** The skill started: step 0 waits, whatever an earlier tour had done, and the intro is placed at the transcript's end,
 *  above the answer Claude writes now. A second start a few seconds later is the same start. Where thimble's drawing
 *  does not show (claude -p, the desktop app: core/host.ts), no step can be done, so no tour runs. */
export function tourStart($: Engine): Promise<void> {
  return inTurn(async () => {
    if (!drawsHere()) return
    const now = Number(await $.clock.now()) || 0
    const was = await stateNow($)
    if (was?.at === 'answer' && now - was.startedAt < SAME_START_MS) return
    const k = (was?.k ?? 0) + 1
    const intro = `tour-intro-${k}`
    await save($, { at: 'answer', done: [], missed: [], startedAt: now, intro, row: null, k })
    await place($, intro)
  })
}

/** The step that waits goes on to the next one, or to the end. The step row draws again from the state. */
async function goOn($: Engine, t: Tour, done: Step[], missed: Step[]): Promise<void> {
  const next = nextStep(t.at, done, await clicksNow($))
  await save($, { ...t, at: next ?? 'end', done, missed })
}

/** A step done: the step that waits goes on to the next one. A later step done early counts when its turn comes. A
 *  step done again, or with no tour, does nothing. */
export function tourDid($: Engine, step: Step): Promise<void> {
  return inTurn(async () => {
    const t = await tourNow($)
    if (!t || t.done.includes(step)) return
    const done = [...t.done, step]
    if (step !== t.at) { await save($, { ...t, done }); return }
    await goOn($, t, done, t.missed)
  })
}

/** A step the person did that did not work, such as v that drew no card: when it is the step that waits, the tour goes
 *  on to the next one, since the person would wait for a result that never comes. */
export function tourMissed($: Engine, step: Step): Promise<void> {
  return inTurn(async () => {
    const t = await tourNow($)
    if (!t || t.at !== step || t.done.includes(step)) return
    await goOn($, t, [...t.done, step], [...t.missed, step])
  })
}

/** Citation `n` of `row` opened in the tray: the cite step done when it is the citation the tour marks on the sample
 *  answer (its number is its place among the answer's citations). When the marked words are not in the answer, any of
 *  its citations does. */
export async function tourOpened($: Engine, row: string, n: number): Promise<void> {
  if (!(await tourRuns($)) || (await $.state.get(SAMPLE)).value !== row) return
  const text = (await messageOf($, row))?.text ?? ''
  const at = markedWords('cite', text)
  const k = at ? marksIn(text).findIndex((m: { start: number }) => m.start === at.start) : -1
  if (k >= 0 && k + 1 !== n) return
  await tourDid($, 'cite')
}

/** Main's turn ended while the tour runs. The turn that the skill started, with an answer: step 0 done, and the step
 *  row placed under it. A later turn (the answer to the person's own prompt): the step row placed again under it. A
 *  step that waits while its feature is off goes on, since the person cannot do it. */
async function turnEnded($: Engine, turn: TurnRec | null): Promise<void> {
  await inTurn(async () => {
    const t = await tourNow($)
    if (!t) return
    const k = t.k + 1
    const row = `tour-step-${k}`
    if (t.at === 'answer') {
      // core/answers.ts records the turn's answer before this hook hears the end
      if (!turn?.answer) return
      await $.state.set(SAMPLE, turn.answer)
      await goOn($, { ...t, row, k }, [...t.done, 'answer'], t.missed)
    } else if (stepOn(t.at, await clicksNow($))) await save($, { ...t, row, k })
    else await goOn($, { ...t, row, k }, t.done, t.missed)
    await place($, row)
  })
}

export async function turnTour($: Engine): Promise<void> {
  await save($, null)
}

// ------------------------------------------------------------------------------------------------ the marks

/** The words the step that waits acts on, in the sample answer's text: the words to select for e, the citation of the
 *  refunds to open for cite. [start, end) in `text`; null when the step acts on no words or they are not there. */
export function markedWords(step: Step, text: string): { start: number; end: number } | null {
  if (step === 'e') {
    const words = 'average order value'
    const i = text.toLowerCase().indexOf(words)
    return i < 0 ? null : { start: i, end: i + words.length }
  }
  if (step === 'cite') {
    const m = /refunded (\[[^\]\n]+\]\(#\))/.exec(text)
    return m ? { start: m.index + 'refunded '.length, end: m.index + m[0].length } : null
  }
  return null
}

/** The mark on the sample answer's words while e or cite waits: a fill in thimble's purple, the words bold. A citation
 *  keeps its own press, so the mark has none. */
export async function tourSpans($: Engine, row: string, text: string): Promise<Span[]> {
  const t = await tourNow($)
  if (!t || (t.at !== 'e' && t.at !== 'cite')) return []
  if ((await $.state.get(SAMPLE)).value !== row) return []
  const at = markedWords(t.at, text)
  if (!at) return []
  const fill = (await themeNow($)) === 'light' ? '#dcc8ff' : '#4b2d80'
  return [{ id: `tour-${t.at}`, ...at, look: { backgroundColor: fill, bold: true }, label: t.at === 'e' ? 'the tour: select these words' : 'the tour: click this number' }]
}

// ------------------------------------------------------------------------------------------------ the rows

/** A line of words with each `{k}` drawn as a key, in thimble's color. */
function withKeys(els: Any, text: string, key: string, look: Any = {}): Any {
  const parts = text.split(/\{([^}]+)\}/)
  return els.Text({ key, ...look, children: parts.map((p, i) => (i % 2 ? els.Text({ key: `k${i}`, color: accent(), bold: true, children: p }) : p)) })
}

/** The frame of both rows: a border in thimble's color, a bold title, a blank row, then the lines. */
function frame(els: Any, key: string, cols: number, title: string, lines: Any[]): Any {
  return els.Box({
    key, flexDirection: 'column', borderStyle: 'round', borderColor: accent(), paddingX: 1, marginLeft: 2,
    width: Math.max(30, Math.min(cols - 4, 84)),
    children: [els.Text({ key: 'title', bold: true, color: accent(), children: title }), els.Text({ key: 'gap', children: ' ' }), ...lines],
  })
}

export function introEl(els: Any, cols: number): Any {
  return frame(els, 'tour-intro', cols, 'thimble tour', INTRO.map((l, i) => els.Text({ key: `l${i}`, children: l })))
}

export function stepRowEl(els: Any, t: TourState, clicks: boolean, cols: number): Any {
  const steps = shownSteps(t, clicks)
  const title = t.at === 'end' ? 'thimble tour · done' : `thimble tour · ${steps.indexOf(t.at as Step) + 1} of ${steps.length}`
  const lines: Any[] = []
  for (const s of steps) {
    if (t.done.includes(s)) lines.push(els.Text({ key: `d-${s}`, dimColor: true, children: `✓ ${stepDone(s, t.missed.includes(s))}` }))
    else if (s === t.at) lines.push(withKeys(els, `› ${stepAction(s, clicks)}`, `a-${s}`, { bold: true }))
  }
  if (t.at === 'end') lines.push(...(lines.length ? [els.Text({ key: 'gap2', children: ' ' })] : []), ...END(clicks).map((l, i) => els.Text({ key: `e${i}`, children: l })))
  return frame(els, `tour-row-${t.row}`, cols, title, lines)
}

/** A placed row of the tour's: the intro, the step row, or nothing (a step row placed again further down, or a row of
 *  a tour that a /clear ended). */
async function drawRow($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const id = String(e.props?.id ?? '')
  const t = await stateNow($)
  const cols = Math.max(30, Number(e.viewport?.columns ?? 100))
  if (t && id === t.intro) return introEl(els, cols)
  if (t && t.row && id === t.row) return stepRowEl(els, t, await clicksReach($, e).catch(() => true), cols)
  return els.Box({ key: `tour-none-${id}`, children: [] })
}

// ------------------------------------------------------------------------------------------------ the start after an install

/** Whether $THIMBLE_HOME/tour-next names this session: thimble loads in the session that installed it. The file is
 *  emptied, so the tour starts once. */
async function startsAfterInstall($: Engine): Promise<boolean> {
  const file = `${await thimbleHome($)}/${NEXT_FILE}`
  let named = ''
  try { named = String(await $.fs.read(file)).trim() } catch { return false }
  if (!named || named !== String(await $.session.id())) return false
  await $.fs.write(file, '')
  return true
}

export const registerTour: Register = on => {
  // the person's /thimble:tour starts it, or the one thimble runs after an install: the intro stands under its row
  on('prompt.submit', { origin: { kind: /^(?:composer|bridge|plugin)$/ } }, async ($, e, next) => {
    const r = await next(e)
    if (e.command && TOUR_SKILL.test(String(e.command.name ?? ''))) await tourStart($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // Claude starts the skill with the Skill tool: the tour starts, and the skill runs as written
  on('tool.call', { tool: 'Skill', skill: TOUR_SKILL }, async ($, e, next) => {
    const skill = String((e as { skill?: unknown }).skill ?? '')
    if (e.agentId === undefined && TOUR_SKILL.test(skill)) await tourStart($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // the skill expanded some other way (the first prompt of `thimble tour`): the tour starts too
  on('skill.prompt', { skill: TOUR_SKILL }, async ($, e, next) => {
    const r = await next(e)
    await tourStart($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: /^[\s\S]*$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      if (await tourRuns($)) await turnEnded($, e.turnId ? await turnOf($, e.turnId) : null)
    } catch {
      // the turn ends whatever the tour makes of it
    }
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const p = (e as Any).props
    if (p?.plugin !== 'thimble' || !String(p?.id ?? '').startsWith('tour-')) return next(e)
    try {
      return await drawRow($, e)
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // thimble loads in the session that installed it: the tour starts by itself, once
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.isInteractive !== false && (await startsAfterInstall($))) {
        $.clock.after(500, () => { void Promise.resolve($.command.run({ command: 'thimble:tour' })).catch(() => undefined) })
      }
    } catch {
      // the session starts whatever the tour makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}
