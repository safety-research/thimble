// keysclient.js: a pane program's drawing as a Claude Code `Client` that takes the keyboard once clicked (a surface
// module). Claude Code keeps tab, shift+tab, the arrow keys and enter in its prompt, where no plugin hears them; a click
// on this region hands the keys to it instead, until esc gives them back to the prompt. Each key and each click is
// posted to the hooks module (shell.tsx heldEl and the `ui.message` hook), which runs the pane program on it. The
// module draws what the hooks module drew of the program, as rows of styled runs, and one dim line under them when the
// props carry one. The squeeze chips use it; any pane can (shell.tsx heldEl).
//
//   props: {rows: [[{s, color?, bg?, bold?}]], hint?: string, keys: boolean}
//   posts: {key: {key, shift?, ctrl?, meta?}} for each key, {press: {x, y}} for a click (a pointer released over it)
export default function KeysClient(props, surface) {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ready: true })
    surface.onKey(ev => surface.post({ key: ev }))
    surface.onPointer(ev => { if (ev.type === 'up') surface.post({ press: { x: ev.x, y: ev.y } }) })
  }
  const p = props || {}
  const rows = Array.isArray(p.rows) ? p.rows : []
  const line = (runs, y) => Text({ key: `r${y}`, wrap: 'truncate-end', children: (runs || []).map((r, i) => Text({ key: `r${y}-${i}`, ...(r.color ? { color: r.color } : {}), ...(r.bg ? { backgroundColor: r.bg } : {}), ...(r.bold ? { bold: true } : {}), children: String(r.s || '') })) })
  return Box({ flexDirection: 'column', children: [...rows.map(line), ...(p.hint ? [Text({ key: 'hint', dimColor: true, wrap: 'truncate-end', children: String(p.hint) })] : [])] })
}
