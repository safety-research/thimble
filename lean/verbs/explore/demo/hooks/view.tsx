// The explore view's surface module: it draws the lines the hooks module laid out and sends it the person's keys
// and clicks. It keeps no view state of its own: the hooks module turns knobs, moves the selection and reads rows,
// and hands back the next lines as props. Keys reach it once a click has given it the keyboard; Esc gives it back.
import type { ClientModule } from 'claude-code'

type Seg = { s: string; fg?: string; bg?: string; b?: boolean; u?: boolean }
type Props = { id: string; lines: Seg[][]; cols: number; ack: number }
type Sent = { seq: number; k?: string; x?: number; y?: number }

// keys and clicks not yet acknowledged, per view: every post carries them all, so a post the engine replaced in the
// same frame loses nothing
const pending = new Map<string, Sent[]>()
let seq = 0

function send(surface: Parameters<ClientModule>[1], id: string, ack: number, s: Omit<Sent, 'seq'>): void {
  const list = (pending.get(id) || []).filter(x => x.seq > ack)
  list.push({ seq: ++seq, ...s })
  pending.set(id, list.slice(-16))
  surface.post({ type: 'explore', id, sent: pending.get(id) as never })
}

const names: Record<string, string> = { return: 'enter', enter: 'enter', left: 'left', right: 'right', up: 'up', down: 'down', tab: 'tab' }

const ExploreView: ClientModule<Props> = (props, surface) => {
  const { Box, Text } = surface.elements
  pending.set(props.id, (pending.get(props.id) || []).filter(x => x.seq > props.ack))
  surface.onKey(ev => {
    const k = names[ev.key]
    if (!k) return
    send(surface, props.id, props.ack, { k: (ev.shift ? 'shift+' : '') + k })
  })
  surface.onPointer(ev => {
    if (ev.type === 'down' && (ev.button ?? 'left') === 'left') send(surface, props.id, props.ack, { x: ev.x, y: ev.y })
  })
  return Box({
    flexDirection: 'column',
    width: props.cols,
    children: props.lines.map(line => Text({
      wrap: 'truncate-end',
      children: line.length ? line.map(g => Text({ children: g.s, ...(g.fg ? { color: g.fg } : {}), ...(g.bg ? { backgroundColor: g.bg } : {}), ...(g.b ? { bold: true } : {}), ...(g.u ? { underline: true } : {}) })) : ' ',
    })),
  })
}
export default ExploreView
