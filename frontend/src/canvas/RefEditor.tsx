// A takeaway as the analyst edits it: text, with each cited number and bare ref as a token the caret cannot enter, so
// it deletes whole. On save every token is written back as its `[[value|ref]]` markup. The field is a contenteditable
// built once from the markup and read back from its nodes (never re-rendered while open), so the browser's editing and
// React do not fight over it. Enter keeps the text, Shift+Enter breaks the line, Escape reverts. A paste is plain text.
import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { BARE_SRC } from '../chat/markdown'
import { Icon, type IconName } from '../components/Icon'
import { compactLabel, kindIcon, refTone } from '../components/RefChip'
import { parseRef, splitValueRef } from '../lib/refs'

const BRACKET_SRC = String.raw`\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+?)\]\]`
const TOKEN_RE = new RegExp(`${BRACKET_SRC}|${BARE_SRC}`, 'g')
/** the glyphs a token may carry, drawn once by React in a hidden template and copied into the tokens */
const GLYPHS: IconName[] = ['cell', 'group', 'label', 'thread', 'file', 'report', 'view', 'cite']

/** One run of the markup: text as it is, or a ref token with the markup it came from. */
export type RefPart = { text: string } | { raw: string; ref: string; value?: string }

/** The markup cut into text and ref tokens (`[[value|ref]]`, `[[ref]]`, a bare `card:<id>`), in order. */
export function refParts(markup: string): RefPart[] {
  const out: RefPart[] = []
  let last = 0
  for (const m of markup.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: markup.slice(last, at) })
    const tok = m[1] != null ? splitValueRef(m[1].trim()) : { ref: m[2] }
    out.push({ raw: m[0], ref: tok.ref, value: tok.value })
    last = at + m[0].length
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

/** A token's element: a cited number as the card draws it (the number itself, underlined as a citation), a bare ref
 * as its chip (RefChip refTone). */
function tokenEl(part: Extract<RefPart, { raw: string }>, tpl: HTMLElement | null): HTMLElement {
  const el = document.createElement('span')
  el.contentEditable = 'false'
  el.dataset.raw = part.raw
  el.dataset.ref = part.ref
  const icon = kindIcon(parseRef(part.ref)?.kind)
  if (part.value != null) {
    el.className = 'refedit-token refchip refchip-value refchip-citation'
    el.append(part.value)
  } else {
    el.className = `refedit-token chip chip-ref chip-tone-${refTone(part.ref)}`
    const g = glyph(tpl, icon) as Element | null
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
        spellCheck
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
