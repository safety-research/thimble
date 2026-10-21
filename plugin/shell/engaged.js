// engaged.js: what the person engaged with, in the words of a row Claude reads and the person never sees: an explainer
// or an important detail they opened, a citation they opened, a question they asked in a side thread. The row goes in
// with the analyst's next prompt (engaged.ts), so main reads it with that prompt, and the observer's pass, a fork of
// main's request, reads it in the session too: both learn what this analyst knows and cares about as the session goes
// on. Pure: no `$`.
//
//   openedRow(frame, message)  -> {key, text} for a mark the person opened (a tray frame, panes/tray.js frameOf), or null;
//                                 a citation's row names its ref as written and what the citation check found there
//   askedRow(ask)              -> {key, text} for a question asked in a side thread (thread.ts askThread's ask), or null
//   engagedText(lines)         -> the row: what it is for, then each line
// `key` names what was engaged with, so the same open is told once.
import { lineOf as oneLine } from './message.js'

const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** Where a mark stands, in a few words: the message's first words, cut where a word ends. */
const inMessage = message => {
  const all = oneLine(message)
  const words = all.length <= 60 ? all : `${all.slice(0, 60).replace(/\s+\S*$/, '')}…`
  return words ? ` in your message that begins "${words}"` : ''
}

export function openedRow(frame, message = '') {
  if (!frame || typeof frame !== 'object') return null
  const where = frame.row != null ? inMessage(message) : ''
  if (frame.kind === 'gloss') {
    const g = frame.gloss || {}
    const term = cut(oneLine(g.term || frame.label), 80)
    if (!term) return null
    if (g.kind === 'heads') return { key: `heads|${frame.row ?? ''}|${term}`, text: `opened the important detail "${cut(oneLine(g.title || term), 80)}" on "${term}"${where}` }
    return { key: `gloss|${frame.row ?? ''}|${term}`, text: `opened the explainer of "${term}"${where}` }
  }
  // the ref as Claude wrote it (a re-pointed citation opens its new place), and what the check found there, so an
  // open reads as what it is: the person looking, not a doubt about the value
  const ref = String((frame.heal === 'moved' && frame.wrote) || frame.ref || '')
  if (!ref) return null
  const what = frame.kind === 'spark' ? 'the sparkline' : `the citation "${cut(oneLine(frame.label || ref), 80)}"`
  const found = checkWords(frame)
  return { key: `cite|${frame.row ?? ''}|${ref}`, text: `opened ${what} (${ref})${where}${found ? `; ${found}` : ''}` }
}

/** What the citation check found for a citation (its tray frame's `heal`), in words; '' when it has not run. */
function checkWords(frame) {
  const why = cut(oneLine(frame.why || ''), 120)
  switch (frame.heal) {
    case 'kept': return 'the citation check kept it as written'
    case 'moved': return `the citation check re-pointed it to ${frame.ref}`
    case 'bad': return `the citation check found the cited place contradicts it${why ? ` (${why})` : ''}`
    case 'gone': return `the citation check found the cited place gone${why ? ` (${why})` : ''}`
    case 'quiet': return `the citation check unlinked it${why ? ` (${why})` : ''}`
    default: return ''
  }
}

export function askedRow(ask) {
  const q = cut(oneLine(ask && ask.text), 300)
  if (!q) return null
  const s = (ask && ask.scope) || {}
  const card = ask.card && (ask.card.title || ask.card.id)
  const part = String(s.label || s.region || '')
  const on = card
    ? `the card "${cut(oneLine(card), 60)}"${part ? ` (${cut(oneLine(part), 60)})` : ''}`
    : s.mark
      ? `"${cut(oneLine(s.mark.term || s.mark.label || s.mark.ref), 60)}"`
      : `the ${cut(oneLine(s.title || s.pane || 'panel'), 40)} panel${part ? ` (${cut(oneLine(part), 60)})` : ''}`
  return { key: `ask|${q}`, text: `asked a side thread about ${on}, which a side agent answers there: "${q}"` }
}

export function engagedText(lines) {
  return ['What the analyst did on screen since your last reply. It shows what they know and what they care about; none of it asks anything of you.', ...lines.map(l => `- They ${l}.`)].join('\n')
}
