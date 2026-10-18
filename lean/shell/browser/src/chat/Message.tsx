// Message.tsx: one of Claude's messages in the chat, from its record: the text with its marks (cite, explain, spark),
// the cards its turn saved as 0.9's step row of card chips, then the verb row (v visualize · s squeeze · c claims), dim
// at rest and lit from the record, with "] N marks" when the message has marks. v opens its proposals, s the squeeze
// chips (Length, Report ↔ Interpret, Familiarity, +), each press a line to the terminal session.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from '@09/components/Chip'
import { MarkedText, prepare, type MarkHost } from '../lib/marks'
import { openMark, pressVerb, rowVerbs, squeeze } from '../lib/actions'
import { parseObj, setState, threadsOfRow, useStore, type Row } from '../lib/store'
import { threadName } from './ChatPanel'

export const VIEW_VERBS = new Set(['map', 'trace', 'explore'])

export function Message({ row }: { row: Row }) {
  const rec = row.record!
  const focus = useStore((s) => s.focus)
  const threads = useStore((s) => s.threads)
  const p = useMemo(() => prepare(rec), [rec])
  const host: MarkHost = {
    marks: p.marks,
    focus: focus && focus.row === row.row ? focus.i : null,
    onOpen: (i) => openMark({ row: row.row, i }),
    threadOf: (i) => {
      const m = p.marks[i]
      const t = threads.find((x) => x.scope?.row === row.row && !x.scope?.object && x.scope?.mark && ((m.ref && x.scope.mark.ref === m.ref) || (m.gloss && x.scope.mark.gloss === m.gloss)))
      return t ? { id: t.id, open: () => setState({ thread: t.id }) } : null
    },
  }
  return (
    <>
      <div className="chat-msg chat-assistant lean-msg" data-row={row.row}>
        <div className="chat-text">
          <MarkedText md={p.md} host={host} />
        </div>
        <Chips row={row} />
        <VerbRow row={row} marks={p.marks.length} />
        <Proposals row={row} />
        <Squeeze row={row} />
      </div>
    </>
  )
}

/** Under the answer: a chip per card its turn saved (it selects the card on the Canvas, a view opens its tab), and a
 * chip per side thread started from it (it opens the thread in the chat), as 0.9 draws what a turn made. */
function Chips({ row }: { row: Row }) {
  const objects = useStore((s) => s.objects)
  const threads = useStore((s) => s.threads)
  const refs = (row.record?.objects || []).map(parseObj).filter((x): x is { id: string; v: number | null } => !!x)
  const mine = threadsOfRow(threads, row.row, row.record?.objects || [])
  if (!refs.length && !mine.length) return null
  return (
    <div className="lean-chips-row">
      {refs.map((o) => {
        const info = objects.find((x) => x.id === o.id)
        const view = info && VIEW_VERBS.has(String(info.verb))
        return (
          <Chip
            key={o.id}
            kind="ref"
            tone="accent"
            icon={view ? 'view' : 'cell'}
            className="refchip refchip-card"
            title={info?.question || info?.title || o.id}
            onClick={() => {
              if (view) setState({ surface: 'files', filesView: `view:${o.id}`, card: null })
              else setState({ surface: 'canvas', selected: o.id, reveal: o.id, card: null })
            }}
          >
            {cut(o.id.replace(/^\d+-/, ''), 30)}
          </Chip>
        )
      })}
      {mine.map((t) => (
        <Chip key={t.id} kind="ref" tone="accent" icon="thread" face="sans" className="refchip lean-thread-chip" title={t.turns.find((x) => x.role === 'user')?.text || ''} onClick={() => setState({ thread: t.id })}>
          {cut(`main/${threadName(t)}`, 30)}
        </Chip>
      ))}
    </div>
  )
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function VerbRow({ row, marks }: { row: Row; marks: number }) {
  const verbs = useStore((s) => s.verbs)
  const props = useStore((s) => s.propsOpen)
  const sq = useStore((s) => s.squeezeOpen)
  const rec = row.record!
  const list = rowVerbs(verbs)
  return (
    <div className="lean-verbs" role="toolbar" aria-label="Verbs">
      {list.map((v, i) => {
        const st = rec.verbs?.[v.key] || rec.verbs?.[v.send] || {}
        const lit = st.lit === true
        const open = (v.key === 'v' && props === row.row) || (v.key === 's' && sq === row.row)
        return (
          <span key={v.key} className="lean-verb-wrap">
            {i > 0 && <span className="lean-verb-sep">·</span>}
            <button type="button" className={`lean-verb lean-verb-${v.key}${lit ? ' is-lit' : ''}${open ? ' is-open' : ''}`} title={v.line} onClick={() => void pressVerb(row.row, v.key)}>
              <b>{v.key}</b>
              {lit && st.note ? (
                <>
                  <span className="lean-verb-dot">●</span>
                  <span>{st.note}</span>
                </>
              ) : (
                <span>{v.name}</span>
              )}
            </button>
          </span>
        )
      })}
      {marks > 0 && (
        <span className="lean-verb-marks" title="] and [ step through the marks; each opens its card below">
          <b>]</b>&nbsp;{marks} {marks === 1 ? 'mark' : 'marks'}
        </span>
      )}
    </div>
  )
}

/** A line that opens under a message comes into view in the chat. */
function useIntoView(open: boolean) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) requestAnimationFrame(() => el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [open])
  return el
}

function Proposals({ row }: { row: Row }) {
  const open = useStore((s) => s.propsOpen === row.row)
  const list = row.record?.verbs?.v?.proposals || []
  const el = useIntoView(open && list.length > 0)
  if (!open || !list.length) return null
  return (
    <div className="lean-props" ref={el}>
      {list.map((p, i) => (
        <button key={i} type="button" className="lean-prop" onClick={() => void pressVerb(row.row, 'v', p)}>
          <span className="lean-prop-n">{i + 1}</span>
          {p}
        </button>
      ))}
      <span className="lean-hint">click to draw · 0 close</span>
    </div>
  )
}

/** The chips every message has (squeeze's chips.mjs CHIPS): where the original stands is `level0`, or where the
 * observer says it stands (record.verbs.s.at); the levels set now are record.squeeze.at; the person's own chips are
 * record.squeeze.own. A press goes to the terminal, which rewrites the message in place; the record then shows it. */
const FIXED = [
  { id: 'length', name: 'Length', levels: ['one line', 'short', 'medium', 'full'], level0: 3, pos: false },
  { id: 'interpret', name: 'Report ↔ Interpret', levels: ['report', 'both', 'interpret'], level0: 1, pos: true },
  { id: 'familiarity', name: 'Familiarity', levels: ['new', 'familiar', 'expert'], level0: 1, pos: false },
]
interface ShownChip {
  id: string
  name: string
  levels: string[]
  level0: number
  level: number
  pos: boolean
  own?: boolean
}

function chipsOf(rec: Row['record']): ShownChip[] {
  const sq = ((rec as any)?.squeeze || {}) as { at?: Record<string, number>; own?: { id: string; name: string; levels?: string[] }[] }
  const seen = ((rec?.verbs?.s as any)?.at || {}) as Record<string, number | string>
  const out: ShownChip[] = FIXED.map((c) => {
    const o = seen[c.id]
    const level0 = c.id === 'length' ? c.level0 : typeof o === 'number' && o >= 0 && o < c.levels.length ? o : typeof o === 'string' && c.levels.includes(o) ? c.levels.indexOf(o) : c.level0
    const at = sq.at?.[c.id]
    return { ...c, level0, level: Number.isInteger(at) && (at as number) >= 0 && (at as number) < c.levels.length ? (at as number) : level0 }
  })
  for (const c of sq.own || []) {
    if (!c || !c.id || !Array.isArray(c.levels) || !c.levels.length) continue
    const at = sq.at?.[c.id]
    out.push({ id: c.id, name: c.name, levels: c.levels, level0: 0, level: Number.isInteger(at) ? (at as number) : 0, pos: false, own: true })
  }
  return out
}

const dots = (c: ShownChip, v: number) => (c.pos ? c.levels.map((_, i) => (i === v ? '●' : '○')) : c.own ? c.levels.slice(1).map((_, i) => (i < v ? '●' : '○')) : c.levels.map((_, i) => (i <= v ? '●' : '○')))

function Squeeze({ row }: { row: Row }) {
  const open = useStore((s) => s.squeezeOpen === row.row)
  const rec = row.record!
  const chips = useMemo(() => chipsOf(rec), [rec])
  const [pending, setPending] = useState<Record<string, number>>({})
  const [waiting, setWaiting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [custom, setCustom] = useState('')
  const el = useIntoView(open)
  // what the person pressed shows at once; the record's own levels take over when the rewrite lands
  useEffect(() => {
    setPending({})
    setWaiting(false)
  }, [rec.shown, JSON.stringify((rec as any).squeeze?.at || {})])
  if (!open) return null
  const squeezed = rec.shown != null && rec.shown !== rec.text
  const set = (c: ShownChip, level: number) => {
    const l = Math.max(0, Math.min(c.levels.length - 1, level))
    setPending((x) => ({ ...x, [c.id]: l }))
    setWaiting(true)
    void squeeze(row.row, { chip: c.id, name: c.name, level: l, levelName: c.levels[l] })
  }
  return (
    <div className="lean-squeeze" ref={el}>
      <div className="lean-chips">
        {chips.map((c) => {
          const level = pending[c.id] ?? c.level
          return (
            <span key={c.id} className={`lean-chip${level !== c.level0 ? ' is-changed' : ''}`}>
              <span className="lean-chip-name">{c.name}</span>
              <span className="lean-chip-level">
                <button type="button" className="lean-chip-step" aria-label={`less ${c.name}`} disabled={level === 0} onClick={() => set(c, level - 1)}>
                  ‹
                </button>
                <span className="lean-chip-dots" aria-hidden="true">
                  {dots(c, level).map((d, i) => (
                    <button key={i} type="button" className={d === '●' ? 'on' : ''} title={c.levels[c.pos ? i : c.own ? i + 1 : i]} onClick={() => set(c, c.own ? i + 1 : i)}>
                      {d}
                    </button>
                  ))}
                </span>
                <span className="lean-chip-word">{c.levels[level]}</span>
                <button type="button" className="lean-chip-step" aria-label={`more ${c.name}`} disabled={level >= c.levels.length - 1} onClick={() => set(c, level + 1)}>
                  ›
                </button>
              </span>
            </span>
          )
        })}
        {adding ? (
          <form
            className="lean-chip lean-chip-custom"
            onSubmit={(e) => {
              e.preventDefault()
              if (custom.trim()) {
                setWaiting(true)
                void squeeze(row.row, { custom: custom.trim() })
              }
              setCustom('')
              setAdding(false)
            }}
          >
            <span className="lean-chip-name">your chip</span>
            <input autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="for my manager…" onBlur={() => !custom && setAdding(false)} />
          </form>
        ) : (
          <button type="button" className="lean-chip lean-chip-add" onClick={() => setAdding(true)}>
            <span className="lean-chip-name">+</span>
            <span className="lean-chip-word">add</span>
          </button>
        )}
      </div>
      <div className="lean-hint">
        {waiting ? 'rewriting in the terminal… · ' : ''}‹ › change · + your own chip ·{' '}
        {squeezed ? (
          <button type="button" className="lean-linkish" onClick={() => void squeeze(row.row, { reset: true })}>
            original
          </button>
        ) : (
          'rewritten in place'
        )}{' '}
        · 0 close
      </div>
    </div>
  )
}
