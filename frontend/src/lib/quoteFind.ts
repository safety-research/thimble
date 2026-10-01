// Finding the words a citation quotes inside its record: a quoted span in a table cell (files/views/table.tsx), and the
// words in quotation marks of an inline citation's text, which a click turns into a span ref of its record
// (components/RefChip.tsx), so the File browser and views open at those words with them highlighted.
import type { ResolvedRef } from './types'

/** Where `quote` sits in `text`, as [start, end) string offsets: as written; else as JSON writes it inside a string (a
 * record whose text is its raw JSON line); else as the plain text a JSON string body reads as; else with every run of
 * white space read as one space and case ignored, since a quote folds line breaks. Null when it is not there. Pure. */
export function findQuote(text: string, quote: string): [number, number] | null {
  const q = quote.trim()
  if (!q || !text) return null
  for (const form of quoteForms(q)) {
    const at = text.indexOf(form)
    if (at >= 0) return [at, at + form.length]
  }
  return looseFind(text, q)
}

function quoteForms(q: string): string[] {
  const escaped = JSON.stringify(q).slice(1, -1)
  const ascii = escaped.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  let plain: string | null = null
  if (q.includes('\\')) {
    try {
      plain = JSON.parse(`"${q}"`) as string
    } catch {
      plain = null
    }
  }
  return [...new Set([q, escaped, ascii, ...(plain ? [plain] : [])])]
}

function looseFind(text: string, q: string): [number, number] | null {
  const kept: number[] = []
  let folded = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (folded && !folded.endsWith(' ')) {
        folded += ' '
        kept.push(i)
      }
      continue
    }
    const low = ch.toLowerCase()
    folded += low.length === 1 ? low : ch
    kept.push(i)
  }
  const needle = q.split(/\s+/).join(' ').toLowerCase()
  const at = folded.indexOf(needle)
  if (at < 0) return null
  return [kept[at], kept[at + needle.length - 1] + 1]
}

const QUOTED = /["“„«]([^"“”„«»]{3,}?)["”“»]|‘([^‘’]{3,}?)’/g

/** The words a citation's text quotes, in quotation marks, longest first, then the whole text. Pure. */
export function quotedWords(value: string): string[] {
  const inside: string[] = []
  for (const m of value.matchAll(QUOTED)) {
    const w = (m[1] ?? m[2] ?? '').trim()
    if (w.length >= 3) inside.push(w)
  }
  const whole = value.trim()
  return [...new Set([...inside.sort((a, b) => b.length - a.length), ...(whole.length >= 8 ? [whole] : [])])]
}

/** The span ref (`<path>#L<n>.b<k>:c<a>-<b>`) of the first of the words a citation's text quotes that its record holds,
 * from the record as resolveRef answers it; null when the ref is no whole record of a file's line or the record holds
 * none of them. Pure. */
export function quoteSpanRef(r: ResolvedRef, value: string): string | null {
  if (r.kind !== 'record' || !r.path || r.line == null || !r.blocks?.length) return null
  for (const words of quotedWords(value)) {
    for (let k = 0; k < r.blocks.length; k++) {
      const at = findQuote(r.blocks[k].text ?? '', words)
      if (at) return `${r.path}#L${r.line}.b${k}:c${at[0]}-${at[1]}`
    }
  }
  return null
}
