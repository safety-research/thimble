// marks.tsx: one of Claude's messages as the chat draws it, from its record (CONTRACT 1): the markdown as 0.9 sets it
// (react-markdown with GFM, in .chat-text), with its marks in place.
//
//   cite      0.9's citation: purple, underlined; a click opens its source card in the bottom panel
//   explain   a term the observer explains (a "gloss" in the record): teal, dotted; a click opens its explainer card
//   spark     a citation of a series, drawn inline as small bars
//
// A mark's offsets are in the shown text (`shown`, else `text`). Each mark becomes a link `[words](#m<i>)` before the
// markdown is parsed, so it never breaks the markdown around it; the link renderer draws it as the mark. A link to a
// kernel ref that no mark covers is drawn as a citation too, so a message whose record has no marks still reads right.
import { createContext, useContext, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Mark, MessageRecord } from './store'

const KERNEL_REF = /^(?:obj:[A-Za-z0-9][\w.-]*#|q\d+(?:#|@|$)|[^\s#]+#(?:L\d|r\d|\/|[A-Za-z_]))/
/** Whether a string reads as a kernel ref (shell/object.js isRef, plus a spark's series q4@n). */
export const isRef = (s: unknown): s is string => typeof s === 'string' && s.length < 2000 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && KERNEL_REF.test(s)

export interface Prepared extends Mark {
  label: string
  body?: { term?: string; title?: string; body?: string; program?: string; data?: unknown; refs?: string[] } | null
}

const LINK_ONE = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/
const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const plainWords = (s: string) => String(s).replace(/\*\*|__|`/g, '')
const bracketSafe = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')')

/** The record's text as markdown with each mark as a `#m<i>` link, and the marks, checked and in order. */
export function prepare(record: Pick<MessageRecord, 'text' | 'shown' | 'marks' | 'glosses'> | null | undefined): { md: string; marks: Prepared[] } {
  const text = String(record?.shown ?? record?.text ?? '')
  const glosses = record?.glosses || {}
  const marks: Prepared[] = []
  let out = ''
  let at = 0
  for (const m of [...(record?.marks || [])].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
    if (!m || !Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number) < at || (m.end as number) <= (m.start as number) || (m.end as number) > text.length) continue
    const raw = text.slice(m.start, m.end)
    const link = LINK_ONE.exec(raw)
    const i = marks.length
    let words = link ? link[1] : raw
    if (m.kind === 'cite') marks.push({ ...m, ref: m.ref || link?.[2], label: m.label || plainWords(words) })
    else if (m.kind === 'gloss' || m.kind === 'explain') marks.push({ ...m, kind: 'gloss', label: plainWords(words), body: (m.gloss && glosses[m.gloss]) || null })
    else if (m.kind === 'spark') {
      marks.push({ ...m, ref: m.ref || link?.[2], label: '~' })
      words = '~'
    } else continue
    out += text.slice(at, m.start) + `[${bracketSafe(words)}](#m${i})`
    at = m.end as number
  }
  out += text.slice(at)
  // links to kernel refs that no mark covers: citations too
  out = out.replace(LINK, (all, label: string, ref: string) => {
    if (ref.startsWith('#m') || !isRef(ref)) return all
    const i = marks.length
    marks.push(label.trim() === '~' ? { kind: 'spark', ref, label: '~', values: null } : { kind: 'cite', ref, label: plainWords(label) })
    return `[${label}](#m${i})`
  })
  return { md: out, marks }
}

/** Small bars of a series, inline. */
export function Spark({ values, h = 13 }: { values: number[]; h?: number }) {
  const vals = values.map((v) => (typeof v === 'number' && isFinite(v) ? v : 0))
  const bw = 3.5
  const gap = 1.5
  const lo = Math.min(0, ...vals)
  const hi = Math.max(...vals)
  const w = vals.length * (bw + gap) - gap
  return (
    <svg className="lean-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {vals.map((v, i) => {
        const hh = Math.max(1.5, ((v - lo) / (hi - lo || 1)) * (h - 1))
        return <rect key={i} className={v ? undefined : 'z'} x={i * (bw + gap)} y={h - hh} width={bw} height={hh} rx={0.8} />
      })}
    </svg>
  )
}

/** What a mark in the text does: open it (in the bottom panel), and whether it is the one in focus. */
export interface MarkHost {
  marks: Prepared[]
  onOpen: (i: number) => void
  focus: number | null
  /** the side thread asked about mark i, if any: a ↳ after the mark opens it */
  threadOf?: (i: number) => { id: string; open: () => void } | null
}
const MarkCtx = createContext<MarkHost | null>(null)

function MarkLink({ i, children }: { i: number; children: ReactNode }) {
  const host = useContext(MarkCtx)
  const m = host?.marks[i]
  if (!m) return <>{children}</>
  const on = host!.focus === i
  const open = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    host!.onOpen(i)
  }
  if (m.kind === 'spark') {
    return (
      <button type="button" className={`lean-mark lean-mark-spark${on ? ' is-focus' : ''}`} data-mark={i} onClick={open} title={m.ref}>
        {m.values?.length ? <Spark values={m.values} /> : '~'}
      </button>
    )
  }
  if (m.kind === 'gloss') {
    return (
      <>
        <button type="button" className={`lean-mark lean-mark-explain${on ? ' is-focus' : ''}`} data-mark={i} onClick={open} title="explain">
          {children}
        </button>
        <ThreadArrow i={i} />
      </>
    )
  }
  return (
    <>
      <button type="button" className={`refchip refchip-value refchip-citation lean-mark lean-mark-cite${on ? ' is-focus' : ''}`} data-mark={i} onClick={open} title={m.ref}>
        {children}
      </button>
      <ThreadArrow i={i} />
    </>
  )
}

function ThreadArrow({ i }: { i: number }) {
  const host = useContext(MarkCtx)
  const t = host?.threadOf?.(i)
  if (!t) return null
  return (
    <button type="button" className="lean-mark-thread" title="a side thread about this" onClick={(e) => (e.preventDefault(), e.stopPropagation(), t.open())}>
      ↳
    </button>
  )
}

const COMPONENTS = {
  a({ href, children }: { href?: string; children?: ReactNode }) {
    const m = /^#m(\d+)$/.exec(href || '')
    if (m) return <MarkLink i={Number(m[1])}>{children}</MarkLink>
    if (href && /^https?:\/\//.test(href))
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      )
    return <span className="lean-link">{children}</span>
  },
  img() {
    return null
  },
}

/** Markdown as 0.9's chat sets it, with the marks of `host` live. */
export function MarkedText({ md, host }: { md: string; host: MarkHost | null }) {
  return (
    <MarkCtx.Provider value={host}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS as any} urlTransform={(u) => u}>
        {md}
      </Markdown>
    </MarkCtx.Provider>
  )
}

/** Text whose kernel-ref links are citations that open with `onCite` (a takeaway, a thread's answer, a doc). */
export function CitedText({ text, onCite }: { text: string; onCite?: (ref: string, label: string) => void }) {
  const p = prepare({ text, marks: [] })
  const host: MarkHost = { marks: p.marks, focus: null, onOpen: (i) => onCite?.(p.marks[i].ref || '', p.marks[i].label) }
  return <MarkedText md={p.md} host={host} />
}

/** Plain words of a text, its links as their words. */
export function plain(text: string): string {
  return String(text || '')
    .replace(LINK, (_a, label) => label)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}
