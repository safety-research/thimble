// One quoted record's parts (canvas/quotes) drawn: its text with its lines kept, code and tool output in mono, a tool
// call under its tool's name, a JSON record's fields, a passage with the words around it (.hl). A quote is never drawn
// as markdown, so `#`, `*` or `[...]` show as the record wrote them. A citation's words found in the record are
// highlighted, and the record's facts sit over it in one line (RecordFacts).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { cutExcerpt } from './excerpts'
import type { FactKind, RecordFact } from './facts'
import type { QuotePart } from './quotes'

/** the characters of one part a quote draws (the clamp shows far less; Show all shows this much) */
const PART_MAX = 20000
const cap = (t: string) => cutExcerpt(t, PART_MAX)

/** A part's text as drawn, with the claim's words in it highlighted when they fall inside what is drawn. */
function markedText(text: string, mark?: [number, number]): ReactNode {
  const shown = cap(text)
  if (!mark || mark[1] > shown.length || mark[0] >= mark[1]) return shown
  return (
    <>
      {shown.slice(0, mark[0])}
      <span className="hl">{shown.slice(mark[0], mark[1])}</span>
      {shown.slice(mark[1])}
    </>
  )
}

const FACT_ICON: Record<FactKind, IconName> = { time: 'clock', who: 'person', where: 'doc' }
const FACT_WORD: Record<FactKind, string> = { time: 'Time', who: 'By', where: 'In' }

/** A record's facts in one line: its time as the record wrote it, who wrote it, where it belongs, each after its glyph;
 * a fact the claim's words name is highlighted as the cited words are. */
export function RecordFacts({ facts, className }: { facts: readonly RecordFact[]; className?: string }) {
  if (!facts.length) return null
  return (
    <div className={`rec-facts${className ? ` ${className}` : ''}`}>
      {facts.map((f) => (
        <span key={f.kind} className={`rec-fact rec-fact-${f.kind}`} aria-label={`${FACT_WORD[f.kind]} ${f.text}`}>
          <Icon name={FACT_ICON[f.kind]} size={11} className="rec-fact-ico" />
          <span className={f.hit ? 'rec-fact-text hl' : 'rec-fact-text'}>{f.text}</span>
        </span>
      ))}
    </div>
  )
}

/** One part of a quoted record (canvas/quotes): prose, code, a tool call, a record's fields, a passage. */
export function QuotePartView({ part }: { part: QuotePart }) {
  switch (part.kind) {
    case 'text':
      return <div className={`bcell-q-text${part.dim ? ' is-dim' : ''}`}>{markedText(part.text, part.mark)}</div>
    case 'code':
      return <pre className="bcell-q-code">{markedText(part.text, part.mark)}</pre>
    case 'tool':
      return (
        <div className="bcell-q-tool">
          <span className="bcell-q-key">{part.name}</span>
          {part.text ? <pre className="bcell-q-code">{cap(part.text)}</pre> : null}
        </div>
      )
    case 'fields':
      return (
        <div className="bcell-q-fields">
          {part.pairs.map(([k, v]) => (
            <span key={k} className="bcell-q-pair">
              <span className="bcell-q-key">{k}</span> {v}
            </span>
          ))}
        </div>
      )
    case 'field':
      return (
        <div className="bcell-q-field">
          <span className="bcell-q-key">{part.key}</span>
          {part.mono ? <pre className="bcell-q-code">{markedText(part.text, part.mark)}</pre> : <div className="bcell-q-text">{markedText(part.text, part.mark)}</div>}
        </div>
      )
    case 'span': {
      const body = (
        <div className={part.mono ? 'bcell-q-code bcell-q-span' : 'bcell-q-text bcell-q-span'}>
          {part.before ? <span className="bcell-q-ctx">{cap(part.before)}</span> : null}
          <span className="bcell-q-passage hl">{cap(part.text)}</span>
          {part.after ? <span className="bcell-q-ctx">{cap(part.after)}</span> : null}
        </div>
      )
      return part.key ? (
        <div className="bcell-q-field">
          <span className="bcell-q-key">{part.key}</span>
          {body}
        </div>
      ) : (
        body
      )
    }
  }
}

/** All of a record's parts, in order. */
export function QuoteParts({ parts }: { parts: readonly QuotePart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <QuotePartView key={i} part={p} />
      ))}
    </>
  )
}

/** A record's parts in a box of at most `max` px, faded at the bottom when they run past it (a hover label, which has no
 * room for a Show all). */
export function QuoteBox({ parts, max, className }: { parts: readonly QuotePart[]; max: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [parts])
  return (
    <div ref={box} className={`${className ?? ''}${clipped ? ' is-clipped' : ''}`} style={{ maxHeight: max }}>
      <QuoteParts parts={parts} />
    </div>
  )
}
