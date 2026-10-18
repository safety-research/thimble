// CardDetail.tsx: a card's detail as one layout: the chat column shows the card's thread (ChatPanel), the main panel
// the card enlarged under a path back to the Canvas, with one line of where its values come from, and a bar at the
// foot that starts empty and fills on demand: select a part and the bar names it; "Show examples" (or [ ]) expands
// examples of it, labelled with what they are examples of; p shows the program, the part's lines lit. A question typed
// in the chat then is about that part. 0, esc or ← Canvas goes back to the board.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@09/components/Button'
import { Icon } from '@09/components/Icon'
import { Spinner } from '@09/components/Spinner'
import { api, back as sendBack, fmt, hhmm, objectOf, resolveRef } from '../lib/api'
import { columnsIn, eventOf, eventsLib, objectLib } from '../lib/draw'
import { CitedText } from '../lib/marks'
import { ask, pushCite } from '../lib/actions'
import { recordWords as wordsOfRecord, wordsOf } from '../lib/records'
import { cardGroups, getState, setState, useStore } from '../lib/store'
import { useDrawn } from './CardFace'

const back = () => setState({ card: null, thread: 'main', detailBar: null })

export function CardDetail() {
  const card = useStore((s) => s.card)!
  const rows = useStore((s) => s.rows)
  const objects = useStore((s) => s.objects)
  const bar = useStore((s) => s.detailBar)
  const groups = useMemo(() => cardGroups(rows, objects), [rows, objects])
  const group = groups.find((g) => g.cards.some((c) => c.id === card.id))
  const col = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    const el = col.current
    if (!el) return
    const fit = () => setW(Math.max(560, Math.min(1200, el.clientWidth)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [hover, setHover] = useState<string | null>(null)
  // the card's interaction state: where the person (here or in the terminal) left it, kept by the terminal session
  const cardState = useStore((s) => s.cardStates[card.id])
  useEffect(() => {
    let alive = true
    void objectOf(card.id, null).then((r) => {
      const kept = r?.state
      if (!alive || !kept || getState().cardStates[card.id] !== undefined) return
      setState((s) => ({ cardStates: { ...s.cardStates, [card.id]: kept.state || {} }, card: s.card && s.card.id === card.id && !s.card.region && kept.region ? { ...s.card, region: kept.region } : s.card }))
    })
    return () => {
      alive = false
    }
  }, [card.id])
  const d = useDrawn(card.id, card.v, w - 56, 'detail', { selected: card.region, hover, state: cardState })
  const o = d?.object
  const versions = d?.versions || []
  const part = d?.parts.find((p) => p.id === card.region) || null
  const [facts, setFacts] = useState<any>(null)
  useEffect(() => {
    setState({ detailBar: null, exampleAt: 0 })
  }, [card.id])
  useEffect(() => {
    let alive = true
    setFacts(null)
    if (o?.id) void api(`from/${encodeURIComponent(o.id)}?v=${o.version}`).then((f) => alive && !f.error && setFacts(f))
    return () => {
      alive = false
    }
  }, [o?.id, o?.version])

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

  const pick = (region: string | null) => setState((s) => ({ card: s.card ? { ...s.card, region } : null, exampleAt: 0, detailBar: s.detailBar === 'program' ? 'program' : null }))
  // what the person does on the card, as its program's event (k.on): the state it answers with is kept here and sent
  // to the terminal session, which keeps it for both surfaces; an ask(selection) points the chat's next question at it
  const fire = async (event: Record<string, unknown>): Promise<boolean> => {
    if (!o || !d?.drawing) return false
    const ev = await eventsLib()
    if (!ev.takes(d.drawing, event)) return false
    const got = await eventOf(o, { w: columnsIn(w - 56), state: cardState || {}, event })
    if (got?.error) {
      setState({ sent: { text: `the card could not answer: ${got.error.name} · fix: ${got.error.fix || 'its program'}`, at: Date.now(), error: got.error.message } })
      return true
    }
    const st = got.state || cardState || {}
    const region = typeof event.region === 'string' ? event.region : card.region
    setState((s) => ({ cardStates: { ...s.cardStates, [card.id]: st }, card: s.card ? { ...s.card, region } : null }))
    void sendBack({ cardstate: { object: card.id, region, state: st } })
    const a = got.ask
    if (a && a.text) void ask(a.text, { object: card.id, ...(o.version != null ? { v: o.version } : {}), ...(a.region ? { region: a.region } : {}), label: a.label, ...(a.refs ? { refs: a.refs } : {}) })
    else if (a) setState({ cardAsk: { object: card.id, label: a.label, ...(a.region ? { region: a.region } : {}), ...(a.refs ? { refs: a.refs } : {}) } })
    return true
  }
  const fireRef = useRef(fire)
  fireRef.current = fire
  useEffect(() => {
    current.fire = (e) => fireRef.current(e)
    return () => {
      current.fire = null
      current.on = []
    }
  }, [])
  current.on = d?.drawing?.on || []
  // a drag across a brush area of the card (k.plot's brush, a canvas's c.brush) is its program's brush event
  const brushHost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = brushHost.current
    if (!el) return
    let off: (() => void) | null = null
    let alive = true
    void eventsLib().then((ev) => {
      if (alive) off = ev.attachBrush(el, (e: Record<string, unknown>) => void fireRef.current(e))
    })
    return () => {
      alive = false
      off?.()
    }
  }, [!!d?.drawing])
  const from = facts?.sources?.length ? facts.sources.map((x: any) => x.path).join(', ') : ''
  return (
    <div className="board" data-panel="canvas">
      <div className="board-stage">
        <div className="bfocus lean-detail" onMouseDown={(e) => e.stopPropagation()}>
          <div className="bfocus-stage" style={{ '--bfocus-bar-h': `${barH}px` } as React.CSSProperties}>
            <nav className="lean-crumbs" aria-label="Where this card is">
              <button type="button" className="lean-crumb-back" onClick={back}>
                <Icon name="arrow-left" size={13} />
                Canvas
              </button>
              {group && <span className="lean-crumb-group">{group.title}</span>}
              <span className="lean-crumb-sep">/</span>
              <span className="lean-crumb-card">{card.id}</span>
              <span className="lean-spacer" />
              <span className="lean-crumb-keys">
                <kbd>0</kbd> back to Canvas
              </span>
            </nav>
            <div className="bfocus-main lean-detail-main">
              <div className="bfocus-col is-wide lean-detail-col" ref={col}>
                <article className="bfocus-card" data-cell={card.id}>
                  <div className="lean-detail-head">
                    <div className="bfocus-q">{o?.question || o?.title || card.id}</div>
                    {versions.length > 0 && (
                      <span className="lean-versions">
                        {versions.map((x) => (
                          <button key={x.v} type="button" className={`lean-version${(card.v ?? o?.version) === x.v ? ' is-on' : ''}`} title={x.change || ''} onClick={() => setState((s) => ({ card: s.card ? { ...s.card, v: x.v } : null }))}>
                            v{x.v}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="lean-detail-meta">
                    {[`card:${card.id}`, from ? `from ${from}` : '', facts?.rows ? `${fmt(facts.rows)} rows` : '', facts?.labels?.length ? `label ${facts.labels.join(', ')}` : '', facts?.coverage ? `${facts.coverage.feeding} of ${facts.coverage.files} files` : '', hhmm(o?.created || o?.updated)].filter(Boolean).join(' · ')}
                  </div>
                  {!d && (
                    <div className="bcell-run">
                      <Spinner size={10} label="drawing" /> drawing
                    </div>
                  )}
                  {d?.error && <div className="lean-card-error">× {d.error}</div>}
                  {d && !d.error && (
                    <>
                      {(d.title || d.right) && (
                        <div className="lean-card-frame">
                          <span>{d.title}</span>
                          <span className="lean-card-right">click a part for details</span>
                        </div>
                      )}
                      <div ref={brushHost} className="lean-card-host">
                        <div
                          className="lean-svg lean-svg-big"
                          onClick={(e) => {
                            const r = (e.target as Element).closest('[data-region]')?.getAttribute('data-region') ?? null
                            // a press the program answers (k.on('press:<id>')) is its event; any other selects the part
                            void fire({ type: 'press', region: r }).then((taken) => {
                              if (!taken) pick(r && r !== card.region ? r : null)
                            })
                          }}
                          onMouseMove={(e) => setHover((e.target as Element).closest('[data-region]')?.getAttribute('data-region') ?? null)}
                          onMouseLeave={() => setHover(null)}
                          dangerouslySetInnerHTML={{ __html: d.svg }}
                        />
                      </div>
                    </>
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
              </div>
            </div>
            <div className="lean-detail-barwrap" ref={barRef}>
              <DetailBar open={bar} part={part} drawing={d?.drawing} object={o} />
            </div>
          </div>
        </div>
        <div className="board-status">{['detail', o?.title || card.id, o ? `v${card.v ?? o.version}` : '', part ? part.label : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

type Part = { id: string; label: string; meta: any }

/** The bar at the foot of the detail: empty until a part is selected; then the part, and its examples on request. */
function DetailBar({ open, part, drawing, object }: { open: 'examples' | 'from' | 'program' | null; part: Part | null; drawing: any; object: any }) {
  const toggle = (k: 'examples' | 'program') => setState((s) => ({ detailBar: s.detailBar === k ? null : k }))
  return (
    <div className={`lean-detail-bar${part || open ? ' is-open' : ''}`}>
      {!part && open !== 'program' ? (
        <div className="lean-detail-keys">
          <Icon name="arrow-up-right" size={13} />
          <span className="lean-detail-hint">Select a part to see its details</span>
          <span className="lean-spacer" />
          <button type="button" className="lean-key" onClick={() => toggle('program')}>
            <kbd>p</kbd> program
          </button>
          <span className="lean-detail-label">DETAILS</span>
        </div>
      ) : (
        <>
          <div className="lean-detail-keys">
            {part ? (
              <>
                <span className="lean-ex-dot" />
                <b className="lean-detail-partname">{part.label}</b>
              </>
            ) : (
              <span className="lean-detail-hint">The card's program</span>
            )}
            <span className="lean-spacer" />
            <button type="button" className={`lean-key${open === 'program' ? ' is-on' : ''}`} onClick={() => toggle('program')}>
              <kbd>p</kbd> program
            </button>
            <button type="button" className="lean-key" onClick={() => setState({ detailBar: null, card: getState().card ? { ...getState().card!, region: null } : null })}>
              <kbd>0</kbd> close
            </button>
            <span className="lean-detail-label">DETAILS</span>
          </div>
          {part && <PartFacts part={part} drawing={drawing} object={object} />}
          {part && open !== 'program' && (
            <div className="lean-detail-show">
              <button type="button" className={`lean-show${open === 'examples' ? ' is-on' : ''}`} onClick={() => toggle('examples')}>
                {open === 'examples' ? 'Hide' : 'Show'} examples of {part.label}
                <Icon name={open === 'examples' ? 'chevron-up' : 'chevron-down'} size={12} />
              </button>
              <span className="lean-hint">
                <kbd>[</kbd> <kbd>]</kbd> step through them
              </span>
            </div>
          )}
          {open === 'examples' && part && <Examples part={part} drawing={drawing} object={object} />}
          {open === 'program' && object && <Program program={String(object.program || '')} part={part} />}
        </>
      )}
    </div>
  )
}

/** One line on the selected part: the rows it rests on, from where. */
function PartFacts({ part, drawing, object }: { part: Part; drawing: any; object: any }) {
  const [line, setLine] = useState('')
  useEffect(() => {
    let alive = true
    setLine('')
    void (async () => {
      const lib = await objectLib()
      const { refs } = lib.regionRefs(object, drawing, part.id)
      if (!refs.length) return alive && setLine(part.meta?.note ? String(part.meta.note) : 'this part names no rows')
      const r = await resolveRef(refs[0], 1)
      const files = [...new Set((r.rows || []).map((x: string) => String(x).split('#')[0]))] as string[]
      if (alive) setLine([refs[0], files.length ? `from ${files.join(', ')}` : '', r.count != null ? `${fmt(r.count)} rows` : ''].filter(Boolean).join(' · '))
    })()
    return () => {
      alive = false
    }
  }, [part.id, object?.id, object?.version])
  return <div className="lean-detail-facts">{line || ' '}</div>
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
  const show = rows.recs.slice(k, k + 6)
  return (
    <div className="lean-detail-body">
      <div className="lean-ex-head">
        <b>Examples of {rows.label}</b>
        <span className="lean-ex-count">
          {k + 1}–{Math.min(rows.recs.length, k + 6)} of {fmt(rows.total || rows.recs.length)}
        </span>
      </div>
      <table className="lean-ex-table">
        <thead>
          <tr>
            <th>row</th>
            <th>who · when</th>
            <th>what it says</th>
          </tr>
        </thead>
        <tbody>
          {show.map((r, j) => (
            <tr key={j} className={j === 0 ? 'is-on' : undefined}>
              <td className="lean-ex-ref">
                {r.ref ? (
                  <button type="button" className="lean-tray-rowref" title="open in Files" onClick={() => setState({ surface: 'files', filesView: 'browser', file: r.ref!, card: null, thread: 'main' })}>
                    {r.ref.replace(/^.*#/, '')}
                  </button>
                ) : (
                  j + k + 1
                )}
              </td>
              <td className="lean-ex-meta">{r.meta}</td>
              <td className="lean-ex-words" title={r.words}>
                {r.words}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

// the open card's event, for the page's key handler
const current: { fire: ((e: Record<string, unknown>) => Promise<boolean>) | null; on: { name: string }[] } = { fire: null, on: [] }

/** The detail's keys: the card program's own first (k.on), then [ ] examples, p program; read by the shell's key
 *  handler. A card's key that its program takes is sent to it as an event (it runs once more with it). */
export function detailKey(k: string): boolean {
  const s = getState()
  if (!s.card) return false
  const name = k === ' ' ? 'space' : k === 'Enter' ? 'return' : k
  if (current.fire && k !== 'Escape' && k !== '0' && current.on.some((h) => h.name === name || h.name === 'key')) {
    void current.fire({ type: 'key', key: name, ...(s.card.region ? { region: s.card.region } : {}) })
    return true
  }
  if (k === '[' || k === ']') {
    setState({ detailBar: 'examples', exampleAt: s.detailBar === 'examples' ? Math.max(0, s.exampleAt + (k === ']' ? 1 : -1)) : 0 })
    return true
  }
  if (k === 'p') {
    setState({ detailBar: s.detailBar === 'program' ? null : 'program' })
    return true
  }
  return false
}
