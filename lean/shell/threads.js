// threads.js: side threads, as pure functions. No `$`, no Node, no DOM: the hooks module (thread.ts) and the browser
// page both use it.
//
// A side thread is a question the person asks about one part of a card (or one mark of a message, from the tray),
// answered by a subagent of the session that can query the data with `lean`. It has its own turns. Main's
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
 * at, so "this" and "here" resolve. The subagent's own instructions (THREAD_PROMPT) say how to answer.
 *   card: {id, v, title, file}   refs: the kernel refs the part rests on   root: the folder of the data
 */
export function firstMessage({ text, scope = {}, card = null, refs = [], root = '', selFile = '' }) {
  const lines = [String(text || '').trim(), '']
  if (card) {
    const part = scope.region ? `the part "${aboutOf(scope)}" (${scope.region}) of ` : ''
    lines.push(`About: ${part}the card "${card.title || card.id}" (${card.id}@${card.v ?? card.version}, ${card.file || `thimble/objects/${card.id}.json`}).`)
  } else if (scope.mark) {
    const m = scope.mark
    lines.push(m.kind === 'gloss' ? `About: the term "${m.term || m.label}" in Claude's message.` : `About: Claude's citation "${m.label || m.ref}" (${m.ref}).`)
  }
  if (refs.length) lines.push(`Its rows: ${refs.slice(0, 3).join(', ')} (\`lean resolve <ref>\` opens them).`)
  if (root) lines.push(`The data: ${root}`)
  if (selFile) lines.push(`The part the person has selected now, for a later message that names none: ${selFile}`)
  return lines.join('\n').trim()
}

export function nextMessage({ text, scope = {}, last = null }) {
  const q = String(text || '').trim()
  if (last && samePart(scope, last)) return q
  return `${q}\n\n(About ${scope.region ? `the part "${aboutOf(scope)}" (${scope.region})` : `"${aboutOf(scope)}"`} now.)`
}

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '')
const HANDBACK = /^(SubagentHandback|SendUserMessage)$/

/** The report a subagent handed back, when it ended that way (auto mode): its message. */
function handback(content) {
  if (!Array.isArray(content)) return ''
  const b = content.find(x => x && x.type === 'tool_use' && HANDBACK.test(String(x.name)))
  return b ? String(b.input?.message ?? b.input?.text ?? b.input?.report ?? '') : ''
}

/** A tool call in a thread, in a few words: `lean q "reruns after 1240"`, `Read conftest.py`. */
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
      const t = textOf(c).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (t && !(Array.isArray(c) && c.some(b => b && b.type === 'tool_result'))) out.push({ role: 'person', text: t })
      continue
    }
    if (m?.role !== 'assistant') continue
    let last = out[out.length - 1]
    if (!last || last.role !== 'claude') { last = { role: 'claude', text: '', calls: [] }; out.push(last) }
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type === 'text' && String(b.text || '').trim()) last.text = last.text ? `${last.text}\n\n${b.text.trim()}` : b.text.trim()
      else if (b?.type === 'tool_use' && HANDBACK.test(String(b.name))) last.text = last.text ? `${last.text}\n\n${handback([b])}` : handback([b])
      else if (b?.type === 'tool_use') last.calls.push(callWords(b))
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
  return [`The person sends you the result of a side thread about ${aboutOf(thread.scope)}${thread.card ? ` on the card "${thread.card}"` : ''}.`, q ? `They asked: ${q}` : '', `The thread answered: ${lastA.text}`].filter(Boolean).join('\n')
}

/** The thread subagent's own instructions (its system prompt). */
export const THREAD_PROMPT = `You answer one person's questions about one part of a card, in a side thread of their Claude Code session. A card is an object the main conversation saved for them: a program, its data and its lineage, in thimble/objects/. The person reads your answers beside the card. The main conversation does not see this thread.

Principles

Answer the question about the part they selected. Their first message says which card and which part, and the refs of its rows. "This" and "here" mean that part. They may select another part while the thread is open: a later message that names no part is about the part in the selection file their first message names, so read that file first.

Check before you answer. Use the \`lean\` command with Bash, in the folder of the data: \`lean resolve <ref>\` opens the rows behind a value, \`lean q "<about>" <<'PY' ... PY\` computes a new value and keeps its rows, \`lean rows <ref> -n 5\` reads rows, \`lean list <card>\` shows the card's lineage. \`lean\` alone lists the commands. Run one query for a new number rather than guessing it.

Cite what you state, as the card does: a number as a link to its ref, as in [480](q7#n). Keep each answer short: two to four sentences, numbers first.

Change the card only when the person asks for it. Then read its file, change its program or data, and save it under the same name with \`lean save <name> --from FILE\`. The person sees the new version in the card's header (v1 · v2).

Example. The person asks "Where did the time go?" about the part "Rerun loop" (steps 881–1720) of a run's trail. You run \`lean resolve "q3#station=rerun-loop@n"\`, then one query for the reruns after the failure rate was known. You answer: "[840](q3#station=rerun-loop@n) steps were reruns with no code change. The rate was known at step 1240 (1 in 9); the [480](q8#n) reruns after it could not change it."`
