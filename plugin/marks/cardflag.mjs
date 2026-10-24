// cardflag.mjs: a card that still shows a figure the check of its answer corrected (checker.ts flagCards). No `$`:
// the hooks module and the tests import it.
//
//   treeWords(tree)              -> the words a card's drawing shows (the runner's tree of Box, Text and Button nodes,
//                                   {t, p, c}), one line per Box
//   changedFigures(was, now)     -> the numbers of a citation's words as Claude wrote them that its correction no
//                                   longer states (`5,217` of "5,217 pages" corrected to "5,144 pages")
//   staleFigures(text, items)    -> each corrected citation whose changed numbers the card's words still show:
//                                   [{n, was, now, figure}]

/** A number as words state it, its thousands commas dropped. */
const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
const numbers = s => norm(s).match(/\d+(?:\.\d+)?/g) || []

export function treeWords(tree) {
  const out = []
  const walk = n => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (n.t === 'Box') out.push('\n')
    if (typeof n.p?.label === 'string' && n.t === 'Button') out.push(` ${n.p.label} `)
    walk(n.c ?? n.p?.children)
    if (n.t === 'Box') out.push('\n')
  }
  walk(tree)
  return out.join('').replace(/\n{2,}/g, '\n')
}

export function changedFigures(was, now) {
  const kept = new Set(numbers(now))
  // a single digit is too common in a card's words to say it is the same figure
  return [...new Set(numbers(was))].filter(x => !kept.has(x) && (x.length > 1 || Number(x) > 9))
}

export function staleFigures(text, items) {
  const have = new Set(numbers(text))
  const out = []
  for (const m of items || []) {
    if (!m || m.status !== 'corrected' || m.narrowed) continue
    const was = String(m.was ?? m.words ?? '')
    const figure = changedFigures(was, m.shown).find(x => have.has(x))
    if (figure) out.push({ n: m.n, was, now: String(m.shown), figure })
  }
  return out
}
