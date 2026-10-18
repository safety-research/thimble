// Message.tsx: one of Claude's messages in the chat, from its record: the text with its marks (cite, explain, spark),
// the cards its turn saved as 0.9's step row of card chips, then the verb row (v visualize · s squeeze · c claims), dim
// at rest and lit from the record, with "] N marks" when the message has marks. v opens its proposals, s the squeeze
// chips (Length, Report ↔ Interpret, Familiarity, +), each press a line to the terminal session.
import { useMemo, useState, type ReactNode } from 'react'
import { Chip } from '@09/components/Chip'
import { ChipRun, ToolCard } from '@09/components/ToolCard'
import { MarkedText, prepare, type MarkHost } from '../lib/marks'
import { openMark, pressVerb, rowVerbs, squeeze } from '../lib/actions'
import { isClaims, parseObj, setState, useStore, type Chip as SqueezeChip, type Row } from '../lib/store'

export const VIEW_VERBS = new Set(['map', 'trace', 'explore'])

export function Message({ row }: { row: Row }) {
  const rec = row.record!
  const focus = useStore((s) => s.focus)
  const p = useMemo(() => prepare(rec), [rec])
  const host: MarkHost = {
    marks: p.marks,
    focus: focus && focus.row === row.row ? focus.i : null,
    onOpen: (i) => openMark({ row: row.row, i }),
  }
  return (
    <div className="chat-msg chat-assistant lean-msg" data-row={row.row}>
      <div className="chat-text">
        <MarkedText md={p.md} host={host} />
      </div>
      <Cards refs={rec.objects || []} />
      <VerbRow row={row} marks={p.marks.length} />
      <Proposals row={row} />
      <Squeeze row={row} />
    </div>
  )
}

/** The cards the turn saved, as 0.9 draws a step that made cards: a folded step row with each card's chip. */
function Cards({ refs }: { refs: string[] }) {
  const objects = useStore((s) => s.objects)
  const list = refs.map(parseObj).filter((x): x is { id: string; v: number | null } => !!x)
  if (!list.length) return null
  const chips: ReactNode[] = list.map((o) => {
    const info = objects.find((x) => x.id === o.id)
    const view = info && (VIEW_VERBS.has(String(info.verb)) || isClaims(info))
    const name = info?.title || o.id
    return (
      <span key={o.id} className="chat-tool-cell" onClick={(e) => e.stopPropagation()}>
        <Chip
          kind="ref"
          tone="accent"
          face="sans"
          icon={view ? 'view' : 'cell'}
          className="refchip refchip-card"
          title={info?.question || name}
          onClick={() => {
            if (info && isClaims(info)) setState({ surface: 'files', filesView: 'claims', card: null })
            else if (view) setState({ surface: 'files', filesView: `view:${o.id}`, card: null })
            else setState({ surface: 'canvas', selected: o.id, reveal: o.id, card: null })
          }}
        >
          {cut(name, 34)}
        </Chip>
      </span>
    )
  })
  const views = list.filter((o) => {
    const info = objects.find((x) => x.id === o.id)
    return info && (VIEW_VERBS.has(String(info.verb)) || isClaims(info))
  }).length
  const title = views === list.length ? (views > 1 ? 'Views' : 'View') : list.length > 1 ? 'Cards' : 'Card'
  return <ToolCard className="chat-tool lean-cards" title={<span className="chat-tool-name">{title}</span>} meta={`${list.length} saved`} state="done" chips={<ChipRun>{chips}</ChipRun>} />
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
        <span className="lean-verb-wrap lean-verb-marks" title="] and [ step through the marks; each opens its card below">
          <span className="lean-verb-sep">·</span>
          <b>]</b>&nbsp;{marks} {marks === 1 ? 'mark' : 'marks'}
        </span>
      )}
    </div>
  )
}

function Proposals({ row }: { row: Row }) {
  const open = useStore((s) => s.propsOpen === row.row)
  const list = row.record?.verbs?.v?.proposals || []
  if (!open || !list.length) return null
  return (
    <div className="lean-props">
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

/** The chips a message offers when the observer proposed none: Length, Report ↔ Interpret, Familiarity. */
const DEFAULT_CHIPS: SqueezeChip[] = [
  { id: 'length', name: 'Length', levels: ['one line', 'short', 'medium', 'full'], level: 3 },
  { id: 'interpret', name: 'Report ↔ Interpret', levels: ['facts only', 'mostly facts', 'as written', 'more reading'], level: 2 },
  { id: 'familiarity', name: 'Familiarity', levels: ['new', 'some', 'expert'], level: 1 },
]

function Squeeze({ row }: { row: Row }) {
  const open = useStore((s) => s.squeezeOpen === row.row)
  const rec = row.record!
  const proposed = rec.verbs?.s?.chips?.filter((c) => c && Array.isArray(c.levels) && c.levels.length) || []
  const chips = useMemo(() => {
    const out = [...proposed]
    for (const d of DEFAULT_CHIPS) if (!out.some((c) => c.id === d.id || c.name.toLowerCase() === d.name.toLowerCase())) out.push(d)
    return out
  }, [JSON.stringify(proposed)])
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [adding, setAdding] = useState(false)
  const [custom, setCustom] = useState('')
  if (!open) return null
  const squeezed = rec.shown != null && rec.shown !== rec.text
  const set = (c: SqueezeChip, level: number) => {
    const l = Math.max(0, Math.min(c.levels.length - 1, level))
    setLevels((x) => ({ ...x, [c.id]: l }))
    void squeeze(row.row, { chip: c.id, name: c.name, level: l, levelName: c.levels[l] })
  }
  return (
    <div className="lean-squeeze">
      <div className="lean-chips">
        {chips.map((c) => {
          const level = levels[c.id] ?? Math.min(c.levels.length - 1, Math.max(0, c.level ?? c.levels.length - 1))
          const changed = levels[c.id] != null
          return (
            <span key={c.id} className={`lean-chip${changed ? ' is-changed' : ''}`}>
              <span className="lean-chip-name">{c.name}</span>
              <span className="lean-chip-level">
                <button type="button" className="lean-chip-step" aria-label={`less ${c.name}`} disabled={level === 0} onClick={() => set(c, level - 1)}>
                  ‹
                </button>
                <span className="lean-chip-dots" aria-hidden="true">
                  {c.levels.map((_, i) => (
                    <button key={i} type="button" className={i <= level ? 'on' : ''} title={c.levels[i]} onClick={() => set(c, i)}>
                      {i <= level ? '●' : '○'}
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
              if (custom.trim()) void squeeze(row.row, { custom: custom.trim() })
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
        ‹ › change · + your own chip · {squeezed ? (
          <button type="button" className="lean-linkish" onClick={() => void squeeze(row.row, { reset: true })}>
            original
          </button>
        ) : (
          'rewritten in place in the terminal'
        )}{' '}
        · 0 close
      </div>
    </div>
  )
}
