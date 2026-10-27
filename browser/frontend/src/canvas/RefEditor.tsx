// A takeaway as the analyst edits it: text, with each cited number, bare ref and claim's mark (`[words](#)`, which a
// takeaway's numbers are mostly written as) as a token the caret cannot enter, so it deletes whole. On save every token
// is written back as the markup it came from. The field is a contenteditable built once from the markup and read back
// from its nodes (never re-rendered while open), so the browser's editing and React do not fight over it. Enter keeps
// the text, Shift+Enter breaks the line, Escape reverts. A paste is plain text. There is no spell check: a takeaway names
// the data's own words (files, fields, values), which a spell check marks as typos.
import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { marksIn } from '../../../../plugin/marks/message.js'
import { BARE_SRC } from '../chat/markdown'
import { Icon, type IconName } from '../components/Icon'
import { compactLabel, refIcon, refTone } from '../components/RefChip'
import { FILE_GLYPHS } from '../lib/fileGlyph'
import { splitValueRef } from '../lib/refs'

const BRACKET_SRC = String.raw`\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+?)\]\]`
const TOKEN_RE = new RegExp(`${BRACKET_SRC}|${BARE_SRC}`, 'g')
/** the glyphs a token may carry, drawn once by React in a hidden template and copied into the tokens */
const GLYPHS: IconName[] = [...new Set<IconName>(['cell', 'group', 'label', 'thread', 'file', 'report', 'view', 'cite', 'terminal', ...FILE_GLYPHS])]

/** One run of the markup: text as it is, or a token with the markup it came from: a ref, with the value it cites, or a
 * claim's mark, its words the value, with no ref. */
export type RefPart = { text: string } | { raw: string; ref: string | null; value?: string }

/** The markup cut into text and tokens (`[[value|ref]]`, `[[ref]]`, a bare `card:<id>`, a mark `[words](#)`, found as
 * plugin/marks/message.js finds them), in order; a ref inside a mark's words stays in the mark. */
export function refParts(markup: string): RefPart[] {
  const tokens: { at: number; end: number; part: RefPart }[] = marksIn(markup).map((m) => ({ at: m.start, end: m.end, part: { raw: markup.slice(m.start, m.end), ref: null, value: m.words.replace(/\*\*|__|`/g, '') } }))
  const marks = tokens.slice()
  for (const m of markup.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0
    const end = at + m[0].length
    if (marks.some((k) => at < k.end && end > k.at)) continue
    const tok = m[1] != null ? splitValueRef(m[1].trim()) : { ref: m[2] }
    tokens.push({ at, end, part: { raw: m[0], ref: tok.ref, value: tok.value } })
  }
  tokens.sort((a, b) => a.at - b.at)
  const out: RefPart[] = []
  let last = 0
  for (const t of tokens) {
    if (t.at > last) out.push({ text: markup.slice(last, t.at) })
    out.push(t.part)
    last = t.end
  }
  if (last < markup.length) out.push({ text: markup.slice(last) })
  return out
}

/** The markup read back from the field's nodes: text as typed, each token as the markup it came from. */
export function markupOf(root: Node): string {
  let out = ''
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent ?? ''
      else if (c instanceof HTMLElement) {
        if (c.dataset.raw != null) out += c.dataset.raw
        else if (c.tagName === 'BR') out += '\n'
        else {
          // a line the browser wrapped in a block of its own
          if ((c.tagName === 'DIV' || c.tagName === 'P') && out && !out.endsWith('\n')) out += '\n'
          walk(c)
        }
      }
    }
  }
  walk(root)
  return out
}

function glyph(tpl: HTMLElement | null, name: IconName): Node | null {
  return tpl?.querySelector(`.icon-${name}`)?.cloneNode(true) ?? null
}

/** A token's element: a cited number or a mark's words as the card draws them (the words themselves, underlined as a
 * citation), a bare ref as its chip (RefChip refTone). */
function tokenEl(part: Extract<RefPart, { raw: string }>, tpl: HTMLElement | null): HTMLElement {
  const el = document.createElement('span')
  el.contentEditable = 'false'
  el.dataset.raw = part.raw
  if (part.ref != null) el.dataset.ref = part.ref
  if (part.value != null || part.ref == null) {
    el.className = 'refedit-token refchip refchip-value refchip-citation'
    el.append(part.value ?? '')
  } else {
    el.className = `refedit-token chip chip-ref chip-tone-${refTone(part.ref)}`
    const g = glyph(tpl, refIcon(part.ref)) as Element | null
    if (g) {
      g.classList.add('chip-ico')
      el.append(g)
    }
    const text = document.createElement('span')
    text.className = 'chip-text'
    text.textContent = compactLabel(part.ref)
    el.append(text)
  }
  return el
}

export interface RefEditorProps {
  value: string
  onDone: (value: string) => void
  className?: string
  label: string
  /** where the click that opened it landed: the caret goes there, else to the end */
  at?: { x: number; y: number } | null
  /** Enter breaks the line instead of keeping the text (Shift+Enter always breaks it) */
  multiline?: boolean
}

export function RefEditor({ value, onDone, className, label, at, multiline = false }: RefEditorProps) {
  const el = useRef<HTMLDivElement>(null)
  const tpl = useRef<HTMLSpanElement>(null)
  const gone = useRef(false)
  const start = useRef(value)

  // built once: what the analyst types lives in the nodes until the field is left
  useLayoutEffect(() => {
    const root = el.current
    if (!root) return
    root.replaceChildren(...refParts(start.current).map((p) => ('text' in p ? document.createTextNode(p.text) : tokenEl(p, tpl.current))))
    root.focus()
    const sel = window.getSelection()
    if (!sel) return
    let range: Range | null = null
    if (at && typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(at.x, at.y)
      if (r && root.contains(r.startContainer)) range = r
    }
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(root)
      range.collapse(false)
    }
    sel.removeAllRanges()
    sel.addRange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // once it unmounts, a late blur keeps nothing (set again on mount, for StrictMode's second mount)
  useEffect(() => {
    gone.current = false
    return () => void (gone.current = true)
  }, [])

  const finish = (keep: boolean) => {
    if (gone.current) return
    gone.current = true
    onDone(keep && el.current ? markupOf(el.current) : start.current)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      // a line break as a character: the field is pre-wrap, so the text stays one run of nodes
      if (e.shiftKey || multiline) document.execCommand('insertText', false, '\n')
      else finish(true)
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (text) document.execCommand('insertText', false, text)
  }
  return (
    <>
      <div
        ref={el}
        className={`refedit${className ? ` ${className}` : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        spellCheck={false}
        onKeyDown={onKey}
        onPaste={onPaste}
        onDrop={(e) => e.preventDefault()}
        onBlur={() => finish(true)}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      <span ref={tpl} hidden aria-hidden="true">
        {GLYPHS.map((g) => (
          <Icon key={g} name={g} size={10} />
        ))}
      </span>
    </>
  )
}
