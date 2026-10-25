// copy.mjs: the cards an answer places on lines of their own (marks/message.js cardRef), as text, for what leaves the
// terminal: /copy's Markdown and /export's text. No `$`, no Node: cards/copy.ts finds the files and the cards' text
// copies (draw.ts cardText).
//
//   cardIdsIn(text)                    the ids of the cards a text names as `(card:<id>)`, in order, once each
//   cardsAsText(text, cards, form)     the text with each paragraph that only places a card replaced by the card:
//                                      its title, then its text copy. `form`: 'markdown' (/copy: `[title](card:<id>)`,
//                                      the card's lines in a code block) or 'export' (/export: Claude Code's drawing
//                                      of that link, `title (card:<id>)`, wrapped, the card's lines at its indent)

const ID = /\(card:(c[0-9a-f]{8,16})\)/g

/** @param {string} text */
export function cardIdsIn(text) {
  return [...new Set([...String(text ?? '').matchAll(ID)].map(m => m[1]))]
}

/**
 * @param {string} text
 * @param {Record<string, {title: string, text: string}>} cards  each card's title and text copy ('' when it has none)
 * @param {'markdown' | 'export'} form
 */
export function cardsAsText(text, cards, form) {
  const paras = String(text ?? '').split(/(\n[ \t]*\n)/)
  return paras.map(p => {
    if (/^\n[ \t]*\n$/.test(p)) return p
    const words = p.replace(/\s+/g, ' ').trim()
    const m = form === 'markdown' ? /^\[([^\]]*)\]\(card:(c[0-9a-f]{8,16})\)$/.exec(words) : /^(.*?) ?\(card:(c[0-9a-f]{8,16})\)$/.exec(words)
    const card = m ? cards[m[2]] : undefined
    if (!m || !card) return p
    const lead = /^\n*([ \t]*)/.exec(p)?.[1] ?? ''
    const title = card.title || m[1]
    const lines = String(card.text || '').replace(/\s+$/, '').split('\n')
    if (form === 'markdown') return [`**${title}**`, ...(card.text ? ['', '```', ...lines, '```'] : [])].join('\n')
    return [`${lead}${title}`, ...(card.text ? ['', ...lines.map(l => (l ? lead + l : l))] : [])].join('\n')
  }).join('')
}
