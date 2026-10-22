// pane.tsx: the side threads in the side pane, drawn with Claude Code's own elements (0.10's panes/threads.js,
// panes/subject.js, shell/conversation.ts and the input bar of shell/detail.tsx, which ran on the card toolkit).
//
//   the list (kind `threads`)    t, a click on the bar's `N threads`, /threads. As 0.9 drew it: a tree with main at its
//                                root and a row per thread, `main/<what it is on>`, the newest first, with how many
//                                questions it has (or that it is answering) and its last question under it. A row is a
//                                press (tab walks the rows, ↵ presses): it opens that thread
//   a thread (kind `thread`)     what it is on at the top (a card, drawn; an explainer's or a passage's words; else
//                                its name), its conversation under it, the input bar at the bottom
//   under a pane (threadUnder)   a citation's evidence, a label, coverage, the claims: the pane's thread under it, its
//                                conversation and the input bar (core/pane.ts calls it)
//
// The conversation, written and spaced as Claude Code writes main's:
//
//   ── main/Saves per day ─────────────       the thread's name on a dim rule, between what it is on and its turns
//
//   ❯ why so many links?   about Jun 18       each question after ❯ on the prompt's background, with what it is about
//
//   ● 2 steps · python3 count.py              the steps the thread took, on one dim row, without the folders they
//                                             ran in (threads.mjs stepWords)
//
//   ● Links peaked that day: 2,994 of …       the answer after ●
//
//     [a card it drew]
//   m: send this answer to Claude             once it answered: m (or a click) sends the answer to main
//                                             a question at work: the bar says `⠋ answering: <thread>` (bar/busy.ts)
//   ─────────────────────────────────         the input bar: Claude Code's prompt box, a rule above and below,
//   ❯ Ask about Jun 17…              ↵ ask    ❯ and the field between them
//   ─────────────────────────────────
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { frame } from '../cards/draw'
import { metaOf } from '../cards/store'
import { partOf } from '../core/answers'
import { claimsThreadScope } from '../claims/seam'
import { cut, textWidth } from '../core/text.js'
import { marksIn } from '../marks/message.js'
import { rowMarks } from '../marks/store'
import { messageEl } from '../marks/view'
import type { ThreadScope } from './seam'
import { askThread, cardsOfTurn, isSending, listThreads, sendToMain, showThread, takeAskNext, threadList, threadOf, type Thread } from './thread'
import { aboutOf, nameOf, rowsOf, stepWords, threadKey } from './threads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GEN = { plugin: 'thimble', key: 'threadsGen' } as const

// each thread's input bar: a new field (a new key) once a question was asked, so no word of it stays in the field
const fieldGen = new Map<string, number>()

/** The top of every thread, one look for each kind of subject: a quoted block as Claude Code draws a quote, a dim rule
 *  `▎` down its left side, the subject's title on its first row, bold, and one dim row that says what it is. */
function subjectBlock(els: Any, key: string, title: string, line = '', more: string[] = []): Any {
  const { Box, Text } = els
  const rows = [Text({ key: `${key}-t`, wrap: 'truncate-end', children: [Text({ dimColor: true, children: '▎ ' }), Text({ bold: true, children: title })] })]
  if (line) rows.push(Text({ key: `${key}-l`, wrap: 'truncate-end', dimColor: true, children: `▎ ${line}` }))
  more.forEach((m, i) => rows.push(Text({ key: `${key}-m${i}`, wrap: 'wrap', children: [Text({ dimColor: true, children: '▎ ' }), m] })))
  rows.push(Text({ key: `${key}-gap`, children: ' ' }))
  return Box({ key, flexDirection: 'column', children: rows })
}

/** Rows a text takes at `w` columns, about. */
const rowsAt = (s: string, w: number) => String(s).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / Math.max(10, w))), 0)

/** The thread's conversation: its newest turns that fit in about `room` rows, with a dim row on top saying how many
 *  are above them. */
async function conversation($: Engine, e: Any, els: Any, t: Thread, w: number, room: number): Promise<Any[]> {
  const { Box, Button, Text } = els
  const turns = t.turns
  if (!turns.length) return []
  const out: Any[] = []
  const head = ` ${cut(nameOf(t), w - 8)} `
  out.push(Text({ key: 'conv-head', dimColor: true, wrap: 'truncate-end', children: `──${head}${'─'.repeat(Math.max(2, w - textWidth(head) - 2))}` }))
  // the newest turns that fit: an answer with the question before it
  let used = 0
  let from = turns.length
  while (from > 0) {
    const x = turns[from - 1]!
    const h = rowsAt(x.text, w - 2) + 1 + (x.calls?.length ? 2 : 0) + (x.cards?.length ? 8 : 0)
    if (used + h > room && from < turns.length) break
    used += h
    from--
  }
  if (from > 0) out.push(Text({ key: 'conv-above', dimColor: true, wrap: 'truncate-end', children: `  ↑ ${from} earlier turn${from === 1 ? '' : 's'}` }))
  for (let i = from; i < turns.length; i++) {
    const x = turns[i]!
    const k = `conv-t${i}`
    if (x.role === 'person') {
      // the question on the prompt's background, as Claude Code draws the person's prompt; what it is about after it
      out.push(Text({ key: `${k}-gap`, children: ' ' }))
      out.push(Text({ key: `${k}-q`, wrap: 'wrap', children: [
        Text({ backgroundColor: 'userMessageBackground', color: 'text', children: `❯ ${x.text}` }),
        ...(x.about ? [Text({ dimColor: true, children: `   about ${cut(String(x.about), 40)}` })] : []),
      ] }))
      continue
    }
    const calls = x.calls ?? []
    if (calls.length) {
      out.push(Text({ key: `${k}-sgap`, children: ' ' }))
      out.push(Text({ key: `${k}-steps`, dimColor: true, wrap: 'truncate-end', children: `● ${cut(`${calls.length} step${calls.length === 1 ? '' : 's'} · ${stepWords(calls[calls.length - 1], t.root)}`, w - 4)}` }))
    }
    if (x.text) {
      // its citations as Claude wrote them: no checker reads a side thread, so they draw unchecked
      const marks = marksIn(x.text)
      out.push(Box({ key: `${k}-a`, flexDirection: 'column', children: [messageEl(els, {
        text: x.text, marks, looks: marks.map((_m: unknown, j: number) => ({ n: j + 1, status: 'unchecked' as const })), key: `${k}-a`,
        cols: w - 2, first: true, spin: '', onMark: () => undefined,
      })] }))
    }
    // the cards its fork drew while it answered this question
    for (const meta of await cardsOfTurn($, x.cards)) {
      if (t.scope.card === meta.id) out.push(Text({ key: `${k}-c-${meta.id}`, dimColor: true, wrap: 'truncate-end', children: '  ⎿ drew a new version of this card, shown above' }))
      else if (meta.anchorRow !== `thread:${t.key}`) out.push(Text({ key: `${k}-c-${meta.id}`, dimColor: true, wrap: 'truncate-end', children: `  ⎿ drew a new version of “${cut(meta.title, 40)}” in the conversation` }))
      else out.push(Box({ key: `${k}-c-${meta.id}`, marginTop: 1, children: [await frame($, { ...e, viewport: { ...(e?.viewport ?? {}), columns: w + 2 } }, meta)] }))
    }
  }
  if (t.status === 'failed') {
    out.push(Text({ key: 'conv-fail-gap', children: ' ' }))
    out.push(Text({ key: 'conv-fail', color: 'error', wrap: 'wrap', children: `  ⎿ × ${String(t.error || 'the thread stopped')} · ask again` }))
  }
  // m: the last answer to main, once the thread answered
  const answered = t.status === 'done' && turns[turns.length - 1]?.role === 'claude' && !!turns[turns.length - 1]?.text
  if (answered) {
    const sent = (t.sent ?? -1) >= turns.length
    out.push(Text({ key: 'conv-m-gap', children: ' ' }))
    out.push(sent
      ? Text({ key: 'conv-m', dimColor: true, wrap: 'truncate-end', children: '  ✓ sent to Claude: it reads this answer with your next message' })
      // a plain Button draws its key and label itself (`m: send this answer to Claude`); children would draw them twice
      : Button({ key: 'conv-m', plain: true, dimColor: true, hotkey: 'm', label: 'send this answer to Claude', onPress: () => { void sendToMain($, t.key).catch(err => failNotice($, `The answer did not reach Claude: ${String((err as Error)?.message || err).slice(0, 160)}`, 'thread')) } }))
  }
  return out
}

/** The input bar: Claude Code's prompt box in the pane, a blank row, a rule, `❯` and the field, a rule. ↵ asks the
 *  thread about `scope`. */
function entry($: Engine, els: Any, scope: ThreadScope, w: number, focus: boolean): Any[] {
  const { Box, Text, Input } = els
  const key = threadKey(scope)
  const gen = fieldGen.get(key) ?? 0
  const rule = (k: string) => Text({ key: k, color: 'promptBorder', wrap: 'truncate-end', children: '─'.repeat(Math.max(4, w)) })
  const what = cut(aboutOf(scope), Math.max(20, w - 24))
  return [
    Text({ key: 'entry-gap', children: ' ' }),
    rule('entry-top'),
    Box({ key: 'entry-row', flexDirection: 'row', children: [
      Box({ width: 2, flexShrink: 0, children: [Text({ color: 'text', children: '❯ ' })] }),
      Box({ flexGrow: 1, flexShrink: 1, children: [Input({
        key: `ask-${key}-${gen}`.slice(0, 120), placeholder: `Ask about ${what}${what.endsWith('…') ? '' : '…'}`, submitLabel: 'ask',
        ...(focus ? { autoFocus: true } : {}),
        // the question stays in the field while its thread's fork starts: a second ↵ then asks nothing more
        onSubmit: (v: string) => { void askHere($, scope, v) },
      })] }),
    ] }),
    rule('entry-bottom'),
  ]
}

/** A question typed in the input bar: the thread is asked, and the field empties. A question that cannot be asked
 *  says why in the failure line. */
export async function askHere($: Engine, scope: ThreadScope, text: string): Promise<void> {
  if (!String(text || '').trim()) return
  const key = threadKey(scope)
  if (isSending(key)) return
  const r = await askThread($, { text, scope })
  if (r.problem) { failNotice($, r.problem, 'thread'); return }
  fieldGen.set(key, (fieldGen.get(key) ?? 0) + 1)
  $.ui.invalidate('ui.render')
}

/** The size of the pane's body. */
const sizeOf = (e: Any) => ({ W: Math.max(30, Number(e?.props?.bodyColumns) || 80), H: Math.max(12, Number(e?.props?.scroll?.bodyRows) || 28) })

/** The list of the session's threads (kind `threads`). */
async function drawList($: Engine, e: Any, els: Any): Promise<Any> {
  const { Box, Button, Text } = els
  await $.state.get(GEN)
  const { W } = sizeOf(e)
  const rows = rowsOf(threadList(), Date.now())
  if (!rows.length) {
    return Box({ flexDirection: 'column', children: [
      subjectBlock(els, 'subject', 'Threads', 'none in this session yet'),
      Text({ key: 'none', dimColor: true, wrap: 'wrap', children: 'No threads yet.' }),
    ] })
  }
  const out: Any[] = [subjectBlock(els, 'subject', 'Threads', `${rows.length} thread${rows.length === 1 ? '' : 's'} in this session`), Text({ key: 'main', bold: true, children: 'main' })]
  rows.forEach((r, i) => {
    const lastRow = i === rows.length - 1
    const state = r.status === 'running' ? Text({ color: 'warning', children: 'answering…' }) : r.status === 'failed' ? Text({ color: 'error', children: 'stopped' }) : Text({ dimColor: true, children: `${r.asks} question${r.asks === 1 ? '' : 's'}${r.ago ? ` · ${r.ago}` : ''}` })
    const name = cut(r.name, Math.max(12, W - 26))
    out.push(Button({ key: `thread-${i}`, plain: true, label: r.name, onPress: () => { void showThread($, r.key, { from: 'threads' }) }, children: [Box({ flexDirection: 'column', children: [
      Text({ key: 'n', wrap: 'truncate-end', children: [Text({ dimColor: true, children: lastRow ? '└─ ' : '├─ ' }), Text({ children: name }), Text({ children: '  ' }), state] }),
      ...(r.last ? [Text({ key: 'q', dimColor: true, wrap: 'truncate-end', children: `${lastRow ? ' ' : '│'}    ${cut(r.last, Math.max(10, W - 6))}` })] : []),
    ] })] }))
  })
  return Box({ flexDirection: 'column', children: out })
}

/** What a thread is on, at the top of its pane: a card, drawn; an explainer or a heads-up, its words; else its name. */
async function subjectOfPane($: Engine, e: Any, els: Any, t: Thread, W: number): Promise<{ el: Any; rows: number }> {
  const s = t.scope
  if (s.card) {
    const meta = await metaOf($, s.card).catch(() => null)
    if (meta && meta.version > 0) return { el: column(els, [subjectBlock(els, 'subject', meta.title, 'a card in the conversation'), await frame($, { ...e, viewport: { ...(e?.viewport ?? {}), columns: W + 2 } }, meta)]), rows: 14 }
    return { el: subjectBlock(els, 'subject', aboutOf(s), 'a card that is no longer in the session'), rows: 3 }
  }
  if (s.mark && s.mark.kind !== 'citation') {
    const m = s.mark as { row: string; kind: string; id: string }
    const g = (await partOf<Any>($, m.row, 'explain').catch(() => null))?.items?.[m.id]
    const more = g ? [g.body, g.here, ...((g.bullets ?? []) as string[]).map(b => `· ${b}`)].filter(Boolean).map(String) : []
    return { el: subjectBlock(els, 'subject', String(g?.title || g?.term || aboutOf(s)), m.kind === 'heads' ? 'an important detail in Claude\'s reply' : 'an explainer in Claude\'s reply', more), rows: 3 + more.reduce((n, x) => n + rowsAt(x, W), 0) }
  }
  if (s.passage) {
    const words = cut(String(s.passage.text).replace(/\s+/g, ' ').trim(), 600)
    return { el: subjectBlock(els, 'subject', aboutOf(s), 'a passage of Claude\'s reply', [words]), rows: 3 + rowsAt(words, W) }
  }
  if (s.mark) {
    const it = (await rowMarks($, s.mark.row).catch(() => null))?.items.find(x => x.n === (s.mark as Any).n)
    return { el: subjectBlock(els, 'subject', it ? it.shown : aboutOf(s), 'a citation in Claude\'s reply'), rows: 3 }
  }
  return { el: subjectBlock(els, 'subject', t.subject, 'side thread'), rows: 3 }
}

const column = (els: Any, children: Any[]) => els.Box({ flexDirection: 'column', children })

/** One thread (kind `thread`): what it is on, its conversation, the input bar. */
async function drawThread($: Engine, e: Any, els: Any, args: Any): Promise<Any> {
  const { Button, Text } = els
  const key = String(args?.key ?? '')
  await $.state.get({ plugin: 'thimble', key: 'thread', id: key })
  const t = threadOf(key)
  if (!t) return Text({ dimColor: true, wrap: 'wrap', children: 'This thread is no longer in the session.' })
  const { W, H } = sizeOf(e)
  const top: Any[] = []
  // the way back to the list, when the list opened it (esc closes the pane)
  if (args?.from === 'threads') top.push(Button({ key: 'back', plain: true, label: 'back to the threads', onPress: () => { void listThreads($) }, children: [Text({ color: 'suggestion', children: '‹ threads' })] }), Text({ key: 'back-gap', children: ' ' }))
  const subject = await subjectOfPane($, e, els, t, W)
  const conv = await conversation($, e, els, t, W - 1, Math.max(4, H - subject.rows - 6 - top.length))
  return column(els, [...top, subject.el, ...conv, ...entry($, els, t.scope, W - 1, takeAskNext(key))])
}

/** The scope of a pane of thimble's, for the thread under it: what it shows, in words. */
async function paneScope($: Engine, kind: string, args: Any): Promise<ThreadScope> {
  // the claims pane: the claim selected, as its a asks it (one thread for both)
  const claims = kind === 'claims' ? await claimsThreadScope($, args) : null
  const pane = { kind, args: claims ? claims.args : args ?? {} }
  const known = threadOf(threadKey({ about: '', pane }))
  if (known) return { ...known.scope, pane }
  if (kind === 'evidence') {
    const it = args?.row ? (await rowMarks($, String(args.row)).catch(() => null))?.items.find(x => x.n === Number(args.n)) : null
    return { about: it ? it.shown.replace(/\*\*|`/g, '') : `citation ${args?.n ?? ''}`.trim(), pane }
  }
  if (kind === 'labels') return { about: args?.label ? `the label ${args.label}${args.value && args.value !== '-' ? ` (${args.value})` : ''}` : 'the labels', pane }
  if (kind === 'coverage') return { about: 'coverage', pane }
  if (claims) return { about: claims.about, pane }
  return { about: kind, pane }
}

/** The thread under a pane of thimble's (core/pane.ts): its conversation and the input bar, about what the pane
 *  shows. */
export async function threadUnder($: Engine, e: Any, kind: string, args: unknown, els: Any): Promise<Any[]> {
  const scope = await paneScope($, kind, args)
  const key = threadKey(scope)
  await $.state.get({ plugin: 'thimble', key: 'thread', id: key })
  const { W, H } = sizeOf(e)
  const t = threadOf(key)
  // two fifths of the pane for the conversation, as 0.10's panel gave it
  const conv = t ? await conversation($, e, els, t, W - 1, Math.max(4, Math.floor(H * 0.4))) : []
  return [els.Text({ key: 'thread-gap', children: ' ' }), ...conv, ...entry($, els, scope, W - 1, takeAskNext(key))]
}

export async function drawThreads($: Engine, e: Any, kind: 'threads' | 'thread', args: unknown, els: Any): Promise<Any> {
  return kind === 'threads' ? drawList($, e, els) : drawThread($, e, els, args)
}
