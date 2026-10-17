// The syntax of a line of markdown (a heading's or a quote's lead, the marks of code, links, bold and italic) and the
// line's words without it, as the Transcript mode shows a markdown chat log (bug hunt B20) and an example card quotes
// one of its lines (bug hunt D9). Pure.

// a markdown line's syntax: a heading's or a quote's lead, and inline the marks of code, a link (its target too), bold
// and italic, as a reader of the rendered text would not see them
const MD_LEAD = /^\s{0,3}(?:#{1,6}\s+|>\s?)/
const MD_INLINE = /(`[^`\n]+`)|(\[[^[\]\n]*\]\([^()\s]*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?<![\w*])\*[^*\s][^*\n]*\*(?!\w)|(?<![\w_])_[^_\s][^_\n]*_(?!\w))/g

/** The ranges of a markdown line that are its syntax (mdSyntax's), in order. Pure. */
export function mdSyntax(line: string): [number, number][] {
  const out: [number, number][] = []
  const lead = MD_LEAD.exec(line)?.[0] ?? ''
  if (lead) out.push([0, lead.length])
  inlineSyntax(line, lead.length, line.length, out)
  return out.sort((a, b) => a[0] - b[0])
}

function inlineSyntax(line: string, from: number, to: number, out: [number, number][]): void {
  for (const m of line.slice(from, to).matchAll(MD_INLINE)) {
    const a = from + (m.index ?? 0)
    const b = a + m[0].length
    if (m[1]) out.push([a, a + 1], [b - 1, b])
    else if (m[2]) {
      const close = a + m[0].indexOf('](')
      out.push([a, a + 1], [close, b])
      inlineSyntax(line, a + 1, close, out)
    } else {
      const w = m[3] ? 2 : 1
      out.push([a, a + w], [b - w, b])
      inlineSyntax(line, a + w, b - w, out)
    }
  }
}

/** A markdown line's words from `from` up to `to`, without its syntax (mdSyntax). Pure. */
export function plainMd(text: string, from = 0, to = text.length): string {
  let out = ''
  let at = from
  for (const [a, b] of mdSyntax(text)) {
    if (b <= at) continue
    if (a >= to) break
    if (a > at) out += text.slice(at, a)
    at = b
  }
  return at < to ? out + text.slice(at, to) : out
}
