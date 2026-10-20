// settings.js: thimble's features, a program on the card runtime (draw/kit.js) in the side panel. /thimble-settings,
// or a click on `thimble` at the bar's left, opens it. The list is flat: one row per feature, named by what the person
// gets (settings/features.mjs), with one line on what that is, and a small Experimental group at the end. ↵ or a click
// turns the feature selected on or off; the host changes it through Claude Code (settings/term.ts), and Claude Code
// loads the plugin again with it. Above the list the host draws the bar as these features leave it (shell.tsx
// barPreviewEl), so a feature turned off shows what leaves the bar.
//
// The panel holds the keys as any pane in the side panel does: ↑↓ move between the features, ↵ or a click turns one on
// or off, esc closes it. It says its keys in its last line, and the bar keeps its own keys meanwhile (`keepBar`), so
// the person sees the real bar change too. Each change loads the plugin again; the feature changed last stays
// selected through that (the store's `last`), so the keys go on from there.
//
//   reads: settings (settings/term.ts settingsStore: each feature with its value and its words, the feature changed
//          last, and the cost line)
//   state: {sel: the key of the feature selected}
//   keys: ↑↓ feature · ↵ on or off (a click: the same) · esc close
//   asks of the host: toggle {key}
const cut = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** Words wrapped to `w` columns, at most `max` lines (the last cut with …). */
export function wrap(s, w, max = 2) {
  const out = []
  let line = ''
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    if (line && Array.from(`${line} ${word}`).length > w) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  if (out.length > max) { out.length = max; out[max - 1] = cut(`${out[max - 1]} …`, w) }
  return out
}

/** The feature selected: the one the state names while it is listed, else the one changed last (the plugin loaded
 *  again since, with no state), else the first. */
export function selectedOf(state, rows, last = null) {
  const sel = state && typeof state.sel === 'string' ? state.sel : last
  return rows.find(r => r.key === sel)?.key ?? rows[0]?.key ?? null
}

export default {
  name: 'settings',
  title: 'thimble settings',
  // over the list, the host draws the bar as these features leave it (shell.tsx barPreviewEl)
  above: 'bar',
  // the bar keeps its own keys while the panel is open: the panel says its keys itself (detail.tsx)
  keepBar: true,
  reads: () => ['settings'],
  stateKey: () => 'settings',
  data(stores) {
    const s = stores.settings || {}
    return { rows: Array.isArray(s.switches) ? s.switches : [], cost: typeof s.cost === 'string' ? s.cost : '', last: typeof s.last === 'string' ? s.last : null }
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
  const sel = selectedOf(st, rows, data.last)
  const at = Math.max(0, rows.findIndex(r => r.key === sel))
  const idOf = key => `s-${key}`
  const keyOf = id => (typeof id === 'string' && id.startsWith('s-') ? id.slice(2) : null)
  const toggle = key => { if (key) k.do('toggle', { key }) }
  k.on('up', () => ({ sel: rows[(at - 1 + rows.length) % rows.length].key }), 'feature')
  k.on('down', () => ({ sel: rows[(at + 1) % rows.length].key }), 'feature')
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
  // the words start after the state (`● on  `); the host shades the selected feature
  const IN = 7
  const out = []
  let group = null
  for (const r of rows) {
    if ((r.group || null) !== group) {
      group = r.group || null
      if (group) out.push(k.space(1, 1), k.text(`**${k.escape(group)}**`, { wrap: false }))
    }
    const picked = r.key === sel
    const note = r.locked ? 'set by your organization' : r.pending ? 'loading…' : ''
    const words = wrap(r.does, W - IN - 1)
    const c = k.canvas(W, 1 + words.length)
    c.text(0, 0, r.on ? '● on' : '○ off', { tone: r.on ? 'good' : 'dim', raw: true })
    c.text(IN, 0, r.title, { tone: r.on ? 'ink' : 'dim', bold: r.on || picked, raw: true })
    if (note) c.text(IN + Array.from(String(r.title)).length + 2, 0, `(${note})`, { tone: r.locked ? 'warn' : 'dim', raw: true })
    words.forEach((line, i) => c.text(IN, 1 + i, line, { tone: 'dim', raw: true }))
    c.region(idOf(r.key), 0, 0, W, 1 + words.length, { label: `${r.title}: ${r.on ? 'on' : 'off'}` })
    out.push(c)
  }
  // what the features that read answers cost together, and the panel's keys (the bar says its own meanwhile)
  if (data.cost) out.push(k.space(1, 1), k.text(`{dim:${k.escape(data.cost)}}`))
  out.push(k.space(1, 1), k.text('{dim:↑↓ feature · ↵ or a click turns it on or off · esc close}'))
  return k.stack(out)
}
