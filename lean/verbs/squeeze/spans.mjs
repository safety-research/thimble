// spans.mjs: cut an original into spans, the units a squeezed line can come from, each with a stable id.
//
// Text (Markdown) is cut into blocks (a paragraph, a list item, a heading, a table row, a code block) and each
// paragraph or item into sentences. A span's id is `<block>.<sentence>`, both from 1, so the same text always gets
// the same ids: "3.2" is the second sentence of the third block. An original that already has units (a session's
// turns, a run's steps) keeps its own ids and needs no cutting: pass them as `units`.
//
//   cut(text)            -> {spans: [{id, b, kind, text, cites}], blocks: [{b, kind, lead, spans: [id]}]}
//   expand(from, spans)  -> span ids in document order, with ranges ("2.1-2.4") opened
//   plain(md)            -> the words of a bit of Markdown, without its marks
//   numbered(spans)      -> the spans as the model reads them: one "[id] text" per line
//
// No imports and no Node: this runs in a hooks module too.

const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|Mr|Ms|Dr|St|No|Fig|Eq|al|Inc|Ltd|U\.S)\.$/i

/** The refs a span cites: the targets of its Markdown links that are not web addresses. */
function citesOf(text) {
  const out = []
  const re = /\[[^\]\n]*\]\(([^)\s]+)\)/g
  let m
  while ((m = re.exec(text))) if (!/^(https?:|mailto:|#)/.test(m[1]) && !out.includes(m[1])) out.push(m[1])
  return out
}

/** Sentences of one paragraph: split after . ! ? (and a closing quote or bracket) before a capital, a digit, a mark or
 *  a quote, never inside `code` or a [link](...), never after a common abbreviation or between the digits of a number. */
export function sentences(text) {
  const t = String(text).replace(/\s*\n\s*/g, ' ').trim()
  if (!t) return []
  // mask code spans and links so their dots and spaces do not split
  const masks = []
  const masked = t.replace(/`[^`]*`|\[[^\]\n]*\]\([^)\s]*\)/g, s => { masks.push(s); return `\u0000${masks.length - 1}\u0000` })
  const out = []
  let start = 0
  const re = /([.!?]["”’')\]*_]*)(\s+)(?=["“‘(\[*_`\u0000]|[A-Z0-9])/g
  let m
  while ((m = re.exec(masked))) {
    const head = masked.slice(start, m.index + m[1].length)
    if (ABBREV.test(head.slice(-12))) continue
    if (/\s[A-Z]\.$/.test(head)) continue // an initial, as in "J. Smith"
    out.push(head)
    start = m.index + m[0].length
  }
  out.push(masked.slice(start))
  return out.map(s => s.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)]).trim()).filter(Boolean)
}

/** Cut Markdown text into blocks and spans. */
export function cut(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  const spans = []
  let para = null // {kind, lead, lines: []}
  const add = (kind, lead, parts) => {
    const b = blocks.length + 1
    const ids = []
    parts.forEach((p, i) => {
      const id = `${b}.${i + 1}`
      spans.push({ id, b, kind, text: p, cites: citesOf(p) })
      ids.push(id)
    })
    if (ids.length) blocks.push({ b, kind, lead, spans: ids })
  }
  const flush = () => {
    if (!para) return
    const body = para.lines.join('\n')
    add(para.kind, para.lead, para.kind === 'quote' || para.kind === 'p' || para.kind === 'li' ? sentences(body) : [body.trim()])
    para = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const body = [line]
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      if (i < lines.length) body.push(lines[i])
      add('code', '', [body.join('\n')])
      continue
    }
    if (!line.trim()) { flush(); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { flush(); add('h', h[1] + ' ', [h[2].trim()]); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue // the row under a table's header
      add('row', '', [line.trim()])
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue } // a rule
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) { flush(); para = { kind: 'li', lead: li[1] + li[2] + ' ', lines: [li[3]] }; continue }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      if (!para || para.kind !== 'quote') { flush(); para = { kind: 'quote', lead: '> ', lines: [] } }
      para.lines.push(q[1])
      continue
    }
    if (para && (para.kind === 'p' || (para.kind === 'li' && /^\s+\S/.test(line)))) { para.lines.push(line); continue }
    flush()
    para = { kind: 'p', lead: '', lines: [line] }
  }
  flush()
  return { spans, blocks }
}

/** Span ids in document order, from a list of ids and ranges ("2.1", "2.1-2.4", "3"), unknown ids left out. A bare
 *  block number names every span of the block. */
export function expand(from, spans) {
  const order = new Map(spans.map((s, i) => [s.id, i]))
  const picked = new Set()
  const at = id => {
    if (order.has(id)) return [order.get(id)]
    if (/^\d+$/.test(id)) return spans.map((s, i) => (String(s.b) === id || s.id.split('.')[0] === id ? i : -1)).filter(i => i >= 0)
    return []
  }
  for (const raw of Array.isArray(from) ? from : [from]) {
    const f = String(raw == null ? '' : raw).trim().replace(/^\[|\]$/g, '')
    if (!f) continue
    const m = /^([\w.:-]+?)\s*(?:-|–|\.\.)\s*([\w.:-]+)$/.exec(f)
    if (m && (at(m[1]).length && at(m[2]).length)) {
      const a = Math.min(...at(m[1])), b = Math.max(...at(m[2]))
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.add(i)
      continue
    }
    for (const i of at(f)) picked.add(i)
  }
  return [...picked].sort((a, b) => a - b).map(i => spans[i].id)
}

/** The words of a bit of Markdown: links keep their words, code its text, emphasis marks go. */
export function plain(md) {
  return String(md == null ? '' : md)
    .replace(/^```[^\n]*\n?|\n?```$/g, '')
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The spans as the model reads them, one per line: "[3.2] text". A code block keeps its lines. */
export function numbered(spans) {
  return spans.map(s => `[${s.id}] ${s.kind === 'h' ? '(heading) ' : ''}${s.text}`).join('\n')
}

/** Lines of text an original takes, as a person reads it (for "2 of 41 lines"). */
export function lineCount(text) {
  return String(text == null ? '' : text).split('\n').filter(l => l.trim()).length
}
