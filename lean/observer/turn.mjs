// turn.mjs: the new turn as the post-turn pass reads it. Pure. From the session's messages ($.session.messages()), the
// person's last prompt and everything after it: Claude's words between its tool calls, and each tool it ran with what
// came back, each result cut to fit a budget, the latest calls kept longest. The pass reads this and a digest of the
// state, never the session before the turn.

const cut = (s, n) => {
  const t = String(s ?? '')
  return t.length <= n ? t : n < 80 ? t.slice(0, n) + '…' : `${t.slice(0, Math.floor(n * 0.7))} … ${t.slice(-Math.floor(n * 0.3))}`
}
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The messages of the turn: after the person's last prompt (a user message that is no tool result). */
export function turnMessages(msgs) {
  const list = Array.isArray(msgs) ? msgs : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'user' && !(m.toolResults && m.toolResults.length) && String(m.text || '').trim()) return list.slice(i + 1)
  }
  return list
}

/** What one tool call was, in a line: the command, the file, the pattern. */
export function callOf(use) {
  const x = use?.input || {}
  const tool = String(use?.tool || 'tool')
  if (tool === 'Bash') return `Bash: ${cut(oneLine(x.command), 600)}`
  if (tool === 'Read') return `Read: ${x.file_path ?? ''}${x.offset ? ` from line ${x.offset}` : ''}${x.limit ? ` (${x.limit} lines)` : ''}`
  if (tool === 'Grep') return `Grep: ${cut(oneLine(x.pattern), 160)}${x.path ? ` in ${x.path}` : ''}${x.glob ? ` (${x.glob})` : ''}`
  if (tool === 'Glob') return `Glob: ${x.pattern ?? ''}${x.path ? ` in ${x.path}` : ''}`
  if (tool === 'Write' || tool === 'Edit') return `${tool}: ${x.file_path ?? ''}`
  if (tool === 'Skill') return `Skill: ${x.skill ?? x.command ?? ''}`
  return `${tool}: ${cut(oneLine(JSON.stringify(x)), 200)}`
}

/** Tools whose result says nothing the pass needs (a skill's text, a file written). */
const QUIET = new Set(['Skill', 'Write', 'Edit', 'TodoWrite', 'ToolSearch'])

/**
 * The turn's steps as text: "Claude: …" for its words, "Claude ran Bash: …" and "  → …" for each call and what came
 * back. The final answer is left out when `answer` is given (the pass reads it on its own). Within `budget` characters:
 * each result gets an equal part of what the words and calls leave, at least `floor`.
 */
export function stepsOf(msgs, { answer = '', budget = 40000, floor = 240 } = {}) {
  const turn = turnMessages(msgs)
  const items = []
  for (const m of turn) {
    if (!m || m.role !== 'assistant') continue
    const text = String(m.text || '').trim()
    if (text) items.push({ kind: 'text', text })
    for (const u of m.toolUses || []) items.push({ kind: 'call', line: callOf(u), result: QUIET.has(String(u.tool)) ? '' : String(u.text ?? (typeof u.result === 'string' ? u.result : '')), isError: !!u.isError })
  }
  // the answer the person read is shown on its own
  const ans = String(answer || '').trim()
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== 'text') continue
    if (ans && (items[i].text === ans || ans.endsWith(items[i].text))) items.splice(i, 1)
    break
  }
  const words = items.filter(x => x.kind === 'text').reduce((s, x) => s + Math.min(x.text.length, 1600) + 10, 0)
  const calls = items.filter(x => x.kind === 'call')
  const fixed = calls.reduce((s, x) => s + x.line.length + 20, 0)
  const each = calls.length ? Math.max(floor, Math.floor((budget - words - fixed) / calls.length)) : 0
  const lines = []
  calls.forEach((c, i) => { c.room = i >= calls.length - 3 ? Math.max(each, 1200) : each })
  for (const x of items) {
    if (x.kind === 'text') lines.push(`Claude: ${cut(x.text, 1600)}`)
    else {
      lines.push(`Claude ran ${x.line}`)
      if (x.result.trim()) lines.push(`  → ${x.isError ? 'error: ' : ''}${cut(x.result.trim(), x.room).replace(/\n/g, '\n    ')}`)
    }
  }
  return lines.length ? lines.join('\n') : '(no steps before the answer)'
}

/** The turn's words: the person's message and what Claude wrote in the turn (its words between tool calls and its
 *  answer), with no tool output. What the claims lens reads its digest and its quiet rule from. */
export function turnWords(msgs, question = '') {
  const parts = [String(question || '')]
  for (const m of turnMessages(msgs)) if (m && m.role === 'assistant' && String(m.text || '').trim()) parts.push(String(m.text))
  return parts.join('\n').trim()
}
