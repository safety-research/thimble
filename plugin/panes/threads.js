// threads.js: the session's side threads, listed in the side panel, a program on the card runtime (draw/kit.js). Only
// t at the prompt, a click on the bar's `N threads` or /threads opens it, never anything inside a thread. As 0.9 drew
// them: a tree with main at its root and a row per thread, `main/<what it is on>`, the newest first, with how many
// questions it has and whether it is answering, and its last question under it. It is no thread itself (no input bar):
// a click on a row, or ↵ with the ring on it, opens that thread: what it is on at the top of the panel again (the
// card, the citation, the pane), its conversation under it.
//
//   reads: threads (shell/thread.ts threadList: key, name, status, asks, at, turns)
//   state: {sel: the key of the thread selected}
//   presses: a row opens its thread. keys: none of its own (the ring walks the rows; esc is the panel's)
//   asks of the host: open {thread: key}
import { subjectBlock } from './subject.js'

const cut = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** How long ago, in a word or two: `now`, `4m`, `2h`, `3d`. */
export function ago(at, now = Date.now()) {
  const t = Date.parse(String(at || ''))
  if (!isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The threads as the list shows them, the newest first. */
export function rowsOf(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter(t => t && t.key).map(t => {
    const qs = (t.turns || []).filter(x => x.role === 'person')
    return { key: String(t.key), name: String(t.name || t.key), status: String(t.status || ''), asks: Number(t.asks) || qs.length, last: qs.length ? String(qs[qs.length - 1].text || '') : '', ago: ago(t.at, now) }
  })
}

/** The thread selected: the one the state names while it is listed, else the newest. */
export function selectedOf(state, data) {
  const rows = (data && data.rows) || []
  const sel = state && typeof state.sel === 'string' ? state.sel : null
  return rows.find(r => r.key === sel)?.key ?? rows[0]?.key ?? null
}

export default {
  name: 'threads',
  title: 'Threads',
  reads: () => ['threads'],
  stateKey: () => 'threads',
  data(stores) {
    return { rows: rowsOf(stores.threads) }
  },
  titleOf: () => 'Threads',
  /** The list is no thread: no conversation and no input bar under it. */
  thread: () => null,
  program,
}

export function program(k, data) {
  const rows = data.rows || []
  if (!rows.length) return k.stack(subjectBlock(k, { title: 'Threads', line: 'none in this session yet' }), k.text('{dim:A question asked beside a card, a citation or a label starts a thread, and the thread is listed here.}'))
  const st = k.state || {}
  const sel = selectedOf(st, data)
  const ids = rows.map((_, i) => `t${i}`)
  const idOf = key => ids[rows.findIndex(r => r.key === key)] ?? null
  const keyOf = id => rows[ids.indexOf(id)]?.key ?? null
  const open = key => { if (key) k.do('open', { thread: key }) }
  k.on('focus', e => (keyOf(e.region) ? { sel: keyOf(e.region) } : null))
  k.on('return', () => { open(sel) })
  k.on('press', e => {
    const key = keyOf(e.region)
    if (!key) return null
    open(key)
    return { sel: key }
  })
  const id = idOf(sel)
  if (id) k.select(id)

  const W = Math.max(30, k.w)
  const lines = [subjectBlock(k, { title: 'Threads', line: `${rows.length} thread${rows.length === 1 ? '' : 's'} in this session` }), k.text('**main**', { wrap: false })]
  rows.forEach((r, i) => {
    const lastRow = i === rows.length - 1
    const state = r.status === 'running' ? '{warn:answering…}' : r.status === 'failed' ? '{bad:stopped}' : `{dim:${r.asks} question${r.asks === 1 ? '' : 's'}${r.ago ? ` · ${r.ago}` : ''}}`
    const name = cut(r.name, Math.max(12, W - 26))
    lines.push(k.region(ids[i], { label: r.name },
      k.stack([
        k.text(`{dim:${lastRow ? '└─' : '├─'}} ${k.escape(name)}  ${state}`, { wrap: false }),
        ...(r.last ? [k.text(`{dim:${lastRow ? ' ' : '│'}    ${k.escape(cut(r.last, Math.max(10, W - 6)))}}`, { wrap: false })] : []),
      ])))
  })
  return k.stack(lines)
}
