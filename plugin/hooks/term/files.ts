// The file browser's pure parts: which refs name a file of the folder and the record they cite, the folder tree and
// its rows, which turns a whole-file JSON transcript's view reads, the modes a file's records read in, the labels that
// are on and the values they gave a file's records, and what a search found. filesview.tsx draws them.
import { classColors } from './labels'
import type { LabelClass } from './labels'

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

/** The row the file browser chooses when the analyst chose none: the first file its tree shows (the first open
 *  folder's), else the first folder's row (`dir:<folder>`); '' for no files (live check term-fix9, quirk 7: no row was
 *  chosen as it opened). */
export function firstChoice(files: readonly { path: string }[], ui: { folded: readonly string[]; unfolded: readonly string[]; whole?: readonly string[] }): string {
  const rows = treeRows(fileTree(files.map(f => ({ path: f.path, kind: '', size: 0 })), ''), ui)
  return rows.find(r => r.file)?.key ?? rows.find(r => r.folder)?.key ?? ''
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

// ------------------------------------------------------------------------------------------------ the file browser

/** A file as `thimble state files` lists it: its path, thimble's kind, its size in bytes. */
export type FileEntry = { path: string; kind: string; size: number }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

/** The files a `thimble state files` (or `find`) read gives: a list, or `{files}`. */
export function filesOf(got: { ok: true; value: unknown } | { ok: false; error: string } | undefined): FileEntry[] {
  const list = got?.ok ? (Array.isArray(got.value) ? got.value : isObj(got.value) && Array.isArray(got.value.files) ? got.value.files : []) : []
  return (list as unknown[]).filter(isObj).map(f => ({ path: str(f.path), kind: str(f.kind), size: typeof f.size_bytes === 'number' ? f.size_bytes : typeof f.size === 'number' ? f.size : 0 }))
}

/** What the type column says of a file: thimble's kind for the kinds it reads in its own way (an agent's transcript, a
 *  board, events, a database, a prompt); for a file it knows only as text, what it opens as when that is not its lines
 *  (`transcript`, as its preview and its view say), else its format by its extension (`jsonl`, `md`); never the bare
 *  `text` that a transcript or a table of records would contradict. */
export function fileType(path: string, kind: string, opens = ''): string {
  if (kind && kind !== 'text') return kind === 'forge' ? 'database' : kind
  if (opens) return opens
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && name.length - dot <= 9 ? name.slice(dot + 1).toLowerCase() : 'text'
}

/** A size in bytes as the file browser writes it: `5.4 MB`, `600 B`. */
export function fmtSize(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
}

/** Whether a file is a database thimble reads by its tables (backend corpus.source_kind `forge`): `.db`, `.sqlite`,
 *  `.sqlite3`. */
export function isDatabase(path: string, kind = ''): boolean {
  return kind === 'forge' || /\.(db|sqlite3?)$/i.test(path)
}

/** An open folder shows its first FOLDER_FILES files, then `… N more`. */
export const FOLDER_FILES = 20

/** A folder of the file browser's tree: `dir` its path with its slash (`logs/2026/`, '' for the corpus's own files),
 *  `name` as its row names it (a folder within one folder alone, with no files of its own, joins it: `runs/a/`), its
 *  depth, its folders and files, and how many files it holds in all and their size. */
export type Folder = { dir: string; name: string; depth: number; folders: Folder[]; files: FileEntry[]; count: number; size: number }

/** The file browser's tree: the corpus's own files under the corpus folder's name (`rootName`) first, then each folder
 *  of the corpus in natural order; in each folder its folders first, then its files, in natural order, as the browser's
 *  tree lists them. A folder whose one entry is a folder joins it (`runs/a/`), so a deep path takes one row. */
export function fileTree(files: readonly FileEntry[], rootName: string): Folder[] {
  const root: Folder = { dir: '', name: rootName, depth: 0, folders: [], files: [], count: 0, size: 0 }
  const made = new Map<string, Folder>([['', root]])
  const top: Folder[] = []
  const folderOf = (dir: string): Folder => {
    const have = made.get(dir)
    if (have) return have
    const parts = dir.split('/').filter(Boolean)
    const parentDir = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : ''
    const f: Folder = { dir, name: parentDir ? `${parts.at(-1)}/` : dir, depth: parts.length - 1, folders: [], files: [], count: 0, size: 0 }
    made.set(dir, f)
    if (parentDir) folderOf(parentDir).folders.push(f)
    else top.push(f)
    return f
  }
  for (const f of sortPaths(files)) {
    const dir = dirOf(f.path)
    folderOf(dir).files.push(f)
    // the count and size of every folder it stands in
    const parts = dir.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const at = made.get(`${parts.slice(0, i).join('/')}/`)!
      at.count++
      at.size += f.size
    }
    if (!dir) {
      root.count++
      root.size += f.size
    }
  }
  const natural = (a: Folder, b: Folder) => a.dir.localeCompare(b.dir, undefined, { numeric: true })
  // a folder of one folder and no files joins that folder, its depth kept
  const join = (f: Folder): Folder => {
    while (!f.files.length && f.folders.length === 1) {
      const kid = f.folders[0]!
      f = { ...kid, name: `${f.name}${kid.name}`, depth: f.depth }
    }
    const depth = f.depth
    return { ...f, folders: f.folders.map(k => join({ ...k, depth: depth + 1 })).sort(natural) }
  }
  return [...(root.files.length ? [root] : []), ...top.sort(natural).map(join)]
}

/** A row of the file browser's tree: a folder's (`dir:<folder>`), a file's (its path), or a folder's `… N more`
 *  (`more:<folder>`). */
export type TreeRow = { key: string; depth: number; folder?: Folder; file?: FileEntry; more?: number }

/** The rows the tree shows: each folder, then, while it is open, its folders' rows and its first FOLDER_FILES files
 *  (`… N more`, unless the analyst showed it whole); the first folder open unless folded, any other once unfolded. */
export function treeRows(top: readonly Folder[], ui: { folded: readonly string[]; unfolded: readonly string[]; whole?: readonly string[] }): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (f: Folder, first: boolean) => {
    out.push({ key: `dir:${f.dir}`, depth: f.depth, folder: f })
    if (!folderOpen(ui, f.dir, first)) return
    for (const k of f.folders) walk(k, false)
    const whole = (ui.whole ?? []).includes(f.dir)
    const shown = !whole && f.files.length > FOLDER_FILES + 1 ? f.files.slice(0, FOLDER_FILES) : f.files
    for (const file of shown) out.push({ key: file.path, depth: f.depth + 1, file })
    if (f.files.length > shown.length) out.push({ key: `more:${f.dir}`, depth: f.depth + 1, more: f.files.length - shown.length })
  }
  top.forEach((f, i) => walk(f, i === 0))
  return out
}

/** The folders a path stands in, outermost first (`a/`, `a/b/`), the keys a row's folders are unfolded by. */
export function foldersOf(path: string): string[] {
  const parts = dirOf(path).split('/').filter(Boolean)
  return parts.map((_p, i) => `dir:${parts.slice(0, i + 1).join('/')}/`)
}

/** The file browser's state with every folder `path` stands in open, so its row shows (a file opened from a search, a
 *  citation, or Backspace from its view). */
export function unfoldTo<T extends { folded: string[]; unfolded: string[] }>(ui: T, path: string): T {
  const keys = new Set([`dir:${dirOf(path)}`, ...foldersOf(path)])
  return { ...ui, folded: ui.folded.filter(k => !keys.has(k)), unfolded: [...ui.unfolded.filter(k => !keys.has(k)), ...keys] }
}

// ------------------------------------------------------------------------------------------------ a file's modes

/** The ways a file's records read, as the browser's Files offers them: a table of their keys (records, CSV rows), a
 *  transcript, its text wrapped (Markdown rendered), one record as JSON, the lines as the file holds them. */
export type FileMode = 'table' | 'transcript' | 'text' | 'json' | 'raw'

const isScalar = (v: unknown) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** How well records read as a table, as the browser's Table view scores them (frontend views/table.tsx tableScore):
 *  every record an object, at most 40 keys, values mostly scalars and no widely shared key mostly holding objects;
 *  uniform records (fill >= 0.7) 0.85, records sharing a spine of keys (fill >= 0.4, two keys in every record) 0.7,
 *  other records of objects 0.05; else 0. */
export function tableScore(sample: readonly unknown[]): number {
  if (!sample.length || !sample.every(isObj)) return 0
  const objs = sample as Obj[]
  const count = new Map<string, number>()
  const nested = new Map<string, number>()
  let present = 0
  let scalars = 0
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      count.set(k, (count.get(k) ?? 0) + 1)
      present++
      if (isScalar(v)) scalars++
      else if (!Array.isArray(v)) nested.set(k, (nested.get(k) ?? 0) + 1)
    }
  }
  if (!count.size || !present) return 0
  if (count.size > 40 || scalars / present < 0.5) return 0.05
  for (const [k, n] of count) if (n * 2 >= objs.length && (nested.get(k) ?? 0) * 2 >= n) return 0.05
  const fill = present / (objs.length * count.size)
  const shared = [...count.values()].filter(n => n === objs.length).length
  return fill >= 0.7 ? 0.85 : fill >= 0.4 && shared >= 2 ? 0.7 : 0.05
}

/** The separator of a delimited file's cells (`,` for CSV, a tab for TSV), null for any other file. */
export function delimiterOf(path: string): string | null {
  return /\.csv$/i.test(path) ? ',' : /\.tsv$/i.test(path) ? '\t' : null
}

/** A line of a delimited file as its cells: quoted cells keep their separators, `""` is a quotation mark. */
export function csvCells(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && !cur) quoted = true
    else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur.replace(/\r$/, ''))
  return out
}

/** Whether a file reads as text to wrap first (the browser's Rendered view: a prompt, Markdown, a .txt file). */
export function readsAsText(path: string, kind = ''): boolean {
  return kind === 'prompt' || /\.(md|markdown|txt)$/i.test(path)
}

/** A record's text as JSON when it holds a JSON object or list (a line of a `.json` file), else undefined. */
export function jsonOf(text: string): unknown {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return undefined
  try {
    const v = JSON.parse(t) as unknown
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------------------------------------ labels on records

/** A label that is on in Files (`shown`, show_label) over a corpus's records or files: its id, name and values, the
 *  values it highlights (litValues), and each value's color from its classes (labels.ts classColors), as the label
 *  panel draws them. */
export type OnLabel = { id: string; name: string; values: string[]; lit: string[]; paths: string[]; glob: string; colors?: Record<string, number> }

// the browser's negatives (frontend files/labels.ts QUIET, isNegative): a quiet word, or the second of two
const QUIET = new Set(['no', 'none', 'other', 'no match', 'not', 'neither', 'n/a', 'unknown'])
const isNegative = (name: string, i: number, n: number): boolean => QUIET.has(name.trim().toLowerCase()) || (n === 2 && i === 1)

/** The values a label highlights, as the browser's Files reads them (frontend files/labels.ts classesOf and litClass):
 *  with classes, those whose class has `highlight` (a class with no `highlight` field highlights nothing; thimble
 *  fills the field for every class it sends); with no classes, every value but the negative. */
export function litValues(values: readonly string[], classes: readonly LabelClass[] | null | undefined): string[] {
  if (Array.isArray(classes) && classes.length) return values.filter(v => classes.some(c => c && c.name === v && Boolean(c.highlight)))
  return values.filter((v, i) => !isNegative(v, i, values.length))
}

/** The labels over files that are on, in the order the labels list gives them. */
export function onLabels(labels: readonly Obj[]): OnLabel[] {
  return labels
    .filter(l => l.shown === true && (!l.unit || ['record', 'agent', 'run'].includes(str(l.unit))))
    .map(l => {
      const run = isObj(l.last_run) ? l.last_run : null
      const classes = l.classes as LabelClass[] | undefined
      const colors = classColors(classes)
      const values = Array.isArray(l.labels) ? (l.labels as unknown[]).map(String) : []
      return { id: str(l.id), name: str(l.name) || str(l.id), values, lit: litValues(values, classes), paths: run && Array.isArray(run.paths) ? (run.paths as unknown[]).map(String) : [], glob: str(l.glob), ...(colors ? { colors } : {}) }
    })
}

/** A glob of a label's scope (comma-separated patterns: `*` within a folder, `**` across folders) as a test of a path. */
export function globTest(glob: string): (path: string) => boolean {
  const res = glob
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`))
  return path => res.some(r => r.test(path))
}

/** Whether a label that is on marks a file: its last run read it, or its scope's glob names it. */
export function labelCovers(l: OnLabel, path: string): boolean {
  return l.paths.includes(path) || (Boolean(l.glob) && globTest(l.glob)(path))
}

/** The values the labels that are on gave a file's records (`thimble state marks`: each label's rows on a page of its
 *  lines), by line and then by label, only those the label highlights (litValues), as the browser's Files marks a
 *  record; and those they gave the file whole (a label over files: a row whose ref is the path), by label, highlighted
 *  or not, which the file's label row shows; a value the analyst set stands for the classifier's. */
export function recordMarks(marks: unknown, on: readonly OnLabel[], path: string): { lines: Map<number, Map<string, string>>; file: Map<string, string> } {
  const lines = new Map<number, Map<string, string>>()
  const file = new Map<string, string>()
  const ids = new Set(on.map(l => l.id))
  const lit = new Map(on.map(l => [l.id, new Set(l.lit)]))
  for (const k of Array.isArray(marks) ? marks : []) {
    if (!isObj(k) || !ids.has(str(k.concept_id))) continue
    for (const r of Array.isArray(k.rows) ? k.rows : []) {
      if (!isObj(r)) continue
      const value = str(r.analyst) || str(r.label)
      const ref = str(r.ref)
      if (!value) continue
      if (ref === path) {
        file.set(str(k.concept_id), value)
        continue
      }
      const m = /#L(\d+)/.exec(ref)
      const n = m ? Number(m[1]) : typeof r.line === 'number' ? r.line : 0
      if (!n || !lit.get(str(k.concept_id))?.has(value)) continue
      if (!lines.has(n)) lines.set(n, new Map())
      lines.get(n)!.set(str(k.concept_id), value)
    }
  }
  return { lines, file }
}

// ------------------------------------------------------------------------------------------------ search

/** A file whose text holds the words searched for (`thimble state grep`): how many matches, whether its count is
 *  whole, its first matching lines each with the words around the match and where the match stands in them. */
export type GrepFile = { path: string; total: number; complete: boolean; matches: { line: number; text: string; hit: [number, number] }[] }

/** What `thimble state grep` found: the files, and how many files it read of how many, and whether it read them all. */
export function grepOf(v: unknown): { files: GrepFile[]; scanned: number; of: number; complete: boolean } {
  const o = isObj(v) ? v : {}
  const files = (Array.isArray(o.files) ? o.files : []).filter(isObj).map(f => ({
    path: str(f.path),
    total: typeof f.total === 'number' ? f.total : 0,
    complete: f.complete !== false,
    matches: (Array.isArray(f.matches) ? f.matches : []).filter(isObj).map(m => {
      const hit = Array.isArray(m.hit) && m.hit.length === 2 ? [Number(m.hit[0]) || 0, Number(m.hit[1]) || 0] : [0, 0]
      return { line: typeof m.line === 'number' ? m.line : 1, text: str(m.text), hit: hit as [number, number] }
    }),
  }))
  const d = isObj(o.done) ? o.done : {}
  return { files, scanned: typeof d.scanned === 'number' ? d.scanned : 0, of: typeof d.of === 'number' ? d.of : 0, complete: d.complete !== false }
}

/** The fewest letters the search inside the files starts on, as the browser's (one letter matches nearly every line). */
export const GREP_MIN = 2
