// settings.js: thimble's switches, a program on the card runtime (draw/kit.js) in the side panel. /thimble-settings,
// or a click on `thimble` at the bar's left, opens it. Each switch is one of the plugin's settings (settings/features.mjs,
// .claude-plugin/plugin.json userConfig): its row says whether it is on, what it does and what it costs, and ↵ or a
// click turns it on or off. The host changes it through Claude Code (settings/term.ts), so the change is kept where
// /config keeps it, and Claude Code loads the plugin again with it.
//
//   reads: settings (settings/term.ts settingsStore: each switch with its value, its words, its cost now)
//   state: {sel: the key of the switch selected}
//   keys: ↑↓ switch · ↵ on or off (a click: the same) · esc back
//   asks of the host: toggle {key}
const cut = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** The switch selected: the one the state names while it is listed, else the first. */
export function selectedOf(state, rows) {
  const sel = state && typeof state.sel === 'string' ? state.sel : null
  return rows.find(r => r.key === sel)?.key ?? rows[0]?.key ?? null
}

export default {
  name: 'settings',
  title: 'thimble settings',
  reads: () => ['settings'],
  stateKey: () => 'settings',
  data(stores) {
    const s = stores.settings || {}
    return { rows: Array.isArray(s.switches) ? s.switches : [], where: s.where || '' }
  },
  titleOf: () => 'thimble settings',
  // no side thread: a question about thimble goes to main, in the prompt
  thread: () => null,
  program,
}

export function program(k, data) {
  const rows = data.rows || []
  if (!rows.length) return k.text('{dim:No settings to show.}')
  const st = k.state || {}
  const sel = selectedOf(st, rows)
  const at = Math.max(0, rows.findIndex(r => r.key === sel))
  const idOf = key => `s-${key}`
  const keyOf = id => (typeof id === 'string' && id.startsWith('s-') ? id.slice(2) : null)
  const toggle = key => { if (key) k.do('toggle', { key }) }
  k.on('up', () => ({ sel: rows[(at - 1 + rows.length) % rows.length].key }), 'switch')
  k.on('down', () => ({ sel: rows[(at + 1) % rows.length].key }), 'switch')
  k.on('focus', e => (keyOf(e.region) ? { sel: keyOf(e.region) } : null))
  k.on('return', () => { toggle(sel) }, 'on or off')
  k.on('press', e => {
    const key = keyOf(e.region)
    if (!key) return null
    toggle(key)
    return key === sel ? null : { sel: key }
  })
  if (sel) k.select(idOf(sel))

  const W = Math.max(30, k.w)
  const lines = [k.text(`{dim:↵ or a click turns one on or off. Claude Code keeps them${data.where ? ` ${k.escape(data.where)}` : ' with its plugin settings (/config)'}.}`)]
  let group = null
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group
      lines.push(k.space(1, 1), k.text(`**${k.escape(group)}**`, { wrap: false }))
    }
    // a switch under another is drawn in from it; its words stand under its name
    const indent = r.under ? 2 : 0
    // a switch whose parent is off does nothing now: its own value shows, dim
    const idle = r.under && !r.parentOn
    const state = r.on ? (idle ? '{dim:● on}' : '{good:● on} ') : '{dim:○ off}'
    const words = [r.does, r.costs].filter(Boolean).join(' ')
    const note = r.locked ? ' {warn:(set by your organization)}' : idle ? ' {dim:(the observer is off)}' : r.pending ? ' {warn:(loading…)}' : ''
    lines.push(k.region(idOf(r.key), { label: `${r.title}: ${r.on ? 'on' : 'off'}` }, k.stack([
      k.text(`${' '.repeat(indent)}${state}  ${r.on && !idle ? `**${k.escape(r.title)}**` : k.escape(r.title)}${note}`, { wrap: false }),
      k.beside(k.space(indent + 7, 1), k.text(`{dim:${k.escape(cut(words, Math.max(40, (W - 9) * 3)))}}`), { gap: 0 }),
    ])))
  }
  return k.stack(lines)
}
