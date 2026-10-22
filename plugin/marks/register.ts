// register.ts: marks. Claude marks the claims of its reply as markdown links to `#` (`[352](#) of the [410](#) refund
// requests`); after each reply one checker fork verifies each mark with evidence, and a deterministic validator checks
// that evidence (checker.ts). The reply is drawn with its marks (view.ts): purple underline, a turning glyph while
// checking, corrected words in place, red with × on failure, and a footer under the reply while it is checked or when
// marks failed. A click on a mark opens its evidence in the side pane (evidence.tsx, core/pane.ts kind `evidence`).
//
// Hooks (each with a matcher of its own: one hooks module holds every module's hooks):
//   session.start    the marks a resumed session's replies hold, as their check left them (store.ts)
//   session.append   main's text rows, as they are stored
//   turn.complete    main's turn ended: start the check (inside this hook, so the fork's events reach the others)
//   turn.complete    the checker's turn ended: validate, write the statuses, tell main
//   tool.call        the checker's calls: Read, Grep, Glob and Bash only
//   ui.render        AssistantMessage: a text block with marks, drawn here; with marks switched off, its words alone
import type { Register } from 'claude-code'

import { SPIN } from '../bar/busy'
import { forkOf } from '../core/forks'
import { openPane } from '../core/pane'
import { featureOn } from '../settings/features.mjs'
import { allowedTool, DENIED, endCheck, noteRow, startCheck } from './checker'
import { marksIn, withoutMarks } from './message.js'
import { restoreMarks, rowMarks } from './store'
import { footerEl, messageEl, type MarkLook } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BUSY = { plugin: 'thimble', key: 'busy' } as const

// main's turn runs: its marks are not yet in the store, and draw as pending. A mark with no record after that (marks
// were off, or the reply is older than thimble) draws unchecked.
let turnRuns = false

export const registerMarks: Register = on => {
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreMarks($) } catch { /* the marks of earlier replies draw unchecked */ }
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

  on('turn.start', { turnId: /./ }, async ($, e, next) => {
    if (e.agentId === undefined) turnRuns = true
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: /^(answer|aborted|refusal|error)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      turnRuns = false
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

  on('tool.call', { agentId: /./ }, async ($, e, next) => {
    if (forkOf(e.agentId)?.kind === 'checker' && !allowedTool(String(e.tool))) return { deny: DENIED }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : forkOf(e.agentId)?.kind === 'checker' && !allowedTool(String(e.tool)) ? { deny: DENIED } : next(e)))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const text = String(e.props.text ?? '')
    const marks = marksIn(text)
    const reply = await rowMarks($, e.requestId)
    if (!marks.length && !reply?.last) return next(e)
    if (!featureOn('marks')) return marks.length ? next({ ...e, props: { ...e.props, text: withoutMarks(text) } }) : next(e)
    const els = $.ui.resolve(e) as Any
    // the turning glyph follows the bar's busy line, which ticks while `checking marks` runs
    const frame = reply?.checking ? Number(((await $.state.get(BUSY)).value as { frame?: number } | null)?.frame ?? 0) : 0
    const spin = SPIN[frame % SPIN.length]!
    const looks: MarkLook[] = marks.map((_m: Any, k: number) => {
      const it = reply?.items[k]
      return it ? { n: it.n, status: it.status, shown: it.shown } : { n: k + 1, status: turnRuns ? 'pending' : 'unchecked' }
    })
    const body = marks.length
      ? messageEl(els, {
        text, marks, looks, key: `mk-${e.requestId}`, cols: Math.max(20, (e.viewport?.columns ?? 100) - 3), first: !!e.props.isFirstOfReply, spin,
        onMark: (k: number) => openPane($, 'evidence', { row: e.requestId, n: looks[k]!.n }, `mark ${looks[k]!.n}`),
      })
      : await next(e)
    const foot = reply?.last ? footerEl(els, {
      key: `mf-${e.requestId}`, spin, checking: reply.checking ? reply.total : 0, failed: reply.failed, unchecked: reply.unchecked,
    }) : null
    return foot ? els.Box({ flexDirection: 'column', children: [body, foot] }) : body
  })
}
