// engaged.js: what the person engaged with, in the words of a row Claude reads and the person never sees: an explainer
// or an important detail they opened, a citation they opened, a question they asked in a side thread. Main reads these
// rows with its next request, and the observer's pass, a fork of main's request, reads them in the session too, so
// both learn what this analyst knows and cares about as the session goes on. Pure: no `$`. engaged.ts appends them.
//
//   openedRow(frame, message)  -> {key, text} for a mark the person opened (a tray frame, panes/tray.js frameOf), or null
//   askedRow(ask)              -> {key, text} for a question asked in a side thread (thread.ts askThread's ask), or null
// `key` names what was engaged with, so the same open is told once.

const oneLine = s => String(s || '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
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
    if (g.kind === 'heads') return { key: `heads|${frame.row ?? ''}|${term}`, text: `The analyst opened the important detail "${cut(oneLine(g.title || term), 80)}" on "${term}"${where}.` }
    return { key: `gloss|${frame.row ?? ''}|${term}`, text: `The analyst opened the explainer of "${term}"${where}.` }
  }
  const ref = String(frame.ref || '')
  if (!ref) return null
  const what = frame.kind === 'spark' ? 'the sparkline' : `the citation "${cut(oneLine(frame.label || ref), 80)}"`
  return { key: `cite|${frame.row ?? ''}|${ref}`, text: `The analyst opened ${what} (${ref})${where}.` }
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
  return { key: `ask|${q}`, text: `The analyst asked a side thread about ${on}, which a side agent answers there: "${q}"` }
}
