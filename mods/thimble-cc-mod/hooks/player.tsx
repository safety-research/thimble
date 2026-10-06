// The player: a Client surface module (no `$`) that plays an answer's storyboard (play.ts) in the panel. Its own frame
// clock (surface.every) moves the scene's time; each frame draws its title row (the scene's number of all, a progress
// bar on a track, the clock, and `▶ play` or `pause`, `back`, `next`, `restart` against the right edge), the scene's
// heading, its card as
// anim.ts draws it at that time (the value the caption on screen cites lit, its label at the right of the question),
// a text scene's cited values as tiles counting up, and the captions typing in, a paragraph's sentences running on and
// paragraphs a blank row apart. Keys reach it once a click has given
// it the focus (space, ←/→, r, q, and the buttons' letters); until then the panel holds the keys, and its buttons'
// letters (p, b, n, r, q) reach the player through `cmd`. A click on a caption's citation goes to the gestures, which
// open its place, as anywhere else; a click on the progress bar goes to that scene.
import type { ClientModule, RenderElement } from 'claude-code'

import { animFrame, cropFrame, focusItem } from './anim'
import { paraLayout } from './cite'
import type { ChipView, ParaLayout } from './cite'
import { cut, cw, fold, lineWidth, width } from './draw'
import type { Line, Seg } from './draw'
import { onPointer, send } from './gestures'
import { COLORS, paintLine } from './paint'
import { FRAME_MS, START, applyOp, clockText, frameAt, headParts, keyOp, progress, sceneAt, seek, tick, timing } from './play'
import type { Caption, PlayCap, PlayOp, PlayScene, PlayState, Timing } from './play'
import type { Run } from './lib'

type Props = { scenes: PlayScene[]; head: string; cols: number; rows: number; cmd: { n: number; op: string } }
type S = { play: PlayState; cmd: number }

const latest = new WeakMap<object, Timing[]>()

const ease = (p: number) => 1 - (1 - Math.max(0, Math.min(1, p))) ** 3

/** The first `n` cells of `s`. */
function cells(s: string, n: number): string {
  let out = ''
  let w = 0
  for (const ch of s) {
    if (w + cw(ch) > n) break
    out += ch
    w += cw(ch)
  }
  return out
}

/** The first `n` cells of wrapped lines, in reading order: a caption typing in, laid out whole so it never reflows. */
function reveal(lines: readonly Line[], n: number): Line[] {
  const out: Line[] = []
  let left = n
  for (const l of lines) {
    if (left <= 0) break
    const segs: Line = []
    for (const s of l) {
      if (left <= 0) break
      const w = width(s.s)
      if (w <= left) segs.push(s)
      else segs.push({ ...s, s: cells(s.s, left) })
      left -= w
    }
    out.push(segs)
  }
  return out
}

const dimSeg = (s: Seg): Seg => (s.u ? s : { ...s, d: true })

/** `lines` with the cells outside [from, to), read in order, dimmed (a citation keeps its colour); segments split
 *  where the range starts or ends. */
function dimOutside(lines: readonly Line[], from: number, to: number): Line[] {
  let at = 0
  return lines.map(l => {
    const out: Line = []
    for (const s of l) {
      const w = width(s.s)
      const a = at
      at += w
      if (a >= from && a + w <= to) out.push(s)
      else if (a + w <= from || a >= to) out.push(dimSeg(s))
      else {
        // the range starts or ends inside this segment
        const cutAt = (n: number) => cells(s.s, Math.max(0, n - a))
        const head = cutAt(Math.max(from, a))
        const mid = cutAt(Math.min(to, a + w)).slice(head.length)
        const tail = s.s.slice(head.length + mid.length)
        if (head) out.push(dimSeg({ ...s, s: head }))
        if (mid) out.push({ ...s, s: mid })
        if (tail) out.push(dimSeg({ ...s, s: tail }))
      }
    }
    return out
  })
}

const cellsIn = (lines: readonly Line[]) => lines.reduce((n, l) => n + lineWidth(l), 0)

/** A paragraph of the captions typed so far: its lines as drawn, its layout (laid out whole, so typing never reflows
 *  it) and its citations in order, for a click; `gap`, a blank row above it. */
export type CapFlow = { lines: Line[]; lay: ParaLayout; chips: ChipView[]; ids: string[]; raws: string[]; gap: boolean }

/** The captions typed so far as the paragraphs they came from: a paragraph's sentences run on, a blank row between
 *  paragraphs (none between list items, each led by a bullet); the caption on screen at full strength, the others
 *  dimmed, the one typing cut where it has got to. A caption without a paragraph (a video's line) stands alone. */
export function captionFlows(caps: readonly PlayCap[], captions: readonly Caption[], typed: readonly number[], current: number, cols: number): CapFlow[] {
  const groups: number[][] = []
  caps.forEach((_, i) => {
    if ((typed[i] ?? 0) <= 0) return
    const last = groups.at(-1)
    const para = captions[i]?.para
    if (last && para !== undefined && captions[last.at(-1)!]?.para === para) last.push(i)
    else groups.push([i])
  })
  return groups.map((g, gi) => {
    const parts = g.map(i => caps[i]!)
    const item = Boolean(captions[g[0]!]?.item)
    const lead = parts[0]!.block
    const upTo = (n: number) => {
      const runs: Run[] = parts.slice(0, n).flatMap((c, j) => [...(j ? [{ text: ' ' }] : []), ...c.block.runs])
      return paraLayout({ prefix: item ? '- ' : lead.prefix, heading: 0, quote: lead.quote, runs }, parts.slice(0, n).flatMap(c => c.chips), cols, -1)
    }
    const lay = upTo(parts.length)
    // where each caption ends, in cells read in order: where the paragraph laid out up to it ends
    const ends = parts.map((_, j) => (j === parts.length - 1 ? cellsIn(lay.lines) : cellsIn(upTo(j + 1).lines)))
    const startOf = (j: number) => (j ? ends[j - 1]! : 0)
    const last = parts.length - 1
    const f = typed[g[last]!] ?? 0
    let lines = f >= 1 ? lay.lines : reveal(lay.lines, Math.round(startOf(last) + (ends[last]! - startOf(last)) * f))
    const k = g.indexOf(current)
    lines = k >= 0 ? dimOutside(lines, startOf(k), ends[k]!) : lines.map(l => l.map(dimSeg))
    const prevItem = gi > 0 && Boolean(captions[groups[gi - 1]![0]!]?.item)
    return { lines, lay, chips: parts.flatMap(c => c.chips), ids: parts.flatMap(c => c.ids), raws: parts.flatMap(c => c.raws), gap: gi > 0 && !(item && prevItem) }
  })
}

/** A shown value counting up with t: its digits scaled, its decimals, separators and words kept; other words typed. */
export function countUp(display: string, t: number): string {
  if (t >= 1) return display
  const m = /^(\D*?)([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/.exec(display)
  if (!m) return cells(display, Math.round(width(display) * t))
  const [, pre = '', sign = '', int = '', frac = '', post = ''] = m
  const places = frac ? frac.length - 1 : 0
  const v = Number(`${int.replace(/,/g, '')}${frac}`) * ease(t)
  let s = v.toFixed(places)
  if (int.includes(',')) {
    const [i = '', f] = s.split('.')
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '')
  }
  return `${pre}${sign}${s}${post}`
}

const Play: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = Math.max(30, Math.min(surface.columns || props.cols || 80, props.cols || 999))
  const H = Math.max(12, props.rows || surface.rows || 30)
  const scenes = props.scenes
  const tms = scenes.map(s => timing(s))
  latest.set(surface, tms)
  let st: S = surface.state ?? { play: START, cmd: props.cmd.n }
  if (st.play.scene >= scenes.length) st = { ...st, play: { ...START } }
  // a press of the panel's buttons: applied once
  if (props.cmd.n !== st.cmd) {
    st = { ...st, cmd: props.cmd.n, play: applyOp(st.play, props.cmd.op as PlayOp, tms) }
    surface.setState(st)
  }
  if (surface.state === undefined) {
    surface.setState(st)
    surface.every(FRAME_MS, () => {
      const cur = surface.state
      const t = latest.get(surface)
      if (!cur || !t) return
      const next = tick(cur.play, FRAME_MS, t)
      if (next !== cur.play) surface.setState({ ...cur, play: next })
    })
  }
  surface.onKey(ev => {
    const op = keyOp(ev.key)
    if (!op) return
    if (op === 'close') {
      send(surface, { type: 'play', op: 'close' })
      return
    }
    const cur = surface.state ?? st
    surface.setState({ ...cur, play: applyOp(cur.play, op, latest.get(surface) ?? tms) })
  })

  const play = st.play
  const scene = scenes[play.scene]
  const out: RenderElement[] = []
  let y = 0
  const line = (l: Line) => {
    out.push(paintLine(Text, l))
    y++
  }
  const blank = () => line([])
  if (!scene) {
    line([{ s: 'none', d: true }])
    return Box({ flexDirection: 'column', children: out })
  }
  const tm = tms[play.scene]!
  const fr = frameAt(scene, play.ms, tm)

  // the title row: the scene's number of all, the progress bar on its track, the clock, then the controls against the
  // right edge, `▶ play` while paused or done, else `pause`
  const pr = progress(play, tms)
  const left = `${play.scene + 1} of ${scenes.length}  `
  const right = `  ${clockText(pr.at)} of ${clockText(pr.total)}`
  const ctrls: { s: string; op: PlayOp }[] = [
    { s: play.paused || play.done ? '▶ play' : 'pause', op: 'pause' },
    { s: 'back', op: 'back' },
    { s: 'next', op: 'next' },
    { s: 'restart', op: 'restart' },
  ]
  const ctrlW = ctrls.reduce((n, c) => n + width(c.s), 0) + 2 * ctrls.length
  const barX = width(left)
  const barW = Math.max(10, cols - barX - width(right) - ctrlW)
  const filled = Math.round((barW * pr.at) / Math.max(1, pr.total))
  const ctrlAt: { x0: number; x1: number; op: PlayOp }[] = []
  let cx = barX + barW + width(right)
  const ctrlSegs: Seg[] = []
  for (const c of ctrls) {
    ctrlSegs.push({ s: '  ' })
    cx += 2
    ctrlAt.push({ x0: cx, x1: cx + width(c.s), op: c.op })
    ctrlSegs.push({ s: c.s })
    cx += width(c.s)
  }
  // a part of the whole on a track: dim, as a mark no colour names (rule 20)
  line([{ s: left }, { s: '█'.repeat(filled), fg: COLORS.dim }, { s: '─'.repeat(barW - filled), fg: COLORS.rule }, { s: right, d: true }, ...ctrlSegs])
  line([{ s: '─'.repeat(cols), fg: COLORS.rule }])

  const cap = fr.current >= 0 ? scene.caps[fr.current] : undefined
  if (scene.kind === 'title') {
    blank()
    // the title in at most two lines, typed in over the first half of the animation
    const title = fold(scene.heading || 'This answer', cols - 2)
    let left = Math.round(title.reduce((n, l) => n + width(l), 0) * Math.min(1, fr.t * 2))
    title.forEach(l => {
      const typed = cells(l, left)
      left -= width(l)
      line([{ s: typed || ' ' }])
    })
    if (props.head) line([{ s: 'asked  ', d: true }, { s: `"${cut(props.head, cols - 10)}"` }])
    blank()
    const items = scene.contents ?? []
    items.forEach((c, i) => {
      if (fr.t < 0.3 + (0.6 * i) / Math.max(1, items.length)) return
      line([{ s: `  ${String(i + 1).padStart(2)}  `, d: true }, { s: cut(c, cols - 6) }])
    })
    blank()
  } else {
    if (scene.heading || scene.n) {
      const lead = scene.n ? `${scene.n}  ` : ''
      fold(scene.heading || ' ', cols - width(lead)).forEach((l, i) => line([...(lead ? [{ s: i ? ' '.repeat(width(lead)) : lead, d: true } as Seg] : []), { s: l }]))
    }
    // a card's rules stand in for the blank rows around it (views/SPEC.md, rule 10)
    const carded = scene.kind === 'card' && Boolean(scene.data)
    if (!carded) blank()
    if (scene.kind === 'card') {
      const card = scene.data
      if (!card) line([{ s: `× this card cannot be drawn${scene.why ? `: ${scene.why}` : ''}`, fg: COLORS.problem }])
      else {
        const inner = Math.max(20, Math.min(cols, 120))
        const focus = cap?.focus ?? undefined
        const plotRows = Math.max(5, Math.min(12, H - 24))
        const lay = animFrame(card, inner, fr.t, focus, plotRows)
        const k = focus ? focusItem(card, lay.items, focus) : -1
        const item = k >= 0 ? lay.items[k] : undefined
        const { q, tip } = headParts(card.question, item ? (item.value ? `${item.label}  ${item.value}` : item.label) : '', inner)
        const head: Line = [{ s: q }, ...(tip ? [{ s: ' '.repeat(Math.max(2, inner - width(q) - width(tip))) }, { s: tip }] : [])]
        // a card taller than the scene leaves is cropped around the lit value, keeping room for the scene's longest
        // caption paragraph typed whole: a column of more rows than the panel has would have its rows squeezed out one
        // by one
        const whole = captionFlows(scene.caps, scene.captions, scene.caps.map(() => 1), -1, cols)
        const capRows = Math.min(Math.floor(H / 3), Math.max(2, ...whole.map(f => f.lines.length)))
        const shown = cropFrame(card, lay, inner, Math.max(3, H - y - 3 - 1 - capRows - 1), k, plotRows)
        // a card in the stream: a rule above it and one below, as wide as the card
        const rule: Line = [{ s: '─'.repeat(inner), fg: COLORS.rule }]
        out.push(Box({ flexDirection: 'column', flexShrink: 0, width: inner, children: [paintLine(Text, rule), paintLine(Text, head), ...shown.map(l => paintLine(Text, l)), paintLine(Text, rule)] }))
        y += 3 + shown.length
      }
    } else if (scene.tiles?.length) {
      // the cited values as tiles, counting up; the one the caption on screen cites lit
      // as wide as the longest value or place needs, at least 14 and at most a third of the panel (all of it for one)
      const need = Math.max(...scene.tiles.map(t => Math.max(width(t.display), width(t.place)))) + 4
      const tw = Math.max(14, Math.min(Math.max(24, need), Math.floor(cols / Math.min(3, scene.tiles.length)) - 1))
      const per = Math.max(1, Math.floor((cols + 1) / (tw + 1)))
      for (let r = 0; r < scene.tiles.length; r += per) {
        out.push(
          Box({
            flexDirection: 'row',
            flexShrink: 0,
            columnGap: 1,
            children: scene.tiles.slice(r, r + per).map(tile => {
              const lit = cap !== undefined && scene.captions[fr.current]?.focus === tile.ref
              return Box({
                flexDirection: 'column',
                borderStyle: 'round',
                borderColor: COLORS.rule,
                paddingX: 1,
                width: tw,
                children: [
                  Text({ ...(lit ? { backgroundColor: COLORS.selected } : {}), wrap: 'truncate-end', children: cut(countUp(tile.display, fr.t), tw - 4) || ' ' }),
                  Text({ dimColor: true, wrap: 'truncate-end', children: cut(tile.place, tw - 4) }),
                ],
              })
            }),
          }),
        )
        y += 4
      }
    }
    if (!carded) blank()
  }

  // the captions typing in as paragraphs; the earliest paragraphs drop off when they do not fit, and a paragraph taller
  // than the room shows its end, where the typing is
  const flows = captionFlows(scene.caps, scene.captions, fr.typed, fr.current, cols)
  const room = Math.max(2, H - y - 1)
  const tall = () => flows.reduce((n, f, i) => n + f.lines.length + (i && f.gap ? 1 : 0), 0)
  while (flows.length > 1 && tall() > room) flows.shift()
  const hits: { y: number; line: number; flow: CapFlow }[] = []
  flows.forEach((f, i) => {
    if (i && f.gap) blank()
    const skip = Math.max(0, f.lines.length - room)
    f.lines.slice(skip).forEach((l, j) => {
      hits.push({ y, line: skip + j, flow: f })
      line(l)
    })
  })
  while (y < H) blank()

  surface.onPointer(ev => {
    if ((ev.type !== 'down' && ev.type !== 'up') || !ev.button) return
    if (ev.y === 0 && ev.type === 'down' && ev.button === 'left' && ev.x >= barX && ev.x < barX + barW) {
      const cur = surface.state ?? st
      const t = latest.get(surface) ?? tms
      surface.setState({ ...cur, play: seek(cur.play, sceneAt((ev.x - barX) / barW, t), t) })
      return
    }
    // a control of the title row
    const c = ev.y === 0 && ev.type === 'down' && ev.button === 'left' ? ctrlAt.find(k => ev.x >= k.x0 && ev.x < k.x1) : undefined
    if (c) {
      const cur = surface.state ?? st
      surface.setState({ ...cur, play: applyOp(cur.play, c.op, latest.get(surface) ?? tms) })
      return
    }
    const h = hits.find(x => x.y === ev.y)
    const k = h ? (h.flow.lay.spans.find(s => s.line === h.line && ev.x >= s.x0 && ev.x < s.x1)?.chip ?? -1) : -1
    if (!h || k < 0) return
    onPointer({ kind: 'citation', ref: h.flow.raws[k] ?? '', text: h.flow.chips[k]?.label ?? '', claim: h.flow.ids[k] ?? '' }, ev, surface)
  })
  return Box({ flexDirection: 'column', height: H, children: out })
}

export default Play
