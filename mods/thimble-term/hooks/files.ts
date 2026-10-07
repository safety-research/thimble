// Which refs name a file of the folder and the record they cite, and which turns a whole-file JSON transcript's view
// reads.

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

/** The folder a path stands in, with its slash (`logs/`), '' for the corpus's own files. */
export function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
}

/** Paths in the file browser's order: the corpus's own files first, then each folder in natural order (`run-2` before
 *  `run-10`), each folder's files in natural order. */
export function sortPaths<T extends { path: string }>(files: readonly T[]): T[] {
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  return [...files].sort((a, b) => {
    const da = dirOf(a.path)
    const db = dirOf(b.path)
    return da === db ? natural(a.path, b.path) : !da ? -1 : !db ? 1 : natural(da, db)
  })
}

/** Whether the file browser shows a folder open: the first folder unless folded, any other once unfolded. */
export function folderOpen(ui: { folded: readonly string[]; unfolded: readonly string[] }, dir: string, first: boolean): boolean {
  return first ? !ui.folded.includes(`dir:${dir}`) : ui.unfolded.includes(`dir:${dir}`)
}

/** The row the file browser chooses when the analyst chose none: the first file of the first open folder, else the
 *  first folder's row (`dir:<folder>`); '' for no files (live check term-fix9, quirk 7: no row was chosen as it opened). */
export function firstChoice(files: readonly { path: string }[], ui: { folded: readonly string[]; unfolded: readonly string[] }): string {
  const sorted = sortPaths(files)
  const dirs = [...new Set(sorted.map(f => dirOf(f.path)))]
  const open = dirs.find((d, i) => folderOpen(ui, d, i === 0))
  if (open !== undefined) return sorted.find(f => dirOf(f.path) === open)?.path ?? `dir:${open}`
  return dirs.length ? `dir:${dirs[0]}` : ''
}

/** Whether a file's page is of a whole-file JSON transcript (thimble's sniff says `json`): a chat export or an agent's
 *  store of messages, whose turns only a parse of the whole file finds (`thimble state turns`), not its lines. */
export function wholeJson(page: Record<string, unknown>): boolean {
  const hint = page.transcript
  return typeof hint === 'object' && hint !== null && (hint as { format?: unknown }).format === 'json' && !page.binary
}

/** The page of turns a file's panel reads of a whole-file JSON transcript: from its turn `from`, else around the
 *  first turn on its `line` (a citation's), else from the first; the surface's key and `thimble state turns`'s
 *  arguments. */
export function turnsRead(p: { path?: string; from?: number; line?: number }): { key: string; args: string[] } {
  const path = p.path ?? ''
  if (p.from !== undefined) return { key: `turns:${path}:${p.from}`, args: [path, '--start', String(p.from)] }
  if (p.line) return { key: `turns:${path}:L${p.line}`, args: [path, '--line', String(p.line)] }
  return { key: `turns:${path}:0`, args: [path] }
}
