// threads.js: side threads, as pure functions. No `$`, no Node, no DOM: the hooks module (thread.ts) and the browser
// page both use it.
//
// A side thread is the conversation of whatever opens in the side panel: a card's detail, a citation or an explainer
// (a mark of a message), or any other pane. The person asks it in the panel's input bar, about the part they selected;
// a subagent of the session answers, and can query the data with `thimble`. It has its own turns. Main's
// conversation gets nothing of it unless the person sends the result there.
//
//   scope        {object?, v?, region?, label?, row?, mark?: {kind, ref?, gloss?, label?, term?}, pane?, key?, title?}
//   threadKey(scope)              one thread per card, per mark, or per pane: 'card-<object>', 'mark-<row>-<ref|gloss>'
//                                 or 'pane-<pane>-<its state key>'
//   aboutOf(scope)                the words "about …" the thread shows under a question
//   nameOf(thread)                its name in the list and the bar: 'main/<what it is on>'
//   firstMessage({text, scope, card, refs, root})   the subagent's first prompt: the question, then what it is about
//   nextMessage({text, scope, last})               a later question: its part named again when the part changed
//   turnsOf(messages)             the subagent's transcript ($.session.messages, as: 'api') as the thread's turns
//   answerOf(messages)            its last answer: its last words, or the report it handed back
//   ownReport(text, ids)          the thread a hand-back or a task notification in main's queue belongs to, or null

import { regionMeta, regionRefs } from './object.js'

const safe = s => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x'

export function threadKey(scope = {}) {
  if (scope.object) return `card-${safe(scope.object)}`
  if (scope.pane) return `pane-${safe(scope.pane)}-${safe(scope.key || 'main')}`
  const m = scope.mark || {}
  return `mark-${safe(scope.row)}-${safe(m.ref || m.gloss || m.term || m.label)}`
}

export function aboutOf(scope = {}) {
  const m = scope.mark
  if (m && !scope.object) return String(m.term || m.label || m.ref || 'this mark')
  if (scope.pane && !scope.object) return String(scope.label || scope.region || scope.title || scope.pane)
  return String(scope.label || scope.region || 'this card')
}

const cutTo = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** What a thread is on, in a few words: the card's title, the mark's words, the pane's title. */
export function subjectOf(thread) {
  const s = thread?.scope || {}
  if (s.object) return String(thread.card || s.object)
  if (s.mark) return String(s.mark.term || s.mark.label || s.mark.ref || 'a mark')
  if (s.pane) return String(s.title || s.pane)
  return String(thread?.title || 'a thread')
}

/** The thread's name in the list and the bar, as 0.9 names a side thread: `main/<what it is on>`. */
export function nameOf(thread) {
  return `main/${cutTo(subjectOf(thread).replace(/\s+/g, ' ').trim(), 32)}`
}

/**
 * A pane's side thread when its module says nothing of it (side.ts): one thread per pane instance (its state key),
 * each question about the part its program selected (k.select), named by the part's label and carrying the part's refs
 * (its region's meta ref or refs). Nothing selected: about the pane, by its title.
 *   {pane, stateKey, title, drawing} -> {scope, label, refs}
 */
export function paneScope({ pane, stateKey, title, drawing }) {
  const region = typeof drawing?.selected === 'string' ? drawing.selected : null
  const meta = region ? regionMeta(drawing, region) : null
  const part = region ? String(meta?.label || region) : ''
  const scope = { pane: String(pane), key: String(stateKey), title: String(title || pane), ...(region ? { region, label: part } : {}) }
  return { scope, label: part || String(title || pane), refs: region ? regionRefs(null, drawing, region).refs : [] }
}

/** Whether two scopes name the same part (a later question about the same part needs no "about"). */
export function samePart(a = {}, b = {}) {
  return (a.object || '') === (b.object || '') && (a.region || '') === (b.region || '') && (a.mark?.ref || a.mark?.gloss || '') === (b.mark?.ref || b.mark?.gloss || '')
}

/**
 * The thread's first prompt: the person's question as they wrote it, then two or three lines on what they were looking
 * at, so "this" and "here" resolve. The subagent's own instructions (the registry's thread prompt) say how to answer.
 *   card: {id, v, title, file}   refs: the kernel refs the part rests on   root: the folder of the data
 */
export function firstMessage({ text, scope = {}, card = null, refs = [], root = '', selFile = '', about = '' }) {
  const lines = [String(text || '').trim(), '']
  if (card) {
    // a part of the card, or a selection the card's program named (k.ask: a brushed range, several rows)
    const part = scope.region ? `the part "${aboutOf(scope)}" (${scope.region}) of ` : scope.label ? `the selection "${scope.label}" in ` : ''
    lines.push(`About: ${part}the card "${card.title || card.id}" (${card.id}@${card.v ?? card.version}, ${card.file || `thimble/objects/${card.id}.json`}).`)
  } else if (scope.mark) {
    const m = scope.mark
    lines.push(m.kind === 'gloss' ? `About: the term "${m.term || m.label}" in Claude's message.` : `About: Claude's citation "${m.label || m.ref}" (${m.ref}).`)
  } else if (scope.pane) {
    // a pane of thimble's (coverage, a label, the claims): the part selected in it, and what the pane shows
    const part = scope.region ? `the part "${aboutOf(scope)}" (${scope.region}) of ` : ''
    lines.push(`About: ${part}the panel "${scope.title || scope.pane}" beside the conversation${about ? `: ${about}` : ''}.`)
  }
  if (refs.length) lines.push(`Its rows: ${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ` and ${refs.length - 6} more` : ''} (\`thimble rows <ref>\` opens them).`)
  if (root) lines.push(`The data: ${root}`)
  if (selFile) lines.push(`The part the analyst has selected now, for a later message that names none: ${selFile}`)
  return lines.join('\n').trim()
}

export function nextMessage({ text, scope = {}, last = null }) {
  const q = String(text || '').trim()
  if (last && samePart(scope, last)) return q
  return `${q}\n\n(About ${scope.region ? `the part "${aboutOf(scope)}" (${scope.region})` : `"${aboutOf(scope)}"`} now.)`
}

const oneLine = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 160)
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '')
const HANDBACK = /^(SubagentHandback|SendUserMessage)$/
// a fork's opening, as Claude Code writes it into the fork's transcript: the call that started it, then its boilerplate
// and the directive it was given
const FORK = /<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>\s*(?:Your directive:\s*)?/

/** What a thread's fork is told (thread.ts): the thread's instructions, how it stands beside the conversation, then
 *  the question as `firstMessage` wrote it. */
export function forkDirective(guide, sent) {
  return [String(guide || '').trim(), 'You answer in a side thread beside the conversation above, which is context. The analyst reads your last message in the side panel, and main never sees it. Answer with `thimble` (Bash), Read, Grep and Glob, change no file, and do not restate the question.', String(sent || '')].filter(Boolean).join('\n\n')
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

/** A tool call in a thread, in a few words: `thimble run "reruns after 1240"`, `Read conftest.py`. */
export function callWords(b) {
  const i = b?.input || {}
  if (b?.name === 'Bash') return String(i.command || '').split('\n')[0].slice(0, 120)
  return `${b?.name || 'tool'} ${String(i.file_path || i.pattern || i.path || i.description || '').slice(0, 100)}`.trim()
}

/**
 * The turns of a thread from its subagent's transcript: [{role: 'person', text}] for each prompt the person sent (the
 * environment block Claude Code puts first is left out), [{role: 'claude', text, calls}] for each answer, its tool
 * calls in a few words. Tool results are left out.
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
      // a fork's directive (after its boilerplate) is the person's question, beside the result of its opening call
      const directive = texts.map(x => (FORK.test(x) ? x.replace(FORK, '').trim() : '')).find(Boolean)
      if (directive) { out.push({ role: 'person', text: directive }); continue }
      // a later question reaches a running agent wrapped as a message "sent while you were working", in or out of a
      // reminder, and may ride with the tool results of the step it interrupts: its words are the person's turn
      const queued = texts.flatMap(x => [...[...x.matchAll(REMINDER)].map(y => y[1].trim()), x.replace(REMINDER, '').trim()])
        .map(x => QUEUED.exec(x)?.[1]).filter(Boolean)
      const plain = texts.join('\n').replace(REMINDER, '').trim()
      const t = queued.length ? queued.join('\n').trim() : blocks.some(b => b && b.type === 'tool_result') ? '' : plain
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

export function answerOf(messages) {
  const turns = turnsOf(messages)
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'claude' && turns[i].text) return turns[i].text
  return ''
}

/** The thread a row in main's queue reports on: a hand-back (`<agent-message from="<id>">`) or a task notification
 *  (`<task-id><id></task-id>`) of one of the threads' agents. */
export function ownReport(text, ids) {
  const s = String(text || '')
  const m = /<agent-message from="([^"]+)">/.exec(s) || /<task-id>([^<]+)<\/task-id>/.exec(s)
  return m && ids.includes(m[1].trim()) ? m[1].trim() : null
}

/** What main reads when the person sends a thread's result there: the question, the part, and the answer. */
export function toMain(thread) {
  const turns = thread?.turns || []
  const lastQ = [...turns].reverse().find(t => t.role === 'person')
  const lastA = [...turns].reverse().find(t => t.role === 'claude' && t.text)
  if (!lastA) return ''
  const q = lastQ ? String(lastQ.text).split('\n\n')[0] : ''
  return [`The analyst sends you the result of a side thread about ${aboutOf(thread.scope)}${thread.card ? ` on the card "${thread.card}"` : ''}.`, q ? `They asked: ${q}` : '', `The thread answered: ${lastA.text}`].filter(Boolean).join('\n')
}

// The thread subagent's own instructions (its system prompt) are the registry's thread prompt: prompts/thread/.
