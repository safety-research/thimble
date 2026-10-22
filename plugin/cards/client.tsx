// client.tsx: the one Client module that draws every card. Claude Code runs it in the terminal's drawing thread; draw.ts
// names it by this file and hands it the card's drawing as props: {tree, width, need, ack}, the plain tree the runner
// made of the view (Box, Text and Button nodes with the props each element takes), or null before there is one. It
// holds no data and no logic of the card. It sends the hooks module events:
//
//   {seen: true}                    once, when the instance is first drawn: the card is on screen, so it takes keys
//   {draw: need}                    the drawing it needs (`<version>:<width>`), once for each: the card's first
//                                   drawing in a resumed session, or the drawing at a new width
//   {rows: n}                       the rows its region takes, when they change: where the card stands in its row,
//                                   so the hooks know whether the screen shows it
//   {press: n}                      a Button, by the number the runner gave its onPress
//   {pointer: {down, up, button}}   a click, sent when the button comes up
//
// A drawing hook may not write the session's state, so the card's frame asks through its Client, whose posts reach a
// hook that may.
//
// It sets no key listener: the card's keys reach it at an empty prompt (draw.ts cardKey), so a click on the card never
// takes the keyboard from the prompt box.
//
// A frame carries one post, and a later post in the same frame takes the place of one not yet delivered (a click on a
// Button makes both a press and a pointer event). So each post carries every event the hooks have not yet answered,
// numbered; draw.ts handles each number once and answers the last one it handled as `ack`.
import type { ClientModule, ClientSurface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Node = { t: string; p?: Record<string, unknown>; c?: Array<Node | string> } | string

const BOX = ['flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap',
  'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow',
  'display', 'position', 'top', 'left', 'right', 'bottom']
const TEXT = ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap']
const BUTTON = ['label', 'plain', 'dimColor', 'variant']

type Instance = { id: string; n: number; queue: Array<Record<string, unknown>>; down: { x: number; y: number; button: string } | null; asked: string; rows: number }
const instances = new WeakMap<object, Instance>()

function pick(p: Record<string, unknown> | undefined, names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!p) return out
  for (const k of names) {
    const v = p[k]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

const Card: ClientModule<Any> = (props: Any, surface: ClientSurface) => {
  const E = surface.elements as Any
  const width = Number(props?.width) || surface.columns || 80
  let I = instances.get(surface)
  if (!I) {
    I = { id: Math.random().toString(36).slice(2, 10), n: 0, queue: [], down: null, asked: '', rows: 0 }
    instances.set(surface, I)
  }
  const fresh = I.n === 0
  const me = I
  const ack = Number(props?.ack?.[me.id]) || 0
  if (ack) me.queue = me.queue.filter(x => Number(x.n) > ack)
  const send = (ev: Record<string, unknown>) => {
    me.queue = [...me.queue, { n: ++me.n, ...ev }].slice(-20)
    surface.post({ client: me.id, events: me.queue })
  }
  if (fresh) send({ seen: true })
  if (surface.rows && surface.rows !== me.rows) {
    me.rows = surface.rows
    send({ rows: surface.rows })
  }
  const need = typeof props?.need === 'string' ? props.need : ''
  if (need && me.asked !== need) {
    me.asked = need
    send({ draw: need })
  }

  surface.onPointer(ev => {
    if (ev.type === 'down') me.down = { x: ev.x, y: ev.y, button: ev.button || 'left' }
    if (ev.type !== 'up' || !me.down) return
    const d = me.down
    me.down = null
    send({ pointer: { down: { x: d.x, y: d.y }, up: { x: ev.x, y: ev.y }, button: d.button } })
  })

  const kids = (c: Node[] | undefined, inText: boolean): Any[] => (Array.isArray(c) ? c : []).map(k => draw(k, inText)).filter(x => x != null)
  function draw(n: Node, inText: boolean): Any {
    if (typeof n === 'string') return inText ? n : E.Text({ children: n })
    if (!n || typeof n !== 'object') return null
    if (n.t === 'Text') return E.Text({ ...pick(n.p, TEXT), children: kids(n.c, true) })
    if (inText) return null
    if (n.t === 'Button') {
      const press = n.p?.onPress
      const key = typeof n.p?.key === 'string' ? `k${n.p.key}` : `b${String(press)}`
      return E.Button({
        ...pick(n.p, BUTTON), key,
        onPress: () => { if (typeof press === 'number') send({ press }) },
        children: kids(n.c, true),
      })
    }
    if (n.t === 'Box') return E.Box({ ...pick(n.p, BOX), children: kids(n.c, false) })
    return null
  }

  // the region the card's tree is laid out in, as layout.js's cardRoot lays it out for the text copy: what is wider is
  // cut at its edge, as the copy says, so a view laid out for a wider card never draws over the frame (a side pane
  // that opens narrows the card before the view draws again)
  const tree = props?.tree ? draw(props.tree, false) : E.Text({ dimColor: true, children: 'drawing…' })
  return E.Box({ flexDirection: 'column', width, overflow: 'hidden', children: [tree] })
}

export default Card
