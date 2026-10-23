// threads.mjs: side threads, as pure functions. No `$`, no Node, no DOM (thread.ts and pane.tsx use it).
//
// A side thread is the conversation of what the side pane shows: a citation or an explainer of a reply (a mark), a
// passage of a reply (its margin's ?), a card, or a pane of thimble's (a label, coverage, the claims). The person asks it in the pane's input bar; a fork of
// main answers, and can read and compute over the data. It has its own turns. Main reads each question (core/engaged.ts)
// and no answer unless the person sends one there (m).
//
//   scope        {about, mark?: {row, kind: 'citation', n} | {row, kind: 'explain' | 'heads', id}, passage?: {row, text},
//                card?, part?, pane?: {kind, args}}; `part` is the line of a card that was selected when `a` asked
//                about it (cardPart), which the pane shows in place of the whole card
//   threadKey(scope)              one thread per mark, per passage, per part of a card, or per pane:
//                                 'mark-<row>-<kind>-<n|id>', 'passage-<row>-<its words, hashed>', 'card-<id>' (nothing
//                                 selected) or 'card-<id>-<the selected line's words, hashed>', 'pane-<kind>-<its
//                                 arguments>' (a pane of one citation's evidence is that citation's)
//   aboutOf(scope)                the words "about …" the thread shows under a question
//   shownAbout(scope)             what the person reads it is about, under a question: a few words, never a model's
//   askWords(scope)               what the input bar's placeholder names: `Ask about <this>`, in a few words
//   subjectOf(thread)             what it is on, in a few words
//   nameOf(thread)                its name in the list: 'main/<what it is on>'
//   firstMessage({text, scope, detail, root})   the fork's first question: the question, then what it is about
//   nextMessage({text, scope, last})            a later question: what it is about named again when that changed
//   forkDirective(guide, sent)    what the fork is told: the thread's instructions, its place, the question
//   turnsOf(messages)             the fork's transcript ($.session.messages, as: 'api') as the thread's turns
//   stepWords(step, root)         a step without the folders it ran in, for the pane's `N steps` row
//   display(thread, turns)        those turns as the person reads them: each question as they asked it
//   rowsOf(list, now)             the thread list's rows: key, name, status, questions, last question, how long ago
//   ago(at, now)                  how long ago, in a word: `now`, `4m`, `2h`, `3d`
//   cardPart(copy)                the part of a card a question is about: its selected line, from its text copy
//   partWords(part)               that line's words, without the marker, the bars' glyphs or runs of spaces: the same
//                                 at every width the card draws at
//   partAbout(about, part)        what a thread on a part of a card is about: `"Cherbourg 168" in the card "…"`
//   answerRow(thread, i)          the name of the answer at turn i in the store of citations, which checks and draws it

import { withoutMarks } from '../marks/message.js'

const safe = s => String(s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x'
/** A short, stable name for a text. */
function hashOf(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(36)
}
const cutTo = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** A pane's arguments as a stable key: its fields in order, objects too. */
function argsKey(args) {
  if (args == null || typeof args !== 'object') return safe(args ?? 'main')
  const keys = Object.keys(args).sort()
  return safe(keys.filter(k => args[k] != null && args[k] !== '').map(k => `${k}=${typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]}`).join('-') || 'main')
}

/** The part of a card a question is about: the line of its text copy that marks the selected item with `▸`, as the
 *  card guide asks a view to, from the mark on and its runs of spaces shortened; '' when no line does. */
export function cardPart(copy = '') {
  const line = String(copy).split('\n').find(l => l.includes('▸'))
  return line ? line.slice(line.indexOf('▸')).replace(/\s{3,}/g, '  ').trim() : ''
}

/** A part's words, the same at every width the card draws at: no `▸`, no box-drawing or block glyphs (a bar's
 *  length changes with the width), single spaces. */
export function partWords(part = '') {
  return String(part).replace(/[▸\u2500-\u259F…]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** What a thread on a part of a card is about: the part's words, then the card's `about`. */
export function partAbout(about, part = '') {
  const w = partWords(part)
  return w ? `"${cutTo(w, 40)}" in ${about}` : String(about)
}

/** The mark a pane stands for: the evidence pane of a citation is that citation. */
function markOf(scope = {}) {
  if (scope.mark) return scope.mark
  const p = scope.pane
  if (p && p.kind === 'evidence' && p.args && p.args.row && p.args.n != null) return { row: String(p.args.row), kind: 'citation', n: Number(p.args.n) }
  return null
}

export function threadKey(scope = {}) {
  const m = markOf(scope)
  if (m) return `mark-${safe(m.row)}-${safe(m.kind)}-${safe(m.kind === 'citation' ? m.n : m.id)}`
  if (scope.passage) return `passage-${safe(scope.passage.row)}-${hashOf(String(scope.passage.text ?? '').trim())}`
  if (scope.card) {
    // a thread for each part of a card a click selected (a bar, a row), and one for the card as a whole
    const w = partWords(scope.part)
    return w ? `card-${safe(scope.card)}-${hashOf(w)}` : `card-${safe(scope.card)}`
  }
  if (scope.pane) return `pane-${safe(scope.pane.kind)}-${argsKey(scope.pane.args)}`
  return `about-${safe(scope.about)}`
}

export function aboutOf(scope = {}) {
  return String(scope.about || (scope.card ? 'this card' : markOf(scope) ? 'this mark' : scope.passage ? 'this passage' : scope.pane ? scope.pane.kind : 'this'))
}

/** What the person reads a thread is about, in a few words (under a question): `aboutOf`, but never the words a model
 *  reads about a pane (the claims pane's `about` is a sentence). */
export function shownAbout(scope = {}) {
  const pane = scope.pane
  if (pane?.kind !== 'claims') return aboutOf(scope)
  const a = pane.args || {}
  return a.claim ? 'this claim' : a.group != null ? 'this cluster' : a.source ? 'this source' : 'the claims'
}

/** What the input bar's placeholder names, `Ask about <it>`: the thing itself in a few words. */
export const askWords = (scope = {}) => (scope.card ? 'this card' : shownAbout(scope))

/** What a thread is on, in a few words. */
export function subjectOf(thread) {
  return String(thread?.subject || thread?.scope?.about || thread?.title || 'a thread')
}

/** The thread's name in the list, as 0.9 named a side thread: `main/<what it is on>`. */
export function nameOf(thread) {
  return `main/${cutTo(subjectOf(thread).replace(/\s+/g, ' ').trim(), 32)}`
}

/** Whether two scopes are about the same thing (a later question about it needs no "about"). */
export function sameThing(a = {}, b = {}) {
  return threadKey(a) === threadKey(b) && String(a.about || '') === String(b.about || '')
}

/**
 * The thread's first question: the person's question as they wrote it, then a few lines on what they were looking at,
 * so "this" and "here" resolve. The fork's own instructions (the registry's thread prompt) say how to answer.
 *   detail: what the thing is, in lines the hooks module wrote (a citation's sentence and evidence, a card's text)
 *   root: the folder of the data
 */
export function firstMessage({ text, scope = {}, detail = '', root = '' }) {
  const lines = [String(text || '').trim(), '']
  const m = markOf(scope)
  if (scope.card) lines.push(`About: the card "${aboutOf(scope)}" (id "${scope.card}").`)
  else if (m && m.kind === 'citation') lines.push(`About: Claude's citation "${aboutOf(scope)}" in its reply.`)
  else if (m) lines.push(`About: the words "${aboutOf(scope)}" in Claude's message${m.kind === 'heads' ? ', which thimble marked as an important detail' : ', which thimble explained'}.`)
  else if (scope.passage) lines.push("About: this passage of Claude's message:", String(scope.passage.text ?? '').trim())
  else if (scope.pane) lines.push(`About: the panel "${aboutOf(scope)}" beside the conversation.`)
  else lines.push(`About: ${aboutOf(scope)}.`)
  if (String(detail || '').trim()) lines.push(String(detail).trim())
  if (root) lines.push(`The data: ${root}`)
  return lines.join('\n').trim()
}

export function nextMessage({ text, scope = {}, last = null }) {
  const q = String(text || '').trim()
  if (last && sameThing(scope, last)) return q
  return `${q}\n\n(About "${aboutOf(scope)}" now.)`
}

const oneLine = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 160)
const HANDBACK = /^(SubagentHandback|SendUserMessage)$/
// a fork's opening, as Claude Code writes it into the fork's transcript: the call that started it, then its boilerplate
// and the directive it was given
const FORK = /<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>\s*(?:Your directive:\s*)?/
// where the question starts in what a fork was told (forkDirective): after the line on its place
const PLACE = 'You answer in a side thread beside the conversation above, which is context. The analyst reads your last message in the side panel, and main never sees it. Answer with Bash, Read, Grep and Glob, change no file, and do not restate the question.'

/** What a thread's fork is told (thread.ts): the thread's instructions, how it stands beside the conversation, then
 *  the question as `firstMessage` wrote it. */
export function forkDirective(guide, sent) {
  return [String(guide || '').trim(), PLACE, String(sent || '')].filter(Boolean).join('\n\n')
}

/** The question in what a fork was told: the words after its place line, else the whole. */
function questionIn(directive) {
  const at = directive.indexOf(PLACE)
  return at < 0 ? directive : directive.slice(at + PLACE.length).trim()
}

// Claude Code's wrapper of a message sent to an agent while it works, and its reminders
const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
const QUEUED = /^[^\n]*sent a message while you were working:\s*([\s\S]*?)\s*(?:Address this before completing your current task\.)?\s*$/

/** The report a subagent handed back, when it ended that way (auto mode): its message. */
function handback(content) {
  if (!Array.isArray(content)) return ''
  const b = content.find(x => x && x.type === 'tool_use' && HANDBACK.test(String(x.name)))
  return b ? String(b.input?.message ?? b.input?.text ?? b.input?.report ?? '') : ''
}

/** A tool call in a thread, in a few words: `python3 count.py`, `Read conftest.py`. */
export function callWords(b) {
  const i = b?.input || {}
  if (b?.name === 'Bash') return String(i.command || '').split('\n')[0].slice(0, 120)
  return `${b?.name || 'tool'} ${String(i.file_path || i.pattern || i.path || i.title || i.description || '').slice(0, 100)}`.trim()
}

const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// a leading `cd <folder> &&` (or `;`), quoted or not
const LEAD_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/

/** A step as the pane shows it (`N steps · <step>`), without the folders it ran in, since a folder's path can be
 *  private: no leading `cd <folder> &&`, a path in the data folder `root` relative to it, any other absolute path by
 *  its last name (`…/todo.txt`). */
export function stepWords(step, root = '') {
  let s = String(step ?? '')
  while (LEAD_CD.test(s) && s.replace(LEAD_CD, '').trim()) s = s.replace(LEAD_CD, '')
  const r = String(root || '').replace(/\/+$/, '')
  if (r) s = s.replace(new RegExp(`${escRe(r)}/(?=[^\\s'"])`, 'g'), '').replace(new RegExp(`${escRe(r)}(?=$|[\\s'"/])`, 'g'), '.')
  return s.replace(/(^|[\s='"(])\/(?:[^\s'"/]+\/)+([^\s'"/]+)/g, '$1…/$2')
}

/**
 * The turns of a thread from its fork's transcript: [{role: 'person', text}] for each question (the environment block
 * Claude Code puts first is left out), [{role: 'claude', text, calls}] for each answer, its tool calls in a few words.
 * Tool results are left out.
 */
export function turnsOf(messages) {
  const out = []
  for (const m of messages || []) {
    const c = m?.content
    // a fork's opening call (the Agent call that started it) is no step of its
    if (m?.role === 'assistant' && Array.isArray(c) && c.length && c.every(b => b?.type === 'tool_use' && b.name === 'Agent')) continue
    if (m?.role === 'user') {
      const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]
      const texts = blocks.filter(b => b && b.type === 'text').map(b => String(b.text || ''))
      // a fork's directive (after its boilerplate) holds the person's question, beside the result of its opening call
      const directive = texts.map(x => (FORK.test(x) ? x.replace(FORK, '').trim() : '')).find(Boolean)
      if (directive) { out.push({ role: 'person', text: questionIn(directive) }); continue }
      // a later question reaches a running agent wrapped as a message "sent while you were working", in or out of a
      // reminder, and may ride with the tool results of the step it interrupts: its words are the person's turn
      const queued = texts.flatMap(x => [...[...x.matchAll(REMINDER)].map(y => y[1].trim()), x.replace(REMINDER, '').trim()])
        .map(x => QUEUED.exec(x)?.[1]).filter(Boolean)
      const plain = texts.join('\n').replace(REMINDER, '').trim()
      const t = queued.length ? queued.join('\n').trim() : blocks.some(b => b && b.type === 'tool_result') ? '' : questionIn(plain)
      if (t) out.push({ role: 'person', text: t })
      continue
    }
    if (m?.role !== 'assistant') continue
    let last = out[out.length - 1]
    if (!last || last.role !== 'claude') { last = { role: 'claude', text: '', calls: [] }; out.push(last) }
    // the answer is the turn's last words (or the report it handed back); words between its tool calls are steps
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type === 'text' && String(b.text || '').trim()) { if (last.text) last.calls.push(oneLine(last.text)); last.text = b.text.trim() }
      else if (b?.type === 'tool_use' && HANDBACK.test(String(b.name))) last.text = handback([b]) || last.text
      else if (b?.type === 'tool_use') { if (last.text) { last.calls.push(oneLine(last.text)); last.text = '' } last.calls.push(callWords(b)) }
    }
  }
  return out
}

/**
 * The thread's turns as the person reads them: each question they asked, with what it was about, in place of the
 * prompt the fork got. A fork's transcript may begin where a later fork started again: the turns before the first
 * question it holds are kept as the thread had them. The cards its fork drew are kept with the answer after their
 * question. `now`: the time for a turn the thread did not have.
 */
export function display(thread, turns, now = '') {
  let a = 0
  let first = -1
  const asks = thread.asks || []
  const old = thread.turns || []
  const matches = (x, ask) => x.text === ask.sent || (!!ask.sent && x.text.endsWith(ask.sent)) || (!!ask.sent && ask.sent.startsWith(x.text)) || x.text.startsWith(String(ask.text).trim())
  const fresh = turns.map((x, i) => {
    const at = old[i]?.at ?? now
    if (x.role !== 'person') {
      const cards = asks[a - 1]?.cards
      return { ...x, at, ...(cards?.length ? { cards } : {}) }
    }
    let j = a
    while (j < asks.length && !matches(x, asks[j])) j++
    if (j < asks.length) {
      const ask = asks[j]
      if (first < 0) first = j
      a = j + 1
      return { role: 'person', text: ask.text, about: shownAbout(ask.scope), at: ask.at }
    }
    return { ...x, at }
  })
  if (first <= 0) return fresh
  let seen = 0
  const upTo = old.findIndex(x => x.role === 'person' && seen++ === first)
  return [...(upTo < 0 ? old : old.slice(0, upTo)), ...fresh]
}

/** How long ago, in a word or two: `now`, `4m`, `2h`, `3d`. */
export function ago(at, now = Date.now()) {
  const t = Date.parse(String(at || ''))
  if (!isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The threads as the list shows them, the newest first. */
export function rowsOf(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter(t => t && t.key)
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .map(t => {
      const qs = (t.turns || []).filter(x => x.role === 'person')
      return { key: String(t.key), name: nameOf(t), status: String(t.status || ''), asks: (t.asks || []).length || qs.length, last: qs.length ? String(qs[qs.length - 1].text || '') : '', ago: ago(t.at, now) }
    })
}

/** The name an answer of a thread has in the store of citations (marks/store.ts), by its place among the thread's
 *  turns: its check is kept and drawn by it. */
export const answerRow = (thread, i) => `thread-${safe(thread?.id ?? thread?.key)}-${i}`

/** A thread's answer as the prompt main reads (m), which the person sees in the conversation: what it was on, the
 *  question, the answer without its citations' links (main cites what it says again), and what main replies. */
export function sentNote(thread) {
  const turns = thread?.turns || []
  let a = -1
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'claude' && turns[i].text) { a = i; break }
  if (a < 0) return ''
  let q = ''
  for (let i = a - 1; i >= 0; i--) if (turns[i].role === 'person') { q = turns[i].text; break }
  return `The analyst sent you the answer of a side thread about ${subjectOf(thread)}. They asked there: "${oneLine(q)}"\nThe side agent answered:\n${withoutMarks(String(turns[a].text)).trim()}\n\nReply to the analyst: say what this answer changes in what you told them, if anything.`
}
