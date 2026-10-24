// client.tsx: the one Client module that draws every card. Claude Code runs it in the terminal's drawing thread; draw.ts
// names it by this file and hands it the card's drawing as props: {tree, width, need, ack, tint, accent}, the plain tree the runner
// made of the view (Box, Text and Button nodes with the props each element takes), or null before there is one. It
// holds no data and no logic of the card. It sends the hooks module events:
//
//   {seen: true}                    once, when the instance is first drawn: the card is on screen, so it takes keys
//   {draw: need}                    the drawing it needs (`<version>:<width>`), once for each: the card's first
//                                   drawing in a resumed session, or the drawing at a new width
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

/** The words a node draws: a row's side by side, a column's one line under another. */
function wordsOf(n: Node): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const col = n.t === 'Box' && (n.p?.flexDirection === 'column' || n.p?.flexDirection === 'column-reverse')
  return (Array.isArray(n.c) ? n.c : []).map(wordsOf).join(col ? '\n' : '')
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

  // every run of words the view drew (a label, a bar, a number) takes a click: the item it stands in when the card's
  // keys select one there (runner.mjs pick), else a side thread about the run (draw.ts). Each run shows it is
  // clickable under the pointer: thimble's tint behind it (`tint`, the citations' hover, for the theme the drawing is in) and its words
  // underlined; a bar of glyphs, which fills its cells and so hides a tint, takes thimble's color (`accent`) in place of
  // its own. Never Claude Code's inverse of a plain Button. The Button holds only the run's one Text, as a Button holds
  // strings and Text only (Claude Code draws no Button that holds a Box), so wrapping a run never breaks a card that
  // drew without it. Not inside the view's own Buttons (a Button around lines is a Box with onPress), and not at all on
  // a card that reads clicks by cell (the runner marks its tree `cells`), so the view's clicks come first
  const cells = !!(props?.tree && typeof props.tree === 'object' && props.tree.p?.cells)
  let asks = 0
  const tint = typeof props?.tint === 'string' && props.tint ? { backgroundColor: props.tint } : {}
  const accent = typeof props?.accent === 'string' && props.accent ? props.accent : ''
  /** A run of words (a Text's props and children) that takes a click; `text` its words, `path` its place in the
   *  tree. */
  const askable = (p: Record<string, unknown>, children: Any[], text: string, line: string, path: number[]): Any => {
    if (!text.trim()) return E.Text({ ...p, children })
    const key = `ask-${++asks}`
    const scope = `${me.id}-${key}`
    const words = /[\p{L}\p{N}]/u.test(text)
    const look = words ? { underline: true, ...tint } : accent ? { color: accent } : tint
    return E.Button({
      key, plain: true, label: `ask about ${text.trim().slice(0, 60)}`,
      hover: { scope, inverse: false, ...look },
      onPress: () => send({ ask: { text, line, path }, width }),
      children: [E.Text({ ...p, hover: { scope, ...look }, children })],
    })
  }
  const kids = (c: Node[] | undefined, inText: boolean, line = '', owned = false, path: number[] = []): Any[] => (Array.isArray(c) ? c : []).map((k, i) => draw(k, inText, line, owned, [...path, i])).filter(x => x != null)
  function draw(n: Node, inText: boolean, line = '', owned = false, path: number[] = []): Any {
    if (typeof n === 'string') return inText ? n : owned || cells ? E.Text({ children: n }) : askable({}, [n], n, line || n, path)
    if (!n || typeof n !== 'object') return null
    if (n.t === 'Text') {
      if (inText || owned || cells) return E.Text({ ...pick(n.p, TEXT), children: kids(n.c, true) })
      const text = wordsOf(n)
      return askable(pick(n.p, TEXT), kids(n.c, true), text, line || text, path)
    }
    if (inText) return null
    if (n.t === 'Button') {
      const press = n.p?.onPress
      const key = typeof n.p?.key === 'string' ? `k${n.p.key}` : `b${String(press)}`
      return E.Button({
        ...pick(n.p, BUTTON), key,
        onPress: () => { if (typeof press === 'number') send({ press, width }) },
        children: kids(n.c, true),
      })
    }
    if (n.t === 'Box') {
      // a row's runs each ask about themselves on that row's line (a bar beside its label and number)
      const row = n.p?.flexDirection !== 'column' && n.p?.flexDirection !== 'column-reverse'
      return E.Box({ ...pick(n.p, BOX), children: kids(n.c, false, row ? line || wordsOf(n) : '', owned || typeof n.p?.onPress === 'number', path) })
    }
    return null
  }

  // the region the card's tree is laid out in, as layout.js's cardRoot lays it out for the text copy: what is wider is
  // cut at its edge, as the copy says, so a view never draws over the frame. The frame hands only a drawing laid out at
  // this width (draw.ts), and none while that drawing comes; should the region still be narrower (the frame squeezed
  // in a chat narrower than it was told), the tree keeps its width and is cut at the region's edge: no row of it wraps
  const tree = props?.tree ? draw(props.tree, false) : E.Text({ dimColor: true, children: 'drawing…' })
  const laid = E.Box({ flexDirection: 'column', width, flexShrink: 0, children: [tree] })
  return E.Box({ flexDirection: 'column', width, overflow: 'hidden', children: [laid] })
}

export default Card
