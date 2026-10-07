// Which refs name a file of the folder and the record they cite.

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
