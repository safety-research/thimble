// cardfork.mjs: the card after the answer (registry feature `card`), the parts with no engine in them. After a turn that
// ran `thimble`, the shell asks a fork of the session (it shares main's prompt cache) whether a card would help and, if so,
// for the card; thimble runs the queries the card asks for, saves it and draws it under the answer. Main never reads
// the card guidance or writes the program inside its turn, so its answer reaches the person sooner and its context
// stays smaller. These helpers compose the fork's messages from the version's text (prompts/card/<version>.md), read
// its reply, put the ids of the queries thimble ran in place of their names, find what does not hold after a save, and
// serve the thimble skill with its card parts replaced (main does not draw the card itself).
import { fill, sectionOf } from '../prompts/registry.mjs'

// a section by its heading; a heading that names the analyst is found under its earlier words too ("the person")
const sectionNamed = (raw, heading) => sectionOf(raw, heading) || sectionOf(raw, heading.replace('the analyst', 'the person'))

const body = (raw, heading) => {
  const s = sectionNamed(raw, heading)
  return s ? s.replace(/^#{1,6}[^\n]*\n+/, '').trim() : ''
}

/** The fork's request: the version's "The request" section with the turn filled in. */
export function requestText(raw, { question = '', answer = '', cards = [], guidance = '', toolkit = '' } = {}) {
  return fill(body(raw, 'The request'), {
    QUESTION: question.trim() || '(none)',
    ANSWER: answer.trim() || '(none)',
    CARDS: cards.length ? cards.join(', ') : 'none',
    GUIDANCE: guidance.trim(),
    TOOLKIT: toolkit.trim(),
  })
}

/** v's card from the fork (a version with the section "The view the analyst asked for"), or '' for a version without
 *  it, where v asks main as before. */
export function viewText(raw, { what = '', choice = '', has = [], proposals = [], answer = '', guidance = '', toolkit = '' } = {}) {
  const text = body(raw, 'The view the analyst asked for')
  if (!text) return ''
  return fill(text, {
    WHAT: what,
    CHOICE: choice ? `, as "${choice}"` : '',
    HAS: has.length ? `It has the card${has.length > 1 ? 's' : ''} ${has.join(', ')} already: make a different view, not a copy.\n\n` : '',
    PROPOSALS: proposals.length ? `${choice ? 'Also proposed' : 'Proposed'} for it: ${proposals.join('; ')}.\n\n` : '',
    ANSWER: answer.trim() || '(none)',
    GUIDANCE: guidance.trim(),
    TOOLKIT: toolkit.trim(),
  })
}

/** The fix round's request: the problems the save and the drawing found, and the card as the fork wrote it. */
export function fixText(raw, { problems = [], card = '', toolkit = '' } = {}) {
  return fill(body(raw, 'The fix'), {
    PROBLEMS: problems.map(p => `- ${p}`).join('\n') || '(none)',
    CARD: card.trim(),
    TOOLKIT: toolkit.trim(),
  })
}

/** The first JSON object in a reply (a fenced block, or the outermost braces), or null. */
export function jsonOf(text) {
  const s = String(text ?? '')
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(s)
  const tries = [fence?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean)
  for (const t of tries) {
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      // the next try
    }
  }
  return null
}

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/

/** A name the kernel takes for an object: lower case, digits and dashes, at most 60 characters. */
export function slugOf(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'card'
}

/**
 * The fork's reply, read: {kind: 'none', why} when it drew no card; {kind: 'card', name, queries, object} for a card;
 * {kind: 'ok'} when a fix round found nothing to fix; {kind: 'unreadable', why} otherwise.
 */
export function readReply(text) {
  const v = jsonOf(text)
  if (!v) return { kind: 'unreadable', why: 'the reply held no JSON object' }
  if (v.ok === true && !v.object) return { kind: 'ok' }
  if (v.card === null || v.card === false || (v.card === undefined && !v.object)) return { kind: 'none', why: String(v.why ?? '').slice(0, 300) }
  const object = v.object
  if (!object || typeof object !== 'object' || Array.isArray(object)) return { kind: 'unreadable', why: 'the card has no object' }
  if (typeof object.program !== 'string' || !object.program.trim()) return { kind: 'unreadable', why: 'the card has no program' }
  const queries = (Array.isArray(v.queries) ? v.queries : [])
    .filter(q => q && typeof q.code === 'string' && q.code.trim() && typeof q.name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(q.name))
    .map(q => ({ name: q.name, label: String(q.label || q.name).replace(/\s+/g, ' ').slice(0, 80), code: q.code }))
  const name = NAME.test(String(v.card)) ? String(v.card) : slugOf(v.card || object.title)
  return { kind: 'card', name, queries, object }
}

/** The query id `thimble run` printed first (`r12 · edits per day`), or null. */
export function queryIdOf(stdout) {
  const m = /^([qr]\d+)\s+·/m.exec(String(stdout ?? ''))
  return m ? m[1] : null
}

/** The object with each `$name` of a query thimble ran replaced by the query's id (in data, text, cites, anywhere). */
export function bindQueries(object, ids) {
  const names = Object.keys(ids || {})
  if (!names.length) return object
  const re = new RegExp(`\\$(${names.map(n => n.replace(/[^A-Za-z0-9_]/g, '')).join('|')})(?![A-Za-z0-9_])`, 'g')
  return JSON.parse(JSON.stringify(object).replace(re, (_, n) => ids[n]))
}

/**
 * What does not hold after a save, in lines for the fix round (empty: nothing to fix). From `thimble save`'s output: its
 * problem lines and citations that do not hold. From the drawing (the shell's note on what the analyst sees): a program
 * that failed, an object that cannot be drawn, an interaction that failed when tried. Warnings alone ask for no fix.
 */
export function problemsOf(saveOut, drawn) {
  const out = []
  for (const line of String(saveOut ?? '').split('\n')) {
    const t = line.trim()
    if (/^problem:/.test(t)) out.push(t)
    const m = /^(\d+) of (\d+) citations hold/.exec(t)
    if (m && Number(m[1]) < Number(m[2])) out.push(t)
  }
  for (const line of String(drawn ?? '').split('\n')) {
    const t = line.trim()
    if (/^(The analyst cannot see|Its program failed|Tried as the analyst would)/.test(t)) out.push(t)
  }
  return [...new Set(out)]
}

/**
 * The thimble skill as main reads it while the card comes after the answer: its card section ("Cards") replaced by the
 * version's "Saving" and "What the analyst sees" sections (an older skill: its principle on saving and its "What the
 * analyst sees", or "the person" in either). A part the skill no longer has is added at its end, so main always reads
 * that the card comes after the answer.
 */
export function skillWithCards(skill, raw) {
  let s = String(skill ?? '')
  const saving = body(raw, 'Saving')
  const sees = sectionNamed(raw, 'What the analyst sees')
  const cards = sectionOf(s, 'Cards')
  if (cards && (saving || sees)) {
    const seesBody = sees.replace(/^#+[^\n]*\n+/, '')
    return s.replace(cards, ['## Cards', saving, seesBody].filter(Boolean).join('\n\n'))
  }
  const start = ['analyst', 'person'].map(w => s.indexOf(`**Save what the ${w} will keep as an object.**`)).find(i => i >= 0) ?? -1
  const stop = start >= 0 ? s.indexOf('`thimble save`.', start) : -1
  if (saving && start >= 0 && stop > start) s = s.slice(0, start) + saving + s.slice(stop + '`thimble save`.'.length)
  else if (saving) s = `${s.trimEnd()}\n\n${saving}\n`
  const old = sectionNamed(s, 'What the analyst sees')
  if (sees && old) s = s.replace(old, sees)
  else if (sees) s = `${s.trimEnd()}\n\n${sees}\n`
  return s
}
