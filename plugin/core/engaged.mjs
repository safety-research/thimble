// engaged.mjs: what the person engaged with on screen, in the words of a line Claude reads with their next prompt and
// they never see: an explainer or a heads-up they opened, a citation they opened, a question they asked in a side
// thread. Also the explainers and heads-ups shown on an answer, which Claude reads the same way, so it knows what the
// analyst was told beside its words. Main reads it with that prompt, and the observer's look, a fork of main's conversation, reads it in the
// session too: both learn what this analyst knows and cares about as the session goes on. Pure: no `$`.
//
//   openedLine(mark, message)  -> {key, text} for a mark the person opened, or null:
//                                 {kind: 'citation', row, n, words, status, failedBy?}  a citation (marks/store.ts MarkItem)
//                                 {kind: 'explain', row, term}                    an explainer
//                                 {kind: 'heads', row, term, title}               a heads-up
//   askedLine(ask)             -> {key, text} for a question asked in a side thread ({text, about}), or null
//   commentsText(items, message) -> what Claude reads of the explainers and heads-ups shown on its message, or ''
//   HEAD                       the line the lines go under
// `key` names what was engaged with, so the same open is told once.
import { oneLine } from './answers.mjs'

export const HEAD = 'What the analyst did on screen since your last reply. It shows what they know and what they care about; none of it asks anything of you.'

/** Where a mark stands, in a few words: the message's first words, cut where a word ends. */
function inMessage(message) {
  const all = oneLine(message)
  const words = all.length <= 60 ? all : `${all.slice(0, 60).replace(/\s+\S*$/, '')}…`
  return words ? ` in your message that begins "${words}"` : ''
}

/** What the check found for a citation, in words; '' while it has not ended. */
function checkWords(status, failedBy) {
  switch (status) {
    case 'verified': return 'the check verified it as written'
    case 'corrected': return 'the check corrected it'
    case 'failed': return failedBy === 'none' ? 'its check did not run' : 'the check flagged it'
    default: return ''
  }
}

export function openedLine(mark, message = '') {
  if (!mark || typeof mark !== 'object') return null
  const where = mark.row != null ? inMessage(message) : ''
  if (mark.kind === 'explain' || mark.kind === 'heads') {
    const term = oneLine(mark.term, 80)
    if (!term) return null
    if (mark.kind === 'heads') return { key: `heads|${mark.row ?? ''}|${term}`, text: `- They opened the heads-up "${oneLine(mark.title || term, 80)}" on "${term}"${where}.` }
    return { key: `explain|${mark.row ?? ''}|${term}`, text: `- They opened the explainer of "${term}"${where}.` }
  }
  if (mark.kind !== 'citation') return null
  const words = oneLine(mark.words, 80)
  if (!words) return null
  const found = checkWords(mark.status, mark.failedBy)
  return { key: `cite|${mark.row ?? ''}|${mark.n ?? words}`, text: `- They opened the citation "${words}"${where}${found ? `; ${found}` : ''}.` }
}

export function askedLine(ask) {
  const q = oneLine(ask && ask.text, 300)
  if (!q) return null
  const on = oneLine((ask && ask.about) || 'the panel', 80)
  return { key: `ask|${q}`, text: `- They asked a side thread about ${on}, which a side agent answers there: "${q}"` }
}

/** The explainers and heads-ups (explain/seam.ts Gloss) thimble shows on a message, in words for Claude: each one's
 *  words, so Claude knows what the analyst was told beside its answer; which ones they opened comes with what they did
 *  on screen (openedLine). '' when there is none. */
export function commentsText(items, message = '') {
  const lines = (items || []).filter(g => g && oneLine(g.term)).map(g => {
    const says = g.kind === 'heads' ? [g.title, ...(g.bullets || [])] : [g.body, g.here]
    const what = oneLine(says.filter(Boolean).join(' '), 800)
    return `- ${g.kind === 'heads' ? 'A heads-up' : 'An explainer'} on "${oneLine(g.term, 80)}": ${what}`
  })
  if (!lines.length) return ''
  return [`thimble showed the analyst these comments${inMessage(message)}, each a highlight on its words that they read when they open it. They tell you what the analyst was told beside your answer; none of them asks anything of you.`, ...lines].join('\n')
}
