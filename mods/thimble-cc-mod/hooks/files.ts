// The file browser's pure parts (the hooks are the file browser block of register.tsx; helper/files.py writes its
// views): which refs name a file of the folder and the record they cite, and which row of a file's view shows it.
import type { ViewData, ViewSpec } from './viewspec'
import type { ViewState } from './viewdraw'

/** The views the mod writes itself have slugs starting with "@": the tree, and a file's view by a hash of its path. */
export const FILES_TREE = '@files'

/** The file a ref cites and the record in it: a line (`#L<n>`, a range's first), a JSON list's item (`#/<i>` or
 *  `#/<key>/<i>`, counted from 1 as the file's view counts them), or the whole file. Null for a ref of no file of the
 *  folder: a card, a Bash call's output, a database row, a path outside the folder. */
export function fileRef(ref: string): { path: string; line?: number; item?: number } | null {
  const r = ref.trim().replace(/^\[\[(?:[^|\]]*\|)?/, '').replace(/\]\]$/, '')
  if (!r || /^(card|call|view):/.test(r)) return null
  const hash = r.indexOf('#')
  const path = (hash < 0 ? r : r.slice(0, hash)).replace(/^\.\//, '')
  const frag = hash < 0 ? '' : r.slice(hash + 1)
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return null
  if (!frag) return { path }
  const line = /^L(\d+)(?:-L?\d+)?$/.exec(frag)
  if (line) return { path, line: Number(line[1]) }
  const item = /^\/(?:[^/]+\/)?(\d+)$/.exec(frag)
  if (item) return { path, item: Number(item[1]) + 1 }
  if (/^row=\d+$/.test(frag) || frag.startsWith('/')) return { path }
  // `<db>#<table>/<key>`: a database's row, which the file browser does not open
  return null
}

/** Where a file's view shows a record: the first tab whose rows hold it (a row keyed by its line, or a JSON item's
 *  number), with the state that selects it and clears what would hide it. Null when no tab holds it. */
export function recordState(spec: ViewSpec, data: ViewData, n: number): Partial<ViewState> | null {
  for (let i = 0; i < spec.tabs.length; i++) {
    const t = spec.tabs[i]!
    const c = spec.collections.find(x => x.name === t.collection)
    if (!c) continue
    const row = (data.collections[c.name] ?? []).find(r => r[c.key] === n || String(r[c.key]) === String(n))
    if (!row) continue
    // a tab that keeps only the rows with a value (the Transcript of a file's records keeps those with a speaker)
    if (t.where && t.where.not === null && (row[t.where.field] ?? null) === null) continue
    return { tab: i, sel: { c: c.name, k: String(row[c.key]) }, back: [], q: '', typing: false, facets: {}, labelFilter: null, scroll: 0, dscroll: 0, panel: '', zoom: {} }
  }
  return null
}
