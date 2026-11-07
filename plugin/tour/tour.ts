// tour.ts: the feature tour that /thimble:tour starts (skills/tour/SKILL.md). Claude writes one thing: step 0, a fixed
// answer about the sample data (tour/sample/), with one number wrong on purpose. thimble draws every other word of the
// tour itself, in two rows it places in the transcript ($.ui.place, drawn at ui.render for `Placed`). The model never
// reads them, and the tour sends Claude no prompt.
//
//   the intro    placed once the prompt that starts the tour stands in the transcript, so it stands between that
//                prompt and the sample answer: what thimble does, and what comes
//   the step row drawn by the sample answer itself, at the end of its drawing: under its words, and under the cards and
//                the simpler version drawn under it (core/answerview.ts). It shows the tour's progress, the steps done,
//                and the one action that waits, and draws again as each step is done. When the person's own prompt
//                gets an answer meanwhile, the row is placed under that answer ($.ui.place), and the sample answer
//                draws it no more. Each placed row has an id of its own; an earlier one draws nothing
//
// A tour started again keeps the rows of the earlier one: they draw its steps as they were.
//
// A step is done at the moment it shows its result:
//
//   answer    main's turn that the skill started ends with an answer: the sample answer
//   e         the explainer of the selected words shows in the tray (explain/seam.ts). The step names the words in
//             bold; the answer marks nothing for it
//   v         the first card that v's designer draws is on the screen (designer/v.ts). A design that ends with no
//             card counts too (tourMissed), so the tour goes on
//   ask       the first answer of a side thread about a card shows (threads/thread.ts). The step asks about the card v
//             drew: a click on `ask` in the card's header, or ] to the card and a (cards/head.ts)
//   s         the first text of the simpler version shows (squeeze/term.ts)
//   cite      the marked citation, the wrong number, opens in the tray with its check (tray/tray.ts tourOpened). By
//             then the checker has corrected it, so the tray shows the old value and the check. A click on it in the
//             simpler version opens the same citation of the sample answer, so it counts too. Where no click reaches
//             thimble, ] opens it
//
// The citation comes last: by then the card, the side thread and the simpler version may have moved the answer off the
// screen, so the step says to scroll up to it. The step that waits is the first one not done whose feature is on: e
// needs a selection, which only a click reaches (bar/intro.ts clicksReach); ask needs a card that v drew (side threads
// have no switch of their own). While cite waits, the sample answer marks the wrong number (tourSpans, drawn by
// core/answerview.ts).
//
// While the tour runs after the sample answer, main's turns answer nothing for thimble's features (core/answers.ts
// holdAnswers). So v, e, ], s and the observer act on the sample answer, not on a reply to the person's own prompt. A
// side thread's fork is no turn of main's: it answers, and its end does not move the step row. The
// observer does not look at the sample answer itself (tourSample): Claude wrote it without reading the data, on
// purpose, and the checker checks its numbers. A /clear or a /resume ends the tour (hooks/turnover.ts). Where
// thimble's drawing does not show (core/host.ts), no tour runs.
//
// After an install inside Claude Code, the installer writes the session's id and the time to $THIMBLE_HOME/tour-next.
// The person's /reload-plugins then runs /thimble:tour once: thimble loads in that session (session.start), or it was
// loaded already and hears the command end. A file older than NEXT_MS starts nothing, so a session resumed later does
// not start the tour.
//
//   tourStart($)          the skill started: step 0 waits
//   tourDid($, step)      a step done: `answer`, `e`, `v`, `ask`, `s` or `cite`
//   tourMissed($, step)   a step that the person did but that did not work (v drew no card): the tour goes on
//   tourOpened($, row, n) citation n of a row opened in the tray: the cite step done when it is the marked one
//   tourRuns($)           whether a tour runs (bar/hints.ts gives no reminder meanwhile)
//   tourSample($, row)    whether a row is the tour's sample answer, or the answer of the turn that writes it now
//   tourSpans($, row, t)  the mark on the wrong number in the sample answer while cite waits
//   tourUnder($, e)       the step row at the end of an answer's drawing, when the answer is a tour's sample answer
//   turnTour($)           a /clear or a /resume: the tour ends
//   registerTour          the start, the intro, the end of main's turn, the placed rows, and the start after an install
//
//   state: tour (TourState, or null), tourPast (the tours started before it, as they were), tourSample (the row of the
//          sample answer, kept after the tour ends)
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
export type Step = 'answer' | 'e' | 'v' | 'ask' | 's' | 'cite'
export const STEPS: Step[] = ['answer', 'e', 'v', 'ask', 's', 'cite']

/** The tour: the step that waits (`end` once all are done), the steps done, those that did not work, when it started,
 *  and the row of its sample answer (null until Claude ends it). Its placed rows: the intro (null until placed) and the
 *  step row placed under a later reply (null while the sample answer draws it). `k` counts the rows placed, so each
 *  has an id of its own. */
export type TourState = {
  at: Step | 'end'; done: Step[]; missed: Step[]; startedAt: number; k: number
  intro: string | null; sample: string | null; moved: string | null
}
export type Tour = TourState & { at: Step }

/** The skill, as Claude Code names it (with the plugin's name, or without). */
export const TOUR_SKILL = /^(?:thimble:)?tour$/

/** The file in thimble's home that an install inside Claude Code writes the session's id and the time to
 *  (scripts/install.sh). */
export const NEXT_FILE = 'tour-next'

/** How long after the install the file starts the tour. Later, it starts nothing (a session resumed another day). */
export const NEXT_MS = 15 * 60_000

/** A start this soon after the last one is the same start: the command, the skill and the Skill call each start it. */
const SAME_START_MS = 10_000

const TOUR = { plugin: 'thimble', key: 'tour' } as const
const PAST = { plugin: 'thimble', key: 'tourPast' } as const
const SAMPLE = { plugin: 'thimble', key: 'tourSample' } as const

/** What the intro says. */
export const INTRO = [
  "thimble works on Claude's answers: it checks numbers, draws cards, explains words, simplifies, and answers side questions.",
  'Below, Claude writes an answer about the made-up orders of a tea shop. One number in it is wrong on purpose.',
]

/** What the end says. Where no click reaches thimble, the settings are named by their command alone. */
export const END = (clicks: boolean): string[] => [
  'The tour is over.',
  clicks ? "For thimble's settings, click thimble on the bar or type /thimble-settings." : "For thimble's settings, type /thimble-settings.",
  'Type /thimble:tour to take the tour again.',
]

/** The words of the sample answer that step e names. */
export const E_WORDS = 'average order value'

/** One step's action while it waits: its words, with each key as `{k}` and words drawn bold as `**words**`. v and s
 *  name the answer they act on, since the row can stand under a reply to the person's own prompt. */
export function stepAction(s: Step, clicks: boolean): string {
  if (s === 'e') return `Select **${E_WORDS}** in the answer with the mouse, then press {e}.`
  if (s === 'v') return 'Press {v} to draw a card of the tea shop answer.'
  if (s === 'ask') return clicks
    ? 'Click ask at the top right of the card, type a question about it, and press Enter.'
    : 'Press {]} until it reaches the card, press {a}, type a question about it, and press Enter.'
  if (s === 's') return 'Press {s} for a shorter, plainer version of the tea shop answer.'
  if (s === 'cite') return clicks
    ? 'One number was wrong on purpose. Scroll up to the tea shop answer and click the highlighted number.'
    : 'One number was wrong on purpose. Press {]} until the tray above the prompt shows the highlighted number.'
  return ''
}

/** One step once done. */
export function stepDone(s: Step, missed: boolean): string {
  if (s === 'e') return 'e explained the words.'
  if (s === 'cite') return "The tray showed thimble's check of the wrong number."
  if (s === 'v') return missed ? 'v drew no card this time.' : 'v drew a card.'
  if (s === 'ask') return 'You asked a side thread about the card.'
  if (s === 's') return 's wrote a simpler version.'
  return ''
}

/** Whether a step's feature is on now. Step e needs a selection, which only a click reaches. Step ask needs the card
 *  that v draws: Cards on, and v not `missed` (it drew no card). Side threads have no switch of their own. */
function stepOn(s: Step, clicks: boolean, missed: Step[]): boolean {
  if (s === 'answer') return true
  if (s === 'v') return featureOn('cards') === true
  if (s === 'ask') return featureOn('cards') === true && !missed.includes('v')
  if (s === 'e') return clicks && featureOn('explain') === true
  if (s === 'cite') return featureOn('cite') === true
  return featureOn('squeezeAnswers') === true
}

/** The step after `from` that the tour asks for next: not done, and on. Null: the end. */
export function nextStep(from: Step, done: Step[], clicks: boolean, missed: Step[] = []): Step | null {
  return STEPS.slice(STEPS.indexOf(from) + 1).find(s => !done.includes(s) && stepOn(s, clicks, missed)) ?? null
}

/** The person's steps the row shows, in order: those whose feature is on, and those done. */
function shownSteps(t: TourState, clicks: boolean): Step[] {
  return STEPS.filter(s => s !== 'answer' && (t.done.includes(s) || stepOn(s, clicks, t.missed)))
}

/** Whether a click and a selection reach thimble, as the last drawing saw the layout. */
async function clicksNow($: Engine): Promise<boolean> {
  return clicksReach($, { surface: 'terminal', viewport: { isFullscreen: fullscreenNow() } }).catch(() => true)
}

function parse(x: unknown): TourState | null {
  const t = x as Any
  if (!t || typeof t !== 'object' || !(STEPS.includes(t.at as Step) || t.at === 'end')) return null
  const id = (v: unknown) => (v ? String(v) : null)
  return {
    at: t.at, done: Array.isArray(t.done) ? t.done : [], missed: Array.isArray(t.missed) ? t.missed : [],
    startedAt: Number(t.startedAt) || 0, k: Number(t.k) || 0, intro: id(t.intro), sample: id(t.sample), moved: id(t.moved),
  }
}

async function stateNow($: Engine): Promise<TourState | null> {
  return parse((await $.state.get(TOUR)).value)
}

/** The tours started before this one, as they were when the next one started: their rows still draw them. */
async function pastNow($: Engine): Promise<TourState[]> {
  const v = (await $.state.get(PAST)).value
  return Array.isArray(v) ? v.map(parse).filter((t): t is TourState => !!t) : []
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

/** The skill started: step 0 waits, whatever an earlier tour had done. The earlier tour is kept as it was, so its rows
 *  still draw it. A second start a few seconds later is the same start. Where thimble's drawing does not show (claude
 *  -p, the desktop app: core/host.ts), no step can be done, so no tour runs. The intro is placed apart (placeIntro),
 *  once the prompt that starts the tour stands in the transcript. */
export function tourStart($: Engine): Promise<void> {
  return inTurn(async () => {
    if (!drawsHere()) return
    const now = Number(await $.clock.now()) || 0
    const was = await stateNow($)
    if (was?.at === 'answer' && now - was.startedAt < SAME_START_MS) return
    const past = await pastNow($)
    if (was && (was.intro || was.sample)) await $.state.set(PAST, [...past, was] as never)
    const k = Math.max(was?.k ?? 0, ...past.map(p => p.k))
    await save($, { at: 'answer', done: [], missed: [], startedAt: now, k, intro: null, sample: null, moved: null })
  })
}

/** The intro, placed at the transcript's end while the tour waits for its sample answer, once. Called where the
 *  prompt that starts the tour already stands in the transcript: main's turn starts, the prompt entered, Claude's Skill
 *  call. */
export function placeIntro($: Engine): Promise<void> {
  return inTurn(async () => {
    const t = await tourNow($)
    if (!t || t.at !== 'answer' || t.intro) return
    const k = t.k + 1
    const intro = `tour-intro-${k}`
    await save($, { ...t, k, intro })
    await place($, intro)
  })
}

/** The step that waits goes on to the next one, or to the end. The step row draws again from the state. */
async function goOn($: Engine, t: Tour, done: Step[], missed: Step[]): Promise<void> {
  const next = nextStep(t.at, done, await clicksNow($), missed)
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

/** Main's turn ended while the tour runs. The turn that the skill started, with an answer: step 0 done, and the sample
 *  answer draws the step row under it. A later turn (the answer to the person's own prompt): the step row is placed
 *  under it. A step that waits while its feature is off goes on, since the person cannot do it. */
async function turnEnded($: Engine, turn: TurnRec | null): Promise<void> {
  await inTurn(async () => {
    const t = await tourNow($)
    if (!t) return
    if (t.at === 'answer') {
      // core/answers.ts records the turn's answer before this hook hears the end
      if (!turn?.answer) return
      await $.state.set(SAMPLE, turn.answer)
      await goOn($, { ...t, sample: turn.answer, moved: null }, [...t.done, 'answer'], t.missed)
      return
    }
    const k = t.k + 1
    const moved = { ...t, k, moved: `tour-step-${k}` }
    if (stepOn(t.at, await clicksNow($), t.missed)) await save($, moved)
    else await goOn($, moved, t.done, t.missed)
    await place($, moved.moved)
  })
}

export async function turnTour($: Engine): Promise<void> {
  await save($, null)
}

// ------------------------------------------------------------------------------------------------ the marks

/** The words the step that waits acts on, in the sample answer's text: the citation of the refunds to open for cite.
 *  [start, end) in `text`; null when the step marks no words (e names its words instead) or they are not there. */
export function markedWords(step: Step, text: string): { start: number; end: number } | null {
  if (step === 'cite') {
    const m = /refunded (\[[^\]\n]+\]\(#\))/.exec(text)
    return m ? { start: m.index + 'refunded '.length, end: m.index + m[0].length } : null
  }
  return null
}

/** The mark on the wrong number in the sample answer while cite waits: a fill in thimble's purple, the words bold. A
 *  citation keeps its own press, so the mark has none. */
export async function tourSpans($: Engine, row: string, text: string): Promise<Span[]> {
  const t = await tourNow($)
  if (!t || t.at !== 'cite') return []
  if ((await $.state.get(SAMPLE)).value !== row) return []
  const at = markedWords(t.at, text)
  if (!at) return []
  const fill = (await themeNow($)) === 'light' ? '#dcc8ff' : '#4b2d80'
  return [{ id: `tour-${t.at}`, ...at, look: { backgroundColor: fill, bold: true }, label: 'the tour: click this number' }]
}

// ------------------------------------------------------------------------------------------------ the rows

/** A line of words with each `{k}` drawn as a key, in thimble's color, and each `**words**` drawn bold. */
function withKeys(els: Any, text: string, key: string, look: Any = {}): Any {
  // split keeps both groups of each match: a part's place mod 3 says what it is (words, a key, bold words)
  const parts = text.split(/\{([^}]+)\}|\*\*([^*]+)\*\*/)
  const children = parts.flatMap((p, i) => {
    if (!p) return []
    if (i % 3 === 1) return [els.Text({ key: `k${i}`, color: accent(), bold: true, children: p })]
    if (i % 3 === 2) return [els.Text({ key: `b${i}`, bold: true, children: p })]
    return [p]
  })
  return els.Text({ key, ...look, children })
}

/** The frame of the rows: a border in thimble's color, a bold title, a blank row, then the lines. As wide as a card's
 *  frame (cards/draw.ts): the screen's columns less 4, and 2 in from the left. */
function frame(els: Any, key: string, cols: number, title: string, lines: Any[], look: Any = {}): Any {
  return els.Box({
    key, flexDirection: 'column', borderStyle: 'round', borderColor: accent(), paddingX: 1, marginLeft: 2,
    width: Math.max(30, cols - 4), ...look,
    children: [els.Text({ key: 'title', bold: true, color: accent(), children: title }), els.Text({ key: 'gap', children: ' ' }), ...lines],
  })
}

export function introEl(els: Any, cols: number): Any {
  return frame(els, 'tour-intro', cols, 'thimble tour', INTRO.map((l, i) => els.Text({ key: `l${i}`, children: l })))
}

/** The step row of a tour. `past`: a tour that a later one replaced, drawn as it was, with no action. */
export function stepRowEl(els: Any, t: TourState, clicks: boolean, cols: number, past = false, look: Any = {}): Any {
  const steps = shownSteps(t, clicks)
  const title = t.at === 'end' ? 'thimble tour · done'
    : past ? 'thimble tour · started again below'
      : `thimble tour · ${steps.indexOf(t.at as Step) + 1} of ${steps.length}`
  const lines: Any[] = []
  for (const s of steps) {
    if (t.done.includes(s)) lines.push(els.Text({ key: `d-${s}`, dimColor: true, children: `✓ ${stepDone(s, t.missed.includes(s))}` }))
    else if (s === t.at && !past) lines.push(withKeys(els, `› ${stepAction(s, clicks)}`, `a-${s}`))
  }
  if (t.at === 'end') lines.push(...(lines.length ? [els.Text({ key: 'gap2', children: ' ' })] : []), ...END(clicks).map((l, i) => els.Text({ key: `e${i}`, children: l })))
  return frame(els, `tour-row-${t.startedAt}-${t.moved ?? 'under'}`, cols, title, lines, look)
}

const colsOf = (e: Any): number => Math.max(34, Number(e.viewport?.columns ?? 100))

/** The step row at the end of an answer's drawing (core/answerview.ts), when the answer is the sample answer of this
 *  tour or of an earlier one, and no reply since has the row. Null for any other answer. */
export async function tourUnder($: Engine, e: Any): Promise<Any | null> {
  const row = String(e.requestId ?? '')
  if (!row) return null
  const t = await stateNow($)
  const past = t?.sample === row ? null : (await pastNow($)).find(p => p.sample === row)
  const of = t?.sample === row ? t : past
  if (!of || of.moved) return null
  return stepRowEl($.ui.resolve(e) as Any, of, await clicksReach($, e).catch(() => true), colsOf(e), !!past, { marginTop: 1 })
}

/** A placed row of the tour's: an intro, the step row placed under a reply, or nothing (a step row placed again
 *  further down). */
async function drawRow($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const id = String(e.props?.id ?? '')
  if (id.startsWith('tour-intro-')) return introEl(els, colsOf(e))
  const t = await stateNow($)
  const past = t?.moved === id ? null : (await pastNow($)).find(p => p.moved === id)
  const of = t?.moved === id ? t : past
  if (of) return stepRowEl(els, of, await clicksReach($, e).catch(() => true), colsOf(e), !!past)
  return els.Box({ key: `tour-none-${id}`, children: [] })
}

// ------------------------------------------------------------------------------------------------ the start after an install

/** Whether $THIMBLE_HOME/tour-next names this session, written in the last NEXT_MS: the person's /reload-plugins after
 *  an install in this session. A file that names this session is emptied, so the tour starts once. */
async function startsAfterInstall($: Engine): Promise<boolean> {
  const file = `${await thimbleHome($)}/${NEXT_FILE}`
  let text = ''
  try { text = String(await $.fs.read(file)).trim() } catch { return false }
  const [named, at] = text.split(/\s+/)
  if (!named || named !== String(await $.session.id())) return false
  await $.fs.write(file, '')
  return Number(await $.clock.now()) - Number(at) * 1000 < NEXT_MS
}

/** Runs /thimble:tour as if the person typed it, once Claude Code is done loading. */
function startAfterInstall($: Engine): void {
  $.clock.after(500, () => { void Promise.resolve($.command.run({ command: 'thimble:tour' })).catch(() => undefined) })
}

export const registerTour: Register = on => {
  // /thimble:tour: the tour starts, and the intro stands under its prompt
  on('prompt.submit', { origin: { kind: /./ } }, async ($, e, next) => {
    const r = await next(e)
    if (e.command && TOUR_SKILL.test(String(e.command.name ?? ''))) {
      await tourStart($).catch(() => undefined)
      await placeIntro($).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Claude starts the skill with the Skill tool: the tour starts, and the skill runs as written
  on('tool.call', { tool: 'Skill', skill: TOUR_SKILL }, async ($, e, next) => {
    const skill = String((e as { skill?: unknown }).skill ?? '')
    if (e.agentId === undefined && TOUR_SKILL.test(skill)) {
      await tourStart($).catch(() => undefined)
      await placeIntro($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the skill expanded some other way (the first prompt of `thimble tour`): the tour starts too. The prompt is not in
  // the transcript yet, so the intro waits for main's turn to start
  on('skill.prompt', { skill: TOUR_SKILL }, async ($, e, next) => {
    const r = await next(e)
    await tourStart($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await placeIntro($).catch(() => undefined)
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
      if (e.isInteractive !== false && (await startsAfterInstall($))) startAfterInstall($)
    } catch {
      // the session starts whatever the tour makes of it
    }
    return r
  }).catch(($, e, next) => next(e))

  // thimble was loaded already when the install ran (a reinstall, an update): the person's /reload-plugins starts it
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (await startsAfterInstall($)) startAfterInstall($)
    } catch {
      // the reload ends whatever the tour makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}
