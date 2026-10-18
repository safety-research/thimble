// CardDetail.tsx: a card's detail as one layout: the chat column shows the card's thread (ChatPanel), the main panel
// the card enlarged (0.9's focus mode, the cards of its group listed at the left), and a bar at the foot that starts
// empty and fills on demand: the examples of the selected part (labelled with what they are examples of, stepped
// with [ ]), where the card's values come from (f), or its program with the part's lines lit (p). A click selects a
// part; a question typed in the chat then is about that part. 0 or × goes back to the board.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@09/components/Button'
import { Spinner } from '@09/components/Spinner'
import { api, fmt, hhmm, resolveRef } from '../lib/api'
import { objectLib } from '../lib/draw'
import { CitedText } from '../lib/marks'
import { pushCite } from '../lib/actions'
import { recordWords as wordsOfRecord, wordsOf } from '../lib/records'
import { cardGroups, getState, setState, useStore } from '../lib/store'
import { useDrawn } from './CardFace'

const FOCUS_W = 760

export function CardDetail() {
  const card = useStore((s) => s.card)!
  const rows = useStore((s) => s.rows)
  const objects = useStore((s) => s.objects)
  const bar = useStore((s) => s.detailBar)
  const groups = useMemo(() => cardGroups(rows, objects), [rows, objects])
  const group = groups.find((g) => g.cards.some((c) => c.id === card.id))
  const list = group?.cards ?? [{ id: card.id, v: null, row: null }]
  const i = list.findIndex((c) => c.id === card.id)
  const col = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(FOCUS_W)
  useEffect(() => {
    const el = col.current
    if (!el) return
    const fit = () => setW(Math.max(560, Math.min(1100, el.clientWidth)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [hover, setHover] = useState<string | null>(null)
  const d = useDrawn(card.id, card.v, w - 56, 'detail', { selected: card.region, hover })
  const o = d?.object
  const versions = d?.versions || []
  const part = d?.parts.find((p) => p.id === card.region) || null

  useEffect(() => {
    setState({ detailBar: null, exampleAt: 0 })
  }, [card.id])

  // the bar's height, which the card's scroll area stops above (0.9's --bfocus-bar-h)
  const barRef = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(44)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const fit = () => setBarH(el.offsetHeight)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pick = (region: string | null) => {
    setState((s) => ({ card: s.card ? { ...s.card, region } : null, exampleAt: 0 }))
  }
  return (
    <div className="board" data-panel="canvas">
    <div className="board-stage">
    <div className="bfocus lean-detail" onMouseDown={(e) => e.stopPropagation()}>
      <nav className="bfocus-list" aria-label={group?.title || 'Cards'}>
        <span className="bfocus-frame">{group?.title || 'Cards'}</span>
        {list.map((c) => {
          const info = objects.find((x) => x.id === c.id)
          return (
            <button key={c.id} type="button" className={`bfocus-item${c.id === card.id ? ' is-current' : ''}`} aria-current={c.id === card.id || undefined} onClick={() => setState({ card: { id: c.id, v: null, region: null }, selected: c.id })}>
              {info?.question || info?.title || c.id}
            </button>
          )
        })}
      </nav>
      <div className="bfocus-stage" style={{ '--bfocus-bar-h': `${barH}px` } as React.CSSProperties}>
        <div className="bfocus-main">
          <div className="bfocus-col is-wide lean-detail-col" ref={col}>
            <span className="bfocus-meta lean-detail-meta">
              {['main', hhmm(o?.created || o?.updated)].filter(Boolean).join(' · ')}
              {versions.length > 0 && (
                <span className="lean-versions">
                  {versions.map((x) => (
                    <button key={x.v} type="button" className={`lean-version${(card.v ?? o?.version) === x.v ? ' is-on' : ''}`} title={x.change || ''} onClick={() => setState((s) => ({ card: s.card ? { ...s.card, v: x.v } : null }))}>
                      v{x.v}
                    </button>
                  ))}
                </span>
              )}
            </span>
            <article className="bfocus-card" data-cell={card.id}>
              <div className="bfocus-q">{o?.question || o?.title || card.id}</div>
              {o?.question && o?.title && o.title !== o.question && <div className="lean-detail-title">{o.title}</div>}
              {!d && (
                <div className="bcell-run">
                  <Spinner size={10} label="drawing" /> drawing
                </div>
              )}
              {d?.error && <div className="lean-card-error">× {d.error}</div>}
              {d && !d.error && (
                <div
                  className="lean-svg lean-svg-big"
                  onClick={(e) => {
                    const r = (e.target as Element).closest('[data-region]')?.getAttribute('data-region') ?? null
                    pick(r && r !== card.region ? r : null)
                  }}
                  onMouseMove={(e) => setHover((e.target as Element).closest('[data-region]')?.getAttribute('data-region') ?? null)}
                  onMouseLeave={() => setHover(null)}
                  dangerouslySetInnerHTML={{ __html: d.svg }}
                />
              )}
              {d?.bottom && <div className="lean-card-bottom">{d.bottom}</div>}
              {o?.text && (
                <div className="bfocus-take">
                  <div className="chat-text">
                    <CitedText text={String(o.text)} onCite={(ref, label) => pushCite({ kind: 'cite', ref, label })} />
                  </div>
                </div>
              )}
            </article>
            <span className="bfocus-pos">
              {i + 1} of {list.length}
            </span>
          </div>
        </div>
        <div className="lean-detail-barwrap" ref={barRef}>
          <DetailBar open={bar} part={part} drawing={d?.drawing} object={o} />
        </div>
      </div>
      <Button variant="icon" size="md" icon="x" title="Back to the board" aria-label="Back to the board" className="bfocus-close" onClick={() => setState({ card: null, thread: 'main' })} />
    </div>
    <div className="board-status">{['detail', o?.title || card.id, o ? `v${card.v ?? o.version}` : '', part ? part.label : ''].filter(Boolean).join(' · ')}</div>
    </div>
    </div>
  )
}

type Part = { id: string; label: string; meta: any }

/** The bar at the foot of the detail: empty (its keys only) until the person asks for one of its three parts. */
function DetailBar({ open, part, drawing, object }: { open: 'examples' | 'from' | 'program' | null; part: Part | null; drawing: any; object: any }) {
  const toggle = (k: 'examples' | 'from' | 'program') => setState((s) => ({ detailBar: s.detailBar === k ? null : k }))
  return (
    <div className={`lean-detail-bar${open ? ' is-open' : ''}`}>
      <div className="lean-detail-keys">
        <button type="button" className={`lean-key${open === 'examples' ? ' is-on' : ''}`} onClick={() => toggle('examples')}>
          <kbd>[</kbd>
          <kbd>]</kbd> examples{part ? ` of ${part.label}` : ''}
        </button>
        <span className="lean-verb-sep">·</span>
        <button type="button" className={`lean-key${open === 'from' ? ' is-on' : ''}`} onClick={() => toggle('from')}>
          <kbd>f</kbd> from
        </button>
        <span className="lean-verb-sep">·</span>
        <button type="button" className={`lean-key${open === 'program' ? ' is-on' : ''}`} onClick={() => toggle('program')}>
          <kbd>p</kbd> program
        </button>
        <span className="lean-detail-part">{part ? <>selected: <b>{part.label}</b> · the chat's questions are about it</> : 'click a part to select it'}</span>
        {open && (
          <button type="button" className="lean-key lean-detail-close" onClick={() => setState({ detailBar: null })}>
            <kbd>0</kbd> close
          </button>
        )}
      </div>
      {open === 'examples' && <Examples part={part} drawing={drawing} object={object} />}
      {open === 'from' && object && <From object={object} />}
      {open === 'program' && object && <Program program={String(object.program || '')} part={part} />}
    </div>
  )
}

interface Rec {
  ref?: string
  words: string
  meta: string
}

function Examples({ part, drawing, object }: { part: Part | null; drawing: any; object: any }) {
  const at = useStore((s) => s.exampleAt)
  const [rows, setRows] = useState<{ label: string; total: number; recs: Rec[] } | null>(null)
  useEffect(() => {
    let alive = true
    setRows(null)
    void (async () => {
      if (!part) {
        // no part: the rows the card's words cite
        const lib = await objectLib()
        const refs = lib.objectRefs(object || {}).map((c: any) => c.ref).slice(0, 1)
        if (!refs.length) return alive && setRows({ label: '', total: 0, recs: [] })
        const r = await resolveRef(refs[0], 12)
        const recs = await wordsOf(r.records || [])
        return alive && setRows({ label: `the card's first citation (${refs[0]})`, total: r.count ?? recs.length, recs })
      }
      const set = typeof part.meta?.examples === 'string' ? drawing?.examples?.[part.meta.examples] : part.meta?.examples
      if (set?.records?.length) return alive && setRows({ label: set.label || part.label, total: set.total ?? set.records.length, recs: set.records.map((x: unknown) => wordsOfRecord(x)) })
      const lib = await objectLib()
      const { refs } = lib.regionRefs(object, drawing, part.id)
      if (!refs.length) return alive && setRows({ label: part.label, total: 0, recs: [] })
      const r = await resolveRef(refs[0], 12)
      const recs = await wordsOf(r.records || [])
      if (alive) setRows({ label: part.label, total: r.count ?? recs.length, recs })
    })()
    return () => {
      alive = false
    }
  }, [part?.id, object?.id, object?.version])
  if (!rows)
    return (
      <div className="lean-detail-body lean-tray-wait">
        <Spinner size={12} label="reading" /> reading the examples…
      </div>
    )
  if (!rows.recs.length) return <div className="lean-detail-body lean-tray-note">{part ? `No examples are attached to ${part.label}, and it names no rows.` : 'Select a part to see examples of it.'}</div>
  const k = Math.min(rows.recs.length - 1, Math.max(0, at))
  const show = rows.recs.slice(k, k + 4)
  return (
    <div className="lean-detail-body">
      <div className="lean-ex-head">
        <span className="lean-ex-dot" />
        <b>Examples of {rows.label}</b>
        <span className="lean-ex-count">
          {k + 1}–{Math.min(rows.recs.length, k + 4)} of {fmt(rows.total || rows.recs.length)}
        </span>
      </div>
      {show.map((r, j) => (
        <div key={j} className={`lean-ex${j === 0 ? ' is-on' : ''}`}>
          <div className="lean-ex-words">“{r.words.length > 280 ? r.words.slice(0, 279) + '…' : r.words}”</div>
          <div className="lean-ex-meta">
            {[r.meta, r.ref].filter(Boolean).join(' · ')}
            {r.ref && (
              <button type="button" className="lean-linkish" onClick={() => setState({ surface: 'files', filesView: 'browser', file: r.ref!, card: null, thread: 'main' })}>
                open in Files
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function From({ object }: { object: any }) {
  const [f, setF] = useState<any>(null)
  useEffect(() => {
    let alive = true
    void api(`from/${encodeURIComponent(object.id)}?v=${object.version}`).then((x) => alive && setF(x))
    return () => {
      alive = false
    }
  }, [object.id, object.version])
  if (!f)
    return (
      <div className="lean-detail-body lean-tray-wait">
        <Spinner size={12} label="reading" /> reading the lineage…
      </div>
    )
  if (f.error) return <div className="lean-detail-body lean-tray-problem">{f.error}</div>
  return (
    <div className="lean-detail-body lean-from">
      <span className="lean-from-k">from</span>
      {(f.sources || []).map((s: any) => (
        <button key={s.path} type="button" className="lean-from-src" onClick={() => setState({ surface: 'files', filesView: 'browser', file: s.path, card: null, thread: 'main' })}>
          {s.path}
          {s.rows ? <span className="lean-from-n"> · {fmt(s.rows)} rows{s.of ? ` of ${fmt(s.of)}` : ''}</span> : null}
        </button>
      ))}
      {f.coverage && (
        <span className="lean-from-cov">
          · {f.coverage.feeding} of {f.coverage.files} files feed it
        </span>
      )}
      {f.labels?.length > 0 && <span className="lean-from-labels">· labels {f.labels.join(', ')}</span>}
      {f.session?.notReadFiles > 0 && <span className="lean-from-unread">· the session had not read {fmt(f.session.notReadFiles)} of {fmt(f.session.files)} files</span>}
    </div>
  )
}

function Program({ program, part }: { program: string; part: Part | null }) {
  const lines = program.split('\n')
  const lit = new Set<number>()
  if (part) {
    const words = [part.id, ...String(part.id).split(/[-_]/).filter((x) => x.length > 3)]
    lines.forEach((l, i) => {
      if (words.some((w) => l.includes(w))) lit.add(i)
    })
  }
  return (
    <div className="lean-detail-body lean-program">
      {lines.map((l, i) => (
        <div key={i} className={`lean-program-line${lit.has(i) ? ' is-lit' : ''}`}>
          <span className="lean-program-no">{i + 1}</span>
          <span>{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}

/** The detail's keys: [ ] examples, f from, p program; read by the shell's key handler. */
export function detailKey(k: string): boolean {
  const s = getState()
  if (!s.card) return false
  if (k === '[' || k === ']') {
    setState({ detailBar: 'examples', exampleAt: s.detailBar === 'examples' ? Math.max(0, s.exampleAt + (k === ']' ? 1 : -1)) : 0 })
    return true
  }
  if (k === 'f' || k === 'p') {
    const want = k === 'f' ? 'from' : 'program'
    setState({ detailBar: s.detailBar === want ? null : want })
    return true
  }
  return false
}
