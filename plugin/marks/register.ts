// register.ts: marks. Claude marks the claims of its reply as markdown links to `#` (`[352](#) of the [410](#) refund
// requests`); after each reply one checker fork verifies each mark with evidence, and a deterministic validator checks
// that evidence (checker.ts). The reply is drawn with its marks (view.ts): purple underline, a turning glyph while
// checking, corrected words in place (purple, as a verified one), the warning color with ? when the check could not
// confirm it or did not run (failed), a note under the block whose words the check found false, and a footer under the reply while it is
// checked. A click on a mark opens its evidence in the side pane (evidence.tsx, core/pane.ts kind `evidence`).
//
// Hooks (each with a matcher of its own: one hooks module holds every module's hooks):
//   session.start    the marks a resumed session's replies hold, as their check left them (store.ts); the checks a
//                    reload of the plugin left running (checker.ts resumeChecks)
//   session.append   main's text rows, as they are stored
//   turn.complete    main's turn ended: start the check (inside this hook, so the fork's events reach the others)
//   turn.complete    the checker's turn ended: validate, write the statuses
//   tool.call        the checker's calls: Read, Grep, Glob, and Bash for one Python script
//   agent.spawn      a repair's fork (x in the tray): waits out the key's word window, refused when a word came
//   ui.render        AssistantMessage: a text block with marks, drawn here; with marks switched off, its words alone.
//                    The features that act on answers draw here too (core/answerview.ts): the text a row shows in
//                    place of Claude's (a squeezed version), their spans on its words (explainers, heads-ups), the
//                    citation the tray shows, the lines under its words (the labels it used), a press on a citation,
//                    and the margin of each passage it draws, which asks a side thread about it
import type { EngineInterface, Register } from 'claude-code'

import { SPIN } from '../bar/busy'
import { markFocus, markPressed, passagesFor, rowDrawing, spansFor, textView, underText } from '../core/answerview'
import { forkOf } from '../core/forks'
import { askOnce, type Below } from '../core/rowhook'
import { openPane } from '../core/pane'
import { mainRuns } from '../core/turn'
import { featureOn } from '../settings/features.mjs'
import { awaitsCheck, checkerDenial, endCheck, heldRepair, noteRow, REPAIR_DESCRIPTION, resumeChecks, startCheck } from './checker'
import { marksIn, withoutMarks } from './message.js'
import { restoreMarks, rowMarks, type MarkItem } from './store'
import { footerEl, messageEl, type MarkLook } from './view'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BUSY = { plugin: 'thimble', key: 'busy' } as const

/** The looks of the marks of a text a row shows in place of Claude's words (a squeezed version): each mark that has the
 *  words of one of the row's checked marks looks as that one does, and opens its evidence; any other is words no check
 *  is for (view.ts `unchecked`). */
export function looksByWords(marks: { words: string }[], items: MarkItem[], runs: boolean): MarkLook[] {
  const norm = (w: string) => w.replace(/\s+/g, ' ').trim().toLowerCase()
  const free = [...items]
  return marks.map(m => {
    const k = free.findIndex(it => norm(it.words) === norm(m.words))
    if (k < 0) return { n: 0, status: runs ? 'pending' : 'unchecked' }
    const it = free.splice(k, 1)[0]!
    return { n: it.n, status: it.status, shown: it.shown, ...(it.narrowed ? { narrowed: true } : {}) }
  })
}

/** Why the checker may not make this call, or null (main's calls and other agents' are not this module's). */
const denial = (e: { agentId?: string; tool: unknown }) => (forkOf(e.agentId)?.kind === 'checker' ? checkerDenial(e as never) : null)

export const registerMarks: Register = on => {
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreMarks($) } catch { /* the marks of earlier replies draw failed: their check did not run */ }
    try { await resumeChecks($) } catch { /* the checks that run end as they would */ }
    return r
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      const msg = e.message as { type?: string; content?: unknown }
      const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
      const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n')
      const row = String(stored.uuid || e.uuid || '')
      if (e.agentId === undefined && msg.type === 'assistant' && row && text.trim()) await noteRow($, row, text)
    } catch {
      // the row is stored whatever the marks make of it
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: /^(answer|aborted|refusal|error)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      try { await startCheck($, e) } catch { /* the reply stands; its marks stay drawn as written */ }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    const r = await next(e)
    if (forkOf(e.agentId)?.kind === 'checker') {
      try { await endCheck($, { agentId: e.agentId!, reason: e.reason, answer: e.answer, usage: e.usage }) } catch { /* endCheck says its own failures */ }
    }
    return r
  }).catch(($, e, next) => next(e))

  // fails closed: a guard that throws before `next` refuses the checker's call in its place
  on('tool.call', { agentId: /./ }, async ($, e, next) => {
    const no = denial(e)
    return no ? { deny: no } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const no = denial(e)
    return no ? { deny: no } : next(e)
  })

  // x's repair waits out the word window, and is refused when a letter came in it (hooks/keys.ts undoes x)
  on('agent.spawn', { description: REPAIR_DESCRIPTION }, async ($, e, next) => {
    const h = heldRepair()
    if (next.origin.plugin !== 'thimble' || !h) return next(e)
    const left = h.until - Number(await $.clock.now())
    if (left > 0) await $.clock.sleep(left)
    if (h.cancelled) return { deny: 'the person typed a word that starts with x' }
    return next(e)
  }).catch(($, e, next) => next(e))

  // fails safe (core/rowhook.ts): a throw here answers the drawing beneath, which the hooks around this one draw on
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const below = askOnce(e, next)
    try {
      return await drawAnswer($, e, below)
    } catch {
      return below()
    }
  }).catch(($, e, next) => next(e))
}

/** A row of Claude's words as marks/register.ts draws it: hidden (a catch-up covers it), a catch-up in its place, its
 *  marks, spans and lines under it, or the drawing beneath (`below`) when it has none of these. */
async function drawAnswer($: Engine, e: Any, below: Below): Promise<Any> {
  if (e.props.isSummary) return below()
  const row = e.requestId
  const raw = String(e.props.text ?? '')
  const cols = Math.max(20, (e.viewport?.columns ?? 100) - 3)
  // the text this row shows (a squeezed version in place of Claude's words), or nothing (a catch-up covers it)
  const view = await textView($, row, raw)
  const els = $.ui.resolve(e) as Any
  if (view.hidden) return els.Box({ key: `ans-${row}`, flexDirection: 'column', children: [] })
  // a row a feature draws whole (a catch-up in the newest reply's place), with the lines under its words
  const whole = await rowDrawing($, els, row, cols)
  if (whole) {
    const under = await underText($, els, row, cols)
    return els.Box({ key: `ans-${row}`, flexDirection: 'column', children: [whole, ...under] })
  }
  const marksOn = featureOn('marks')
  const text = marksOn ? view.text : withoutMarks(view.text)
  const marks = marksOn ? marksIn(text) : []
  const reply = marksOn ? await rowMarks($, row) : null
  const spans = await spansFor($, row, text, marks)
  const under = await underText($, els, row, cols)
  const own = text === raw
  if (!marks.length && !reply?.last && !spans.length && !view.dim && !view.lead && !under.length) {
    return own ? below() : below({ ...e, props: { ...e.props, text } })
  }
  // the turning glyph follows the bar's busy line, which ticks while `checking N marks` runs
  const frame = reply?.checking ? Number(((await $.state.get(BUSY)).value as { frame?: number } | null)?.frame ?? 0) : 0
  const spin = SPIN[frame % SPIN.length]!
  const runs = await mainRuns($)
  // a mark of Claude's own words with no check in the store: pending while its turn runs or its check starts, else
  // failed, since its check did not run (the tray has no record of it to check)
  const waits = runs || (!reply && (await awaitsCheck($, row)))
  // the marks of Claude's own words by their place; those of a text shown in their place by their words
  const looks: MarkLook[] = own
    ? marks.map((_m: Any, k: number) => {
      const it = reply?.items[k]
      return it ? { n: it.n, status: it.status, shown: it.shown, ...(it.narrowed ? { narrowed: true } : {}) } : { n: k + 1, status: waits ? 'pending' : 'failed' }
    })
    : looksByWords(marks, reply?.items ?? [], runs)
  const focusN = await markFocus($, row)
  const focus = focusN != null ? looks.findIndex(l => l.n === focusN) : -1
  const body = marks.length || spans.length || view.dim || view.lead
    ? messageEl(els, {
      text, marks, looks, key: `mk-${row}`, cols, first: !!e.props.isFirstOfReply, spin,
      spans, dim: view.dim, lead: view.lead, focus: focus >= 0 ? focus : null,
      // while a rewrite of it runs, no passage is asked about
      passages: view.dim ? null : await passagesFor($, row),
      onMark: async (k: number) => {
        const n = looks[k]!.n
        if (await markPressed($, row, n)) return
        if (n > 0) await openPane($, 'evidence', { row, n }, `citation ${n}`)
      },
    })
    : await (own ? below() : below({ ...e, props: { ...e.props, text } }))
  const foot = reply?.last ? footerEl(els, { key: `mf-${row}`, spin, checking: reply.checking }) : null
  const parts = [body, ...(foot ? [foot] : []), ...under]
  return parts.length === 1 ? body : els.Box({ key: `ans-${row}`, flexDirection: 'column', children: parts })
}
