// register.ts: marks. Claude marks the claims of its reply as markdown links to `#` (`[352](#) of the [410](#) refund
// requests`); after each reply one checker fork verifies each mark with evidence, and a deterministic validator checks
// that evidence (checker.ts). The reply is drawn with its marks (view.ts): purple underline, a turning glyph while
// checking, corrected words in place, red with × when wrong, ? when the check could not confirm it, a note under the
// block whose words the check found false, and a footer under the reply while it is checked or when the check changed
// or flagged marks. A click on a mark opens its evidence in the side pane (evidence.tsx, core/pane.ts kind `evidence`).
//
// Hooks (each with a matcher of its own: one hooks module holds every module's hooks):
//   session.start    the marks a resumed session's replies hold, as their check left them (store.ts); the checks a
//                    reload of the plugin left running (checker.ts resumeChecks)
//   session.append   main's text rows, as they are stored
//   turn.complete    main's turn ended: start the check (inside this hook, so the fork's events reach the others)
//   turn.complete    the checker's turn ended: validate, write the statuses
//   tool.call        the checker's calls: Read, Grep, Glob, and Bash for one Python script
//   ui.render        AssistantMessage: a text block with marks, drawn here; with marks switched off, its words alone
import type { Register } from 'claude-code'

import { SPIN } from '../bar/busy'
import { forkOf } from '../core/forks'
import { openPane } from '../core/pane'
import { mainRuns } from '../core/turn'
import { featureOn } from '../settings/features.mjs'
import { checkerDenial, endCheck, noteRow, resumeChecks, startCheck } from './checker'
import { marksIn, withoutMarks } from './message.js'
import { notesByMark, restoreMarks, rowMarks } from './store'
import { footerEl, messageEl, type MarkLook } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BUSY = { plugin: 'thimble', key: 'busy' } as const

/** Why the checker may not make this call, or null (main's calls and other agents' are not this module's). */
const denial = (e: { agentId?: string; tool: unknown }) => (forkOf(e.agentId)?.kind === 'checker' ? checkerDenial(e as never) : null)

export const registerMarks: Register = on => {
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreMarks($) } catch { /* the marks of earlier replies draw unchecked */ }
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

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const text = String(e.props.text ?? '')
    const marks = marksIn(text)
    const reply = await rowMarks($, e.requestId)
    if (!marks.length && !reply?.last) return next(e)
    if (!featureOn('marks')) return marks.length ? next({ ...e, props: { ...e.props, text: withoutMarks(text) } }) : next(e)
    const els = $.ui.resolve(e) as Any
    // the turning glyph follows the bar's busy line, which ticks while `checking N marks` runs
    const frame = reply?.checking ? Number(((await $.state.get(BUSY)).value as { frame?: number } | null)?.frame ?? 0) : 0
    const spin = SPIN[frame % SPIN.length]!
    const runs = await mainRuns($)
    const looks: MarkLook[] = marks.map((_m: Any, k: number) => {
      const it = reply?.items[k]
      return it ? { n: it.n, status: it.status === 'failed' && it.failedBy === 'evidence' ? 'unconfirmed' : it.status, shown: it.shown } : { n: k + 1, status: runs ? 'pending' : 'unchecked' }
    })
    const body = marks.length
      ? messageEl(els, {
        text, marks, looks, key: `mk-${e.requestId}`, cols: Math.max(20, (e.viewport?.columns ?? 100) - 3), first: !!e.props.isFirstOfReply, spin,
        notes: notesByMark(reply?.items ?? []),
        onMark: (k: number) => openPane($, 'evidence', { row: e.requestId, n: looks[k]!.n }, `mark ${looks[k]!.n}`),
      })
      : await next(e)
    const foot = reply?.last ? footerEl(els, {
      key: `mf-${e.requestId}`, spin, checking: reply.checking ? reply.total : 0, wrong: reply.wrong, unconfirmed: reply.unconfirmed, corrected: reply.corrected, unchecked: reply.unchecked,
    }) : null
    return foot ? els.Box({ flexDirection: 'column', children: [body, foot] }) : body
  })
}
