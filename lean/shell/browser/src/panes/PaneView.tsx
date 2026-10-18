// PaneView.tsx: one pane of thimble's own (lean/panes/: the Claims graph, the squeeze chips, the card detail) drawn in
// the page from the same program file and the same stores the terminal uses. Its state is where either surface left
// it (thimble/panes/<session>/<key>.json): what the person does here is the program's event, and the state it answers
// with goes to the terminal, which keeps it and draws the same. An action the program asks for (k.do) that the page
// can do itself (open a message or a card, close) is done here; any other goes to the terminal, as a press there would.
//
// Events: a click is a press on the part under it, the pointer on a part a hover (it stays until another part or the
// pointer leaves), a drag across a brush area a brush, and a key (while no text field has the focus) a key event. The
// keys the program takes, in words, go to the app's bar (KeyBar) while this pane has the focus.
import { useEffect, useMemo, useRef, useState } from 'react'
import { back } from '../lib/api'
import { columnsIn, eventsLib, svgOf } from '../lib/draw'
import { getState, setState, useStore } from '../lib/store'
import { paneModules, pushLayer, readPaneState, readStore, readWant, topLayer, type PaneModule } from './lib'

const ROW_H = 20

export interface PaneProps {
  name: string
  args?: Record<string, unknown>
  /** this pane takes the keys and names them in the bar */
  focus?: boolean
  /** rows to draw in, when the pane does not fill its box (the chips: one row) */
  rows?: number
  /** the program asked to close (k.do('close')) */
  onClose?: () => void
  /** the drawing, each time it changes (a host that draws chrome around it reads its title or its keys) */
  onDrawing?: (d: any) => void
  /** the drawing is on the page (a host that scrolls it into view) */
  onDrawn?: () => void
  /** extra data stores the host has in hand (the card detail's card drawing), merged over the pane's own reads */
  extra?: Record<string, unknown>
  /** the columns to draw in, when the host measures its own room (the detail draws its card at the same width) */
  columns?: number
  /** a program under this one that takes events first (the card inside its detail): true when it took the event */
  before?: (event: Record<string, unknown>) => boolean
  /** its keys come before this pane's in the bar (the card's own) */
  keysFirst?: any
  /** actions the host does itself (k.do), by name; any other goes to the terminal */
  actions?: Record<string, (e: Record<string, unknown>) => void>
  /** the state the program answered with, each time it changes */
  onState?: (state: Record<string, unknown>) => void
  /** the state the host sets (the tray's cards a mark opened): drawn, and sent to the terminal as the pane's state */
  state?: Record<string, unknown> | null
  /** this surface's own state to start from (its local keys, such as the claim a link opened the graph on) */
  seed?: Record<string, unknown> | null
  className?: string
}

export function PaneView({ name, args = {}, focus = true, rows, onClose, onDrawing, onDrawn, extra, columns, before, keysFirst, actions, onState, state: given, seed, className }: PaneProps) {
  const ver = useStore((s) => s.version)
  const msgs = useStore((s) => s.rows)
  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState({ w: 900, h: 560 })
  const [mods, setMods] = useState<Awaited<ReturnType<typeof paneModules>> | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [stores, setStores] = useState<Record<string, unknown> | null>(null)
  const [state, setLocal] = useState<Record<string, unknown>>(() => ({ ...(seed || {}), ...(given || {}) }))
  const [loaded, setLoaded] = useState(false)
  const [got, setGot] = useState<Record<string, unknown>>({})
  const [svg, setSvg] = useState<string>('')
  const [input, setInput] = useState<{ label: string; event: string; prefix?: string } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const timers = useRef<Record<string, number>>({})
  const asked = useRef<Set<string>>(new Set())
  const hovered = useRef<string | null>(null)
  const argsKey = JSON.stringify(args)

  useEffect(() => {
    void paneModules().then(setMods, (err) => setProblem(`the pane's program did not load (${String(err?.message || err).slice(0, 120)}): reload the page`))
  }, [])
  const pane: PaneModule | null = mods ? mods.panes[name] ?? null : null
  const key = pane ? pane.stateKey(args) : null

  // the room it has
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setPx({ w: Math.max(320, el.clientWidth - 8), h: Math.max(ROW_H * 4, el.clientHeight - 8) })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // its stores, read again on each change the server announces
  useEffect(() => {
    if (!pane) return
    let alive = true
    const names = pane.reads(args)
    void Promise.all(names.map((n) => readStore(n))).then((vals) => {
      if (alive) setStores(Object.fromEntries(names.map((n, i) => [n, vals[i]])))
    })
    return () => {
      alive = false
    }
  }, [pane, argsKey, ver, msgs])

  // the keys of its state this surface keeps for itself (a hover, a replay): never sent, never taken from the other
  const localRef = useRef<string[]>(Array.isArray((pane as any)?.local) ? (pane as any).local : [])
  const sharedOf = (st: Record<string, unknown>) => (mods ? mods.host.shared(st, localRef.current) : st)
  // its state: where either surface left it, at first and whenever the terminal changes it; this surface's own keys
  // stay as they are
  useEffect(() => {
    if (!key || !mods) return
    let alive = true
    void readPaneState(key).then((r) => {
      if (!alive) return
      const st = r?.state && typeof r.state === 'object' ? r.state : null
      const next = st ? mods.host.joinShared(stateRef.current, st, localRef.current) : null
      if (next && (!loaded || r?.by !== 'browser') && JSON.stringify(next) !== JSON.stringify(stateRef.current)) {
        stateRef.current = next
        setLocal(next)
        onState?.(next)
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [key, ver, mods])
  // a state the host set (a mark opened in the tray): drawn here and kept for the terminal
  const givenKey = given ? JSON.stringify(given) : ''
  useEffect(() => {
    if (!given || !mods) return
    const next = { ...stateRef.current, ...given }
    if (JSON.stringify(next) === JSON.stringify(stateRef.current)) return
    stateRef.current = next
    setLocal(next)
    void back({ panestate: { pane: name, args, state: sharedOf(next) } } as never)
  }, [givenKey, mods])

  const cols = columns ?? columnsIn(px.w)
  const lines = rows ?? Math.max(6, Math.floor(px.h / ROW_H))
  const allStores = useMemo(() => (stores ? { ...stores, ...(extra || {}) } : null), [stores, extra])
  const data = useMemo(() => {
    if (!pane || !allStores) return null
    try {
      return pane.data(allStores, args, { w: cols, h: lines })
    } catch (err: any) {
      setProblem(`${pane.title} could not read its data: ${String(err?.message || err).slice(0, 160)}`)
      return null
    }
  }, [pane, allStores, argsKey, cols, lines])
  const run = (st: Record<string, unknown>, event: Record<string, unknown> | null, g = got) =>
    mods!.kit.run(pane!.program, data, { w: cols, h: lines, state: st, event, mode: 'pane', surface: 'browser', got: g, title: pane!.title, id: name })
  const drawing = useMemo(() => (mods && pane && data ? run(state, null) : null), [mods, pane, data, state, got])
  if (drawing && mods) localRef.current = mods.host.localKeys(drawing, pane)

  // what it wants that it does not hold: read once, then drawn again with it
  useEffect(() => {
    if (!drawing || !mods) return
    for (const w of mods.host.wantsOpen(drawing, got) as { key: string; request: unknown }[]) {
      if (asked.current.has(w.key)) continue
      asked.current.add(w.key)
      void readWant(w.request).then((v) => setGot((g) => ({ ...g, [w.key]: v })))
    }
  }, [drawing])

  // the drawing as SVG
  useEffect(() => {
    if (!drawing) return
    let alive = true
    onDrawing?.(drawing)
    void svgOf(drawing, { w: cols, selected: drawing.selected ?? null }).then((r) => {
      if (!alive) return
      setSvg(r.svg)
      if (onDrawn) requestAnimationFrame(() => onDrawn())
    })
    return () => {
      alive = false
    }
  }, [drawing, cols])

  // on the focus stack while it takes keys: a key goes to it when it is on top, or when the panes above do not take it
  const layerId = `${name}|${argsKey}`
  useEffect(() => {
    if (!focus) return
    const off = pushLayer({ id: layerId, fire: (ev) => fireRef.current(ev), publish: () => publishRef.current() })
    return () => {
      if (getState().keybar?.from === layerId) setState({ keybar: null })
      off()
    }
  }, [focus, layerId])
  // its keys in the app's bar while it is on top
  const publish = () => {
    if (!focus || !drawing || !mods || topLayer() !== layerId) return
    setState({ keybar: { from: layerId, keys: mods.host.barText(keysFirst ? [keysFirst, drawing] : [drawing]), status: drawing.status?.text || null } })
  }
  const publishRef = useRef(publish)
  publishRef.current = publish
  useEffect(publish, [focus, drawing, mods, layerId, keysFirst])

  /** What the person did, as the program's event. True when the program took it. */
  const fire = (event: Record<string, unknown>): boolean => {
    if (!mods || !pane || !data || !drawing) return false
    if (before && before(event)) return true
    if (!mods.host.takes(drawing, event)) return false
    const d = run(stateRef.current, event)
    if (d.error) {
      setState({ sent: { text: `${pane.title} could not answer: ${d.error.name} · fix: ${d.error.fix || 'its program'}`, at: Date.now(), error: d.error.message } })
      return true
    }
    const next = mods.host.nextState(stateRef.current, d)
    if (!mods.host.same(next, stateRef.current)) {
      const keys = mods.host.localKeys(d, pane)
      // only what every surface shares goes to the terminal: a hover or a replay stays on this page
      const sharedChanged = !mods.host.same(mods.host.shared(next, keys), mods.host.shared(stateRef.current, keys))
      stateRef.current = next
      setLocal(next)
      onState?.(next)
      if (sharedChanged) void back({ panestate: { pane: name, args, state: mods.host.shared(next, keys) } } as never)
    }
    for (const a of (d.after || []) as { ms: number; event: Record<string, unknown> }[]) {
      const n = String(a.event.type)
      window.clearTimeout(timers.current[n])
      timers.current[n] = window.setTimeout(() => fireRef.current(a.event), Math.max(30, a.ms))
    }
    for (const e of (d.effects || []) as Record<string, unknown>[]) effect(e)
    if (d.ask) setState({ paneAsk: { pane: name, args, ask: d.ask } })
    return true
  }
  const fireRef = useRef(fire)
  fireRef.current = fire
  useEffect(() => () => Object.values(timers.current).forEach((t) => window.clearTimeout(t)), [])

  /** An action the program asked for: done here when the page can, else in the terminal. */
  const effect = (e: Record<string, unknown>) => {
    const what = String(e.do || '')
    if (actions && actions[what]) return actions[what](e)
    if (what === 'close') return onClose?.()
    if (what === 'open' && typeof e.row === 'string') return setState({ thread: 'main', flashRow: e.row })
    if (what === 'open' && typeof e.object === 'string') return setState({ surface: 'canvas', card: { id: e.object, v: typeof e.v === 'number' ? e.v : null, region: typeof e.region === 'string' ? e.region : null } })
    if (what === 'input') return setInput({ label: String(e.label || ''), event: String(e.event || 'input'), ...(typeof e.prefix === 'string' ? { prefix: e.prefix } : {}) })
    void back({ act: { ...e, pane: name, args } } as never).then((r) => {
      if (r.error) setState({ sent: { text: `not sent: ${r.error}`, at: Date.now(), error: r.error } })
    })
  }

  // a drag across a brush area
  useEffect(() => {
    const el = host.current
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

  const regionAt = (t: EventTarget | null) => (t as Element | null)?.closest?.('[data-region]')?.getAttribute('data-region') ?? null
  return (
    <div ref={box} className={`lean-pane ${className || ''}`} data-pane={name}>
      {problem && <div className="lean-card-error">× {problem}</div>}
      <div
        ref={host}
        className="lean-svg lean-pane-svg"
        onClick={(e) => {
          const r = regionAt(e.target)
          fire({ type: 'press', region: r })
        }}
        onMouseMove={(e) => {
          const r = regionAt(e.target)
          // off every part the hover stays where it is (the card of a claim stays to be read); back on a part it is
          // that part's again
          if (!r) { hovered.current = null; return }
          if (r === hovered.current) return
          hovered.current = r
          fire({ type: 'hover', region: r })
        }}
        onMouseLeave={() => {
          if (hovered.current == null) return
          hovered.current = null
          fire({ type: 'hover', region: null })
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {input && (
        <form
          className="lean-pane-input"
          onSubmit={(e) => {
            e.preventDefault()
            const el = (e.currentTarget.elements.namedItem('t') as HTMLInputElement) || null
            const text = `${input.prefix || ''}${el?.value || ''}`
            setInput(null)
            fire({ type: input.event, text })
          }}
        >
          <input name="t" autoFocus placeholder={input.label} onKeyDown={(e) => e.key === 'Escape' && setInput(null)} />
        </form>
      )}
    </div>
  )
}
