// CardDetail.tsx: a card's detail as one layout: the chat column shows the card's thread (ChatPanel), the main panel
// the card's detail under a path back to the Canvas. The detail itself is the detail pane's program (lean/panes/
// detail.js), the one the terminal draws: a header (title, card id, v1 · v2), the takeaway, the card enlarged with its
// parts, and a bar under it that starts empty and fills on demand with the selected part's details and examples; the
// program behind p. Its state (the part selected, what the bar shows) is the terminal's too, so the card opens here
// where the terminal left it and the other way round. The card's own keys and presses (its program's k.on) come before
// the detail's; the state the card answers with is kept by the terminal for both surfaces. A question typed in the chat
// is about the part selected. 0, esc or ← Canvas goes back to the board.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@09/components/Icon'
import { back as sendBack, objectOf } from '../lib/api'
import { columnsIn, drawingOf, eventOf, eventsLib } from '../lib/draw'
import { ask } from '../lib/actions'
import { cardGroups, cardThread, getState, setState, useStore } from '../lib/store'
import { PaneView } from '../panes/PaneView'

const back = () => setState({ card: null, thread: 'main', detailBar: null })
const ROW_H = 20

export function CardDetail() {
  const card = useStore((s) => s.card)!
  const rows = useStore((s) => s.rows)
  const objects = useStore((s) => s.objects)
  const threads = useStore((s) => s.threads)
  const groups = useMemo(() => cardGroups(rows, objects), [rows, objects])
  const group = groups.find((g) => g.cards.some((c) => c.id === card.id))
  const col = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ w: 900, h: 640 })
  useEffect(() => {
    const el = col.current
    if (!el) return
    const fit = () => setRoom({ w: Math.max(560, el.clientWidth - 24), h: Math.max(320, el.clientHeight - 16) })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cols = columnsIn(room.w)
  const lines = Math.max(16, Math.floor(room.h / ROW_H))
  // the card's interaction state: where the person (here or in the terminal) left it, kept by the terminal session
  const cardState = useStore((s) => s.cardStates[card.id])
  const [object, setObject] = useState<{ object: any; versions: any[] } | null>(null)
  useEffect(() => {
    let alive = true
    void objectOf(card.id, card.v).then((r) => {
      if (!alive || r.error) return
      setObject({ object: r.object, versions: r.versions || [] })
      const kept = r.state
      if (kept && getState().cardStates[card.id] === undefined) setState((s) => ({ cardStates: { ...s.cardStates, [card.id]: kept.state || {} } }))
    })
    return () => {
      alive = false
    }
  }, [card.id, card.v])
  // the card's drawing at the detail's width, in the sandbox, with its state: the detail's program embeds it
  const [drawing, setDrawing] = useState<any>(null)
  const stateKey = JSON.stringify(cardState || {})
  useEffect(() => {
    if (!object?.object) return
    let alive = true
    void drawingOf(object.object, { w: cols - 2, mode: 'detail', state: cardState || {} }).then((d) => alive && setDrawing(d))
    return () => {
      alive = false
    }
  }, [object, cols, stateKey])
  const thread = cardThread(threads, card.id)
  const extra = useMemo(() => ({
    [`card:${card.id}`]: object?.object
      ? { object: object.object, drawing, versions: object.versions, v: card.v ?? object.object.version ?? null, state: cardState || {}, thread: !!thread, browser: false }
      : null,
  }), [object, drawing, card.v, stateKey, !!thread])

  // what the person does on the card itself, as its program's event (k.on): the state it answers with is kept here and
  // sent to the terminal session, which keeps it for both surfaces; an ask(selection) points the chat's next question
  const fireCard = (event: Record<string, unknown>): boolean => {
    const o = object?.object
    if (!o || !drawing) return false
    const on: { name: string }[] = drawing.on || []
    const names = [event.type === 'key' ? String(event.key) : '', String(event.type), event.region ? `${event.type}:${event.region}` : ''].filter(Boolean)
    // the detail keeps its own way out and its moves between parts
    if (event.type === 'key' && ['esc', '0', 'up', 'down', 'tab', 'return'].includes(String(event.key))) return false
    if (!on.some((h) => names.includes(h.name) || (event.type === 'key' && h.name === 'key'))) return false
    void (async () => {
      const got = await eventOf(o, { w: cols - 2, state: cardState || {}, event: { ...event, ...(card.region && !event.region ? { region: card.region } : {}) } })
      if (got?.error) {
        setState({ sent: { text: `the card could not answer: ${got.error.name} · fix: ${got.error.fix || 'its program'}`, at: Date.now(), error: got.error.message } })
        return
      }
      const st = got.state || cardState || {}
      setState((s) => ({ cardStates: { ...s.cardStates, [card.id]: st } }))
      void sendBack({ cardstate: { object: card.id, region: card.region, state: st } })
      const a = got.ask
      if (a && a.text) void ask(a.text, { object: card.id, ...(o.version != null ? { v: o.version } : {}), ...(a.region ? { region: a.region } : {}), label: a.label, ...(a.refs ? { refs: a.refs } : {}) })
      else if (a) setState({ cardAsk: { object: card.id, label: a.label, ...(a.region ? { region: a.region } : {}), ...(a.refs ? { refs: a.refs } : {}) } })
    })()
    return true
  }
  // a drag across a brush area of the card (k.plot's brush, a canvas's c.brush) is its program's brush event
  const brushHost = useRef<HTMLDivElement>(null)
  const fireRef = useRef(fireCard)
  fireRef.current = fireCard
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
  }, [!!drawing])

  // what the detail's program asks of the page: the card's state (a knob, the zoom, the filter), another version, the
  // card's thread in the chat
  const actions = useMemo(() => ({
    card: (e: Record<string, unknown>) => {
      const st = (e.state && typeof e.state === 'object' ? e.state : {}) as Record<string, unknown>
      setState((s) => ({ cardStates: { ...s.cardStates, [card.id]: st } }))
      void sendBack({ cardstate: { object: card.id, region: getState().card?.region ?? null, state: st } })
    },
    version: (e: Record<string, unknown>) => setState((s) => ({ card: s.card ? { ...s.card, v: Number(e.v) } : null })),
    thread: () => {
      const t = cardThread(getState().threads, card.id)
      setState({ thread: t ? t.id : `card:${card.id}` })
    },
  }), [card.id])

  return (
    <div className="board" data-panel="canvas">
      <div className="board-stage">
        <div className="bfocus lean-detail" onMouseDown={(e) => e.stopPropagation()}>
          <div className="bfocus-stage">
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
                <kbd>esc</kbd> back to Canvas
              </span>
            </nav>
            <div className="bfocus-main lean-detail-main">
              <div className="bfocus-col is-wide lean-detail-col" ref={col}>
                <article className="bfocus-card lean-detail-page" data-cell={card.id} ref={brushHost}>
                  <PaneView
                    name="detail"
                    args={{ id: card.id }}
                    extra={extra}
                    columns={cols}
                    rows={lines}
                    focus
                    before={fireCard}
                    keysFirst={drawing}
                    actions={actions}
                    onState={(st) => setState((s) => ({ card: s.card && s.card.id === card.id ? { ...s.card, region: typeof st.region === 'string' ? st.region : s.card.region } : s.card }))}
                    onClose={back}
                  />
                </article>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

