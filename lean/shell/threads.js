// threads.js: side threads, as pure functions. No `$`, no Node, no DOM: the hooks module (thread.ts) and the browser
// page both use it.
//
// A side thread is a question the person asks about one part of a card (or one mark of a message, from the tray),
// answered by a subagent of the session that can query the data with `thimble`. It has its own turns. Main's
// conversation gets nothing of it unless the person sends the result there.
//
//   scope        {object?, v?, region?, label?, row?, mark?: {kind, ref?, gloss?, label?, term?}}
//   threadKey(scope)              one thread per card, or per mark: 'card-<object>' or 'mark-<row>-<ref|gloss>'
//   aboutOf(scope)                the words "about …" the thread shows under a question
//   firstMessage({text, scope, card, refs, root})   the subagent's first prompt: the question, then what it is about
//   nextMessage({text, scope, last})               a later question: its part named again when the part changed
//   turnsOf(messages)             the subagent's transcript ($.session.messages, as: 'api') as the thread's turns
//   answerOf(messages)            its last answer: its last words, or the report it handed back
//   ownReport(text, ids)          the thread a hand-back or a task notification in main's queue belongs to, or null

const safe = s => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x'

export function threadKey(scope = {}) {
  if (scope.object) return `card-${safe(scope.object)}`
  const m = scope.mark || {}
  return `mark-${safe(scope.row)}-${safe(m.ref || m.gloss || m.term || m.label)}`
}

export function aboutOf(scope = {}) {
  const m = scope.mark
  if (m && !scope.object) return String(m.term || m.label || m.ref || 'this mark')
  return String(scope.label || scope.region || 'this card')
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
export function firstMessage({ text, scope = {}, card = null, refs = [], root = '', selFile = '' }) {
  const lines = [String(text || '').trim(), '']
  if (card) {
    // a part of the card, or a selection the card's program named (k.ask: a brushed range, several rows)
    const part = scope.region ? `the part "${aboutOf(scope)}" (${scope.region}) of ` : scope.label ? `the selection "${scope.label}" in ` : ''
    lines.push(`About: ${part}the card "${card.title || card.id}" (${card.id}@${card.v ?? card.version}, ${card.file || `thimble/objects/${card.id}.json`}).`)
  } else if (scope.mark) {
    const m = scope.mark
    lines.push(m.kind === 'gloss' ? `About: the term "${m.term || m.label}" in Claude's message.` : `About: Claude's citation "${m.label || m.ref}" (${m.ref}).`)
  }
  if (refs.length) lines.push(`Its rows: ${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ` and ${refs.length - 6} more` : ''} (\`thimble resolve <ref>\` opens them).`)
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
    if (m?.role === 'user') {
      const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]
      const texts = blocks.filter(b => b && b.type === 'text').map(b => String(b.text || ''))
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
