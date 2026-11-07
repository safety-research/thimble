// client.tsx: the one Client module that draws every card. Claude Code runs it in the terminal's drawing thread; draw.ts
// names it by this file and hands it the card's drawing as props: {tree, width, need, ack, tint, accent, theme, cap}, the plain tree the runner
// made of the view (Box, Text and Button nodes with the props each element takes), or null before there is one. It
// holds no data and no logic of the card. What it draws of the tree is drawn.js's, which the runner measures the
// drawing with. It sends the hooks module events:
//
//   {seen: true}                    once, when the instance is first drawn: the card is on screen, so it takes keys
//   {draw: need}                    the drawing it needs (`<version>:<width>:<state>`, draw.ts needOf), once for each:
//                                   the card's first drawing in a resumed session, the drawing at a new width, or the
//                                   drawing of a state a key gave the card at another frame's width
//   {rows: n}                       the rows its region takes, when they change: where the card stands in its row,
//                                   so the hooks know whether the screen shows it
//   {press: n, width}               a Button, by the number the runner gave its onPress, in the drawing at `width`
//   {pointer: {down, up, button}, width}   a click, sent when the button comes up (a Button around lines, the view's
//                                   onPointer, the item its keys select there: runner.mjs)
//   {ask: {text, line, path}, width}  a click on a run of words the view drew outside its Buttons, which this module
//                                   wraps in a Button of its own (and a Button takes the click, so no pointer event
//                                   comes): the item on its line when the card's keys select one there (`path`, the
//                                   run's place in the tree), else a side thread about the run, `line` the words of
//                                   its row (draw.ts)
//
// Each post carries the width the instance draws at; the hooks answer with the drawing at the width the instance's
// frame draws at now (a card shows at two widths at once when a side pane holds its copy).
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

import { cardElement } from './drawn.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

type Instance = { id: string; n: number; queue: Array<Record<string, unknown>>; down: { x: number; y: number; button: string } | null; asked: string; rows: number }
const instances = new WeakMap<object, Instance>()

const Card: ClientModule<Any> = (props: Any, surface: ClientSurface) => {
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
    surface.post({ client: me.id, width, events: me.queue })
  }
  if (fresh) send({ seen: true })
  if (surface.rows && surface.rows !== me.rows) {
    me.rows = surface.rows
    send({ rows: surface.rows })
  }
  const need = typeof props?.need === 'string' ? props.need : ''
  // a drawing at its width came: a later need of the same width (a key changed the card while this one showed its
  // drawing at another width) is asked again
  if (!need) me.asked = ''
  if (need && me.asked !== need) {
    me.asked = need
    send({ draw: need })
  }

  surface.onPointer(ev => {
    if (ev.type === 'down') me.down = { x: ev.x, y: ev.y, button: ev.button || 'left' }
    if (ev.type !== 'up' || !me.down) return
    const d = me.down
    me.down = null
    send({ pointer: { down: { x: d.x, y: d.y }, up: { x: ev.x, y: ev.y }, button: d.button }, width })
  })

  // the card's drawing (drawn.js), which the runner measures as Claude Code holds it before the card is shown
  return cardElement(props, { E: surface.elements, id: me.id, width, send })
}

export default Card
