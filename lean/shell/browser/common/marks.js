// marks.js: one of Claude's messages as the browser draws it, from its record (CONTRACT 1): the text, in a small
// subset of markdown, with its marks in place.
//
//   citation   solid underline, the words it links: a click opens its source card in the tray
//   gloss      teal, dotted underline: a click opens its explainer card
//   sparkline  a citation of a series, drawn inline as small bars
//
// A mark's offsets are in the shown text (`shown`, else `text`). A mark may span the link as Claude wrote it
// (`[6,543](q3#…)`) or only its words: both draw the same. A link to a kernel ref that no mark covers is drawn as a
// citation too, so a message whose record has no marks yet still reads as Claude wrote it.
import { esc, fmt } from './base.js'
import { isRef } from '../lib/object.js'

const OPEN = ''
const CLOSE = ''
const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g

const linkWords = raw => { const m = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(raw); return m ? { label: m[1], ref: m[2] } : null }
const plainWords = s => String(s).replace(/\*\*|__|`/g, '')

/** The marks of a record, checked and in order, with what each draws and opens. */
export function prepare(record) {
  const text = String(record?.shown ?? record?.text ?? '')
  const glosses = record?.glosses || {}
  const list = []
  let end = 0
  for (const m of [...(record?.marks || [])].sort((a, b) => a.start - b.start)) {
    if (!m || !Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < end || m.end <= m.start || m.end > text.length) continue
    const raw = text.slice(m.start, m.end)
    const link = linkWords(raw)
    if (m.kind === 'cite') list.push({ ...m, ref: m.ref || link?.ref, label: m.label || link?.label || plainWords(raw) })
    else if (m.kind === 'gloss') list.push({ ...m, label: plainWords(link ? link.label : raw), body: glosses[m.gloss] || null })
    else if (m.kind === 'spark') list.push({ ...m, ref: m.ref || link?.ref, label: '~' })
    else continue
    end = m.end
  }
  // the text with each mark as one token, then the links no mark covers as tokens too
  let out = ''
  let at = 0
  list.forEach((m, i) => { out += text.slice(at, m.start) + OPEN + i + CLOSE; at = m.end })
  out += text.slice(at)
  out = out.replace(LINK, (all, label, ref) => {
    if (!isRef(ref)) return all
    const i = list.length
    list.push(label.trim() === '~' ? { kind: 'spark', ref, label: '~', values: null } : { kind: 'cite', ref, label })
    return OPEN + i + CLOSE
  })
  return { tokens: out, marks: list }
}

/** Small bars of a series, as an inline SVG. */
export function sparkSvg(values, { h = 15, bw = 4, gap = 1.5 } = {}) {
  const vals = (values || []).map(v => (typeof v === 'number' && isFinite(v) ? v : 0))
  if (!vals.length) return ''
  const lo = Math.min(0, ...vals), hi = Math.max(...vals)
  const w = vals.length * (bw + gap) - gap
  const bars = vals.map((v, i) => {
    const hh = Math.max(1.5, ((v - lo) / (hi - lo || 1)) * (h - 1))
    return `<rect${v ? '' : ' class="z"'} x="${(i * (bw + gap)).toFixed(1)}" y="${(h - hh).toFixed(1)}" width="${bw}" height="${hh.toFixed(1)}" rx="0.8"/>`
  }).join('')
  return `<svg class="spk" width="${w.toFixed(1)}" height="${h}" viewBox="0 0 ${w.toFixed(1)} ${h}" aria-hidden="true">${bars}</svg>`
}

function markHtml(m, i, on) {
  if (m.kind === 'spark') {
    const title = m.values ? `${m.values.length} values · ${m.ref || ''}` : m.ref || ''
    return m.values ? `<span class="mk spark${on === i ? ' on' : ''}" data-m="${i}" title="${esc(title)}">${sparkSvg(m.values)}</span>` : `<span class="mk cite${on === i ? ' on' : ''}" data-m="${i}">~</span>`
  }
  return `<span class="mk ${m.kind}${on === i ? ' on' : ''}" data-m="${i}">${esc(m.label)}</span>`
}

// ---------------------------------------------------------------- a small markdown
function inline(s) {
  // s is escaped already; code spans first, so nothing inside them is read as markup
  const codes = []
  s = s.replace(/`([^`\n]+)`/g, (a, c) => { codes.push(c); return `${codes.length - 1}` })
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
  return s.replace(/(\d+)/g, (a, i) => `<code>${codes[Number(i)]}</code>`)
}

function table(lines) {
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const rows = lines.filter(l => !/^\s*\|?\s*:?-{2,}/.test(l)).map(cells)
  const [head, ...body] = rows
  const num = c => /^[\d,.\s%~+−-]+$/.test(c.replace(/<[^>]+>|\d+/g, '1'))
  return `<table class="md"><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td${num(c) ? ' class="n"' : ''}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

/** Markdown (escaped first) to HTML: paragraphs, headings, lists, quotes, code blocks and tables. */
export function markdown(src) {
  const lines = esc(src).split('\n')
  const out = []
  let para = []
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l)) {
      flush()
      const code = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push(`<pre><code>${code.join('\n')}</code></pre>`)
      continue
    }
    if (!l.trim()) { flush(); continue }
    const h = /^(#{1,4})\s+(.*)$/.exec(l)
    if (h) { flush(); out.push(`<h4 class="h${h[1].length}">${inline(h[2])}</h4>`); continue }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      flush()
      const t = []
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) t.push(lines[i])
      i--
      out.push(table(t))
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      flush()
      const ordered = /^\s*\d+[.)]\s+/.test(l)
      const items = []
      for (; i < lines.length && (/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (m) items.push({ deep: m[1].length >= 2, text: m[3] })
        else items[items.length - 1].text += ' ' + lines[i].trim()
      }
      i--
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li${it.deep ? ' class="deep"' : ''}>${inline(it.text)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (/^&gt;\s?/.test(l)) { flush(); out.push(`<blockquote>${inline(l.replace(/^&gt;\s?/, ''))}</blockquote>`); continue }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { flush(); out.push('<hr>'); continue }
    para.push(l.trim())
  }
  flush()
  return out.join('')
}

/** A record as HTML, and its marks (index = the `data-m` of each mark's element). `on`: the mark drawn lit. */
export function messageHtml(record, { on = -1 } = {}) {
  const { tokens, marks } = prepare(record)
  const html = markdown(tokens).replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (a, i) => markHtml(marks[Number(i)], Number(i), on))
  return { html, marks }
}

/** Plain words of a text with its links as their words (a title, a tray line). */
export function plain(text) {
  return String(text || '').replace(LINK, (a, label) => label).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

/** Text with its kernel-ref links as citation marks and nothing else: a takeaway, a thread's answer. */
export function citedHtml(text, { attr = 'data-ref' } = {}) {
  return inline(esc(text).replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (all, label, ref) => {
    const raw = ref.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    return isRef(raw) || raw.startsWith('#') ? `<span class="mk cite" ${attr}="${ref}">${label}</span>` : all
  }))
}

export { fmt }
