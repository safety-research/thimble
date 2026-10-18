// CardFace.tsx: a lean object as 0.9's card: the thread and time at the top, the question, the drawing (lean's SVG
// renderer, the same program the terminal draws), and the takeaway with its citations live.
import { useEffect, useState } from 'react'
import { Spinner } from '@09/components/Spinner'
import { hhmm, objectOf } from '../lib/api'
import { columnsIn, drawingOf, svgOf, unframe } from '../lib/draw'
import { CitedText } from '../lib/marks'
import { pushCite } from '../lib/actions'
import { cardThread, setState, useStore } from '../lib/store'

export interface Drawn {
  object: any
  versions: { v: number; at?: string; change?: string | null }[]
  svg: string
  h: number
  title: string
  right: string
  bottom: string
  parts: { id: string; label: string; meta: any; rects: { x: number; y: number; w: number; h: number }[] }[]
  drawing: any
  error?: string
}

/** Load an object (a version, or the latest) and draw it for `px` pixels; `selected` and `hover` outline a part. */
export function useDrawn(id: string, v: number | null, px: number, mode = 'inline', opts: { selected?: string | null; hover?: string | null; state?: Record<string, unknown> } = {}): Drawn | null {
  const [got, setGot] = useState<Drawn | null>(null)
  const sel = opts.selected ?? null
  const hov = opts.hover ?? null
  const stateKey = opts.state ? JSON.stringify(opts.state) : ''
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await objectOf(id, v)
      if (!alive) return
      if (r.error || !r.object) {
        setGot({ object: { id, title: id }, versions: [], svg: '', h: 0, title: '', right: '', bottom: '', parts: [], drawing: null, error: r.error || 'no object' })
        return
      }
      try {
        const w = columnsIn(px)
        const u = unframe(await drawingOf(r.object, { w, mode, state: opts.state }))
        const s = await svgOf(u.drawing, { w, selected: sel, hover: hov })
        if (!alive) return
        const err = u.drawing?.error ? `its program failed: ${u.drawing.error.name}: ${u.drawing.error.message}` : undefined
        setGot({ object: r.object, versions: r.versions || [], svg: s.svg, h: s.h, title: u.title, right: u.right, bottom: u.bottom, parts: s.parts, drawing: u.drawing, error: err })
      } catch (e) {
        if (alive) setGot({ object: r.object, versions: r.versions || [], svg: '', h: 0, title: '', right: '', bottom: '', parts: [], drawing: null, error: String((e as Error)?.message || e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [id, v, Math.round(px / 8), mode, sel, hov, stateKey])
  return got
}

export function CardFace({ id, row, width, selected }: { id: string; row: string | null; width: number; selected: boolean }) {
  const d = useDrawn(id, null, width)
  const o = d?.object
  const thread = useStore((s) => cardThread(s.threads, id))
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    setState({ card: { id, v: null, region: null }, selected: id })
  }
  return (
    <article className="canvas-card" data-cell={id}>
      <div className="bcell-top">
        <span className="bcell-meta">{['main', hhmm(o?.created || o?.updated)].filter(Boolean).join(' · ')}</span>
        <span className="lean-card-acts" onMouseDown={(e) => e.stopPropagation()}>
          {d?.versions && d.versions.length > 1 && <span className="lean-card-versions">{d.versions.map((x) => `v${x.v}`).join(' · ')}</span>}
          {thread && (
            <button type="button" className="lean-card-thread" title={thread.turns.find((x) => x.role === 'user')?.text || ''} onClick={(e) => (e.stopPropagation(), setState({ thread: thread.id }))}>
              ↳ 1 thread
            </button>
          )}
          <button type="button" className="lean-card-open" onClick={open}>
            {selected && <kbd>1</kbd>} Open
          </button>
        </span>
      </div>
      <div className="bcell-head">
        <span className="bcell-q">
          <span className="bcell-q-text">{o?.question || o?.title || id}</span>
        </span>
      </div>
      <div className="bcell-body">
        {!d && (
          <div className="bcell-run" role="status">
            <Spinner size={10} label="drawing" />
            <span>drawing</span>
          </div>
        )}
        {d?.error && <div className="lean-card-error">× {id} {d.error}</div>}
        {d && !d.error && (
          <>
            {(d.title || d.right) && (
              <div className="lean-card-frame">
                <span>{d.title}</span>
                <span className="lean-card-right">{d.right}</span>
              </div>
            )}
            <div className="lean-svg" dangerouslySetInnerHTML={{ __html: d.svg }} />
            {d.bottom && <div className="lean-card-bottom">{d.bottom}</div>}
          </>
        )}
      </div>
      {o?.text && (
        <div className="bcell-take">
          <div className="chat-text bcell-take-text">
            <CitedText text={String(o.text)} onCite={(ref, label) => setTimeout(() => pushCite({ kind: 'cite', ref, label }), 0)} />
          </div>
        </div>
      )}
    </article>
  )
}
