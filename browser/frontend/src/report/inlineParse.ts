// The inline markdown of a stored sentence as a small tree: code spans, emphasis, links and `[[…]]` citation tokens
// (a bare `card:<id>` too). Pure, so the editor's block conversions and a test run it under Node.
import { BARE_SRC } from '../chat/markdown'
import { splitValueRef } from '../lib/refs'

const REF_SRC = String.raw`\[\[([^\[\]\n]+?)\]\]`
const INLINE_RE = new RegExp(
  [
    String.raw`\\([\\\x60*_\[\]()])`,
    REF_SRC,
    BARE_SRC,
    String.raw`(\x60+)([^\x60\n]+?)\4`,
    String.raw`\[([^\[\]\n]+?)\]\(([^\s()]+)\)`,
    String.raw`\*\*(?=\S)([^\n]+?)(?<=\S)\*\*`,
    String.raw`(?<!\w)__(?=\S)([^\n]+?)(?<=\S)__(?!\w)`,
    String.raw`(?<!\w)\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?!\w)`,
    String.raw`(?<!\w)_(?=[^\s_])([^_\n]+?)(?<=\S)_(?!\w)`,
  ].join('|'),
  'g',
)
const REF_RE = new RegExp(REF_SRC, 'g')
/** The schemes a link may use; a link with any other (javascript:, data:) stays its own text. */
const LINK_SCHEME = /^(https?|mailto):/i

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: string; value?: string; bare?: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: InlineNode[] }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }

/** A code span's nodes: a ref inside backticks is a chip, never code; backticks around refs alone are dropped. */
function codeNodes(content: string): InlineNode[] {
  const out: InlineNode[] = []
  let last = 0
  for (const m of content.matchAll(REF_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'code', text: content.slice(last, at) })
    out.push({ kind: 'ref', ...splitValueRef(m[1].trim()) })
    last = at + m[0].length
  }
  if (last < content.length) out.push({ kind: 'code', text: content.slice(last) })
  if (out.some((n) => n.kind === 'ref') && out.every((n) => n.kind === 'ref' || (n.kind === 'code' && /^[\s,;]*$/.test(n.text)))) return out.map((n) => (n.kind === 'code' ? { kind: 'text', text: n.text } : n))
  return out
}

/** the space a writer leaves between a citation and the sentence's punctuation (`[[ref]] .`) is dropped */
const SPACE_BEFORE_PUNCT = /^\s+(?=[.,;:!?])/

export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = []
  let last = 0
  const push = (t: string) => {
    const prev = out[out.length - 1]
    if (prev && prev.kind === 'ref') t = t.replace(SPACE_BEFORE_PUNCT, '')
    if (!t) return
    if (prev && prev.kind === 'text') prev.text += t
    else out.push({ kind: 'text', text: t })
  }
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0
    if (at > last) push(text.slice(last, at))
    last = at + m[0].length
    if (m[1] != null) push(m[1])
    else if (m[2] != null) out.push({ kind: 'ref', ...splitValueRef(m[2].trim()) })
    else if (m[3] != null) out.push({ kind: 'ref', ref: m[3], bare: true })
    else if (m[5] != null) out.push(...codeNodes(m[5]))
    else if (m[6] != null) {
      if (LINK_SCHEME.test(m[7])) out.push({ kind: 'link', href: m[7], children: parseInline(m[6]) })
      else push(m[0])
    }
    else if (m[8] != null) out.push({ kind: 'strong', children: parseInline(m[8]) })
    else if (m[9] != null) out.push({ kind: 'strong', children: parseInline(m[9]) })
    else if (m[10] != null) out.push({ kind: 'em', children: parseInline(m[10]) })
    else if (m[11] != null) out.push({ kind: 'em', children: parseInline(m[11]) })
  }
  if (last < text.length) push(text.slice(last))
  return out
}
