// A card as an interactive panel: a Client surface module, drawn on Claude Code's drawing thread (no `$`).
// The chart is text (block and braille characters), so the Client can redraw it per pointer move: hovering a bar, a
// point or a cell shows its value in the readout line; a click posts the item to the hooks module, which puts its value
// citation into the prompt (or, for a record, opens it in the citation panel). In the card pane, arrows and Enter do
// the same once a click has given the card the keys.
// Two rows act on the card itself: the params row (a choice re-runs the card's script with it) and the footer (open
// the script, run it again, star, edit the takeaway, ask a side thread, hide). Each click is posted to the hooks module.
import type { ClientModule } from 'claude-code'

import { COLORS, cardHint, cardLayout, cut, width } from './draw'
import type { CardData, CardMeta, Line, Seg } from './draw'
import { paintLine } from './paint'

type Props = { card: CardData; cols: number; plotRows?: number; debug?: boolean; meta?: CardMeta; pane?: boolean }
type S = { hover: number; picked: number; act: string }

const PAD_X = 2 // border and padding on the left

type Hot = { x0: number; x1: number; post: Record<string, string> }
type Part = { s: string; fg?: string; b?: boolean; u?: boolean; inv?: boolean; post?: Record<string, string> }

/** A row of clickable words: its segments and where each clickable one is. */
function controls(parts: Part[], hoverKey: string): { line: Line; hots: Hot[] } {
  const line: Line = []
  const hots: Hot[] = []
  let x = 0
  for (const p of parts) {
    const key = p.post ? JSON.stringify(p.post) : ''
    const on = key !== '' && key === hoverKey
    line.push({ s: p.s, fg: on ? COLORS.accent : p.fg, b: p.b || on, u: p.u || on, inv: p.inv })
    if (p.post) hots.push({ x0: x, x1: x + width(p.s), post: p.post })
    x += width(p.s)
  }
  return { line, hots }
}

const ACT_WORDS: Record<string, string> = {
  script: 'open the script that made this card',
  rerun: 'run the script again and redraw the card',
  star: 'star the card (kept in .thimble-chat/notes)',
  edit: 'edit the takeaway in place',
  ask: 'ask a side thread about this card, out of the main chat',
  hide: 'fold the card to one line',
  show: 'show the card again',
}

const Card: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 80
  const inner = Math.max(20, cols - 4)
  const st = surface.state ?? { hover: -1, picked: -1, act: '' }
  const card = props.card
  const meta = props.meta ?? {}
  const id = card.id

  if (meta.hidden && !props.pane) {
    // a hidden card keeps one line in the reply, so the analyst can bring it back
    const row = controls(
      [
        { s: '▸ ', fg: COLORS.dim },
        { s: cut(`hidden card: ${card.question}`, Math.max(10, cols - 10)), fg: COLORS.dim },
        { s: '  ' },
        { s: 'show', fg: COLORS.dim, u: true, post: { act: 'show' } },
      ],
      st.act,
    )
    surface.onPointer(ev => {
      const cur = surface.state ?? { hover: -1, picked: -1, act: '' }
      const hot = ev.y === 0 ? row.hots.find(h => ev.x >= h.x0 && ev.x < h.x1) : undefined
      const key = hot ? JSON.stringify(hot.post) : ''
      if (ev.type === 'down' && hot) surface.post({ type: 'act', card: id, act: hot.post.act ?? '' })
      if (key !== cur.act) surface.setState({ ...cur, act: key })
    })
    if (surface.state === undefined) surface.setState(st)
    return paintLine(Text, row.line)
  }

  const lay = cardLayout(card, inner, st.hover, props.plotRows)
  const opens = card.kind === 'example' || card.kind === 'timeline'

  // the params row: each choice of each param, the current one inverted
  const params = card.params ?? []
  const prow = params.length
    ? controls(
        params.flatMap((p, i): Part[] => [
          ...(i ? [{ s: '   ' }] : []),
          { s: `${p.name}: `, fg: COLORS.dim },
          ...p.choices.flatMap((c, j): Part[] => [
            ...(j ? [{ s: ' ' }] : []),
            String(c) === String(p.value)
              ? { s: ` ${c} `, inv: true, b: true }
              : { s: ` ${c} `, fg: String(c) === String(p.default) ? undefined : COLORS.dim, post: { param: p.name, value: String(c) } },
          ]),
        ]),
        st.act,
      )
    : null
  const changed = params.some(p => String(p.value) !== String(p.default))

  // the footer: where the card came from, and what the analyst can do with it
  const script = card.source?.script ?? ''
  const sep: Part = { s: ' · ', fg: COLORS.dim }
  const status: Part[] = meta.busy
    ? [{ s: `  ${meta.busy}`, fg: COLORS.accent }]
    : meta.error
      ? [{ s: `  ${cut(meta.error, 70)}`, fg: COLORS.chip.missing }]
      : changed
        ? [{ s: '  params changed', fg: COLORS.chip.differs }]
        : []
  const foot = controls(
    [
      ...(script ? [{ s: cut(script.replace(/^\.thimble-chat\//, ''), 36), fg: COLORS.dim, u: true, post: { act: 'script' } }, sep, { s: 'rerun', fg: COLORS.dim, post: { act: 'rerun' } }, sep] : [{ s: 'no script', fg: COLORS.dim }, sep]),
      { s: meta.starred ? '★ starred' : '☆ star', fg: meta.starred ? COLORS.accent : COLORS.dim, post: { act: 'star' } },
      sep,
      { s: meta.edited ? '✎ takeaway (edited)' : '✎ takeaway', fg: COLORS.dim, post: { act: 'edit' } },
      sep,
      { s: '? ask', fg: COLORS.dim, post: { act: 'ask' } },
      ...(props.pane ? [] : [sep, { s: '✕ hide', fg: COLORS.dim, post: { act: 'hide' } }]),
      ...status,
    ],
    st.act,
  )

  const top = 3 + (prow ? 1 : 0) // border, title, readout, params
  const footY = top + lay.lines.length

  const act = (i: number, secondary: boolean, ev: unknown = null) => {
    const item = lay.items[i]
    if (item) surface.post({ type: 'card', card: id, kind: card.kind, index: i, cite: item.cite, open: item.open, secondary, ev: props.debug ? (ev as never) : null })
  }
  const hotAt = (x: number, y: number): Hot | undefined => {
    const cx = x - PAD_X
    if (prow && y === 3) return prow.hots.find(h => cx >= h.x0 && cx < h.x1)
    if (y === footY) return foot.hots.find(h => cx >= h.x0 && cx < h.x1)
    return undefined
  }

  // set on every call, so the listeners read this call's layout and props
  surface.onPointer(ev => {
    const cur = surface.state ?? { hover: -1, picked: -1, act: '' }
    if (ev.type === 'leave') {
      if (cur.hover !== -1 || cur.act) surface.setState({ ...cur, hover: -1, act: '' })
      return
    }
    const hot = hotAt(ev.x, ev.y)
    const key = hot ? JSON.stringify(hot.post) : ''
    const i = hot ? -1 : lay.hit(ev.x - PAD_X, ev.y - top)
    if (ev.type === 'down') {
      if (hot) {
        surface.post(hot.post.param ? { type: 'param', card: id, name: hot.post.param, value: hot.post.value ?? '' } : { type: 'act', card: id, act: hot.post.act ?? '' })
        return
      }
      if (i >= 0) {
        act(i, ev.button === 'right' || Boolean(ev.shift || ev.alt || ev.ctrl), ev)
        surface.setState({ ...cur, hover: i, picked: i })
        return
      }
      if (props.debug) surface.post({ type: 'pointer', where: 'card', ev })
    }
    if (i !== cur.hover || key !== cur.act) surface.setState({ ...cur, hover: i, act: key })
  })
  // Keys only in the pane: a Client with a key listener keeps the keyboard after a click, so in the chat the analyst's
  // typing would go to the card instead of the prompt the click just filled.
  if (props.pane) {
    surface.onKey(ev => {
      const cur = surface.state ?? { hover: -1, picked: -1, act: '' }
      const n = lay.items.length
      const step = ev.key === 'up' || ev.key === 'left' ? -1 : ev.key === 'down' || ev.key === 'right' ? 1 : 0
      if (step && n) {
        surface.setState({ ...cur, hover: Math.min(n - 1, Math.max(0, (cur.hover < 0 ? (step > 0 ? -1 : n) : cur.hover) + step)) })
        return
      }
      if ((ev.key === 'return' || ev.key === 'enter') && cur.hover >= 0) {
        act(cur.hover, Boolean(ev.shift || ev.ctrl || ev.meta))
        surface.setState({ ...cur, picked: cur.hover })
      }
    })
  }
  if (surface.state === undefined) surface.setState(st)

  const hot = st.hover >= 0 ? lay.items[st.hover] : undefined
  const idTag = `card:${id}`
  const star = meta.starred ? '★ ' : ''
  const title = cut(card.question, Math.max(10, inner - idTag.length - 2 - width(star)))
  const head: Seg[] = [
    ...(star ? [{ s: star, fg: COLORS.accent }] : []),
    { s: title, b: true },
    { s: ' '.repeat(Math.max(1, inner - width(star) - width(title) - idTag.length)) },
    { s: idTag, fg: COLORS.dim },
  ]
  const live = [...(prow?.hots ?? []), ...foot.hots].some(h => JSON.stringify(h.post) === st.act)
  const hint = st.act && live ? (JSON.parse(st.act) as Record<string, string>) : null
  const readout: Seg[] = hot
    ? [
        { s: cut(`${hot.label}: ${hot.value}`, Math.max(10, inner - 40)), b: true, fg: COLORS.accent },
        { s: `  click: ${opens ? 'open' : 'cite in the prompt'} · right-click: ${opens ? 'cite in the prompt' : 'open'}`, fg: COLORS.dim },
      ]
    : hint?.param
      ? [{ s: cut(`click: run ${script || 'the script'} again with ${hint.param} = ${hint.value}`, inner), fg: COLORS.accent }]
      : hint?.act
        ? [{ s: ACT_WORDS[hint.act] ?? '', fg: COLORS.accent }]
        : [{ s: cardHint(card), fg: COLORS.dim }]
  const rows = [paintLine(Text, head), paintLine(Text, readout)]
  if (prow) rows.push(paintLine(Text, prow.line))
  rows.push(...lay.lines.map(l => paintLine(Text, l)), paintLine(Text, foot.line))
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: meta.error ? COLORS.chip.missing : COLORS.rule,
    paddingX: 1,
    width: cols,
    children: rows,
  })
}

export default Card
