// The pure parts of the Files view's find features: the tree's search (⌘P, Ctrl+P off a Mac), the reader's find in the
// open file (⌘F) and go to line (Ctrl+G, or `:<n>` in the find field). The components are FileSearch.tsx and
// FindBar.tsx; the searches run on the server, since the client holds only part of the tree and of a file.
import { isMacPlatform } from '../lib/platform'
import type { GrepDone, GrepFile } from '../lib/types'

export type FindKey = 'files' | 'find' | 'line'

/** Which of the Files view's shortcuts a key press is: ⌘P (Ctrl+P off a Mac) the file search, ⌘F (Ctrl+F) find in
 * the file, Ctrl+G go to line on every platform (VS Code's key for it, since ⌘G finds the next match on a Mac); else
 * null. Pure. */
export function findKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean = isMacPlatform()): FindKey | null {
  if (e.shiftKey || e.altKey) return null
  const k = e.key.toLowerCase()
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey
  if (mod && k === 'p') return 'files'
  if (mod && k === 'f') return 'find'
  if (e.ctrlKey && !e.metaKey && k === 'g') return 'line'
  return null
}

export interface FileQuery {
  /** the words the file's path must hold */
  text: string
  /** the line to open the file at: the query ended in `:<n>` */
  line: number | null
}

/** The file search as typed: `val_17.jsonl:120` searches for `val_17.jsonl` and opens the file at line 120, as VS
 * Code's quick open does. Pure. */
export function parseFileQuery(raw: string): FileQuery {
  const m = /^(.*\S)\s*:(\d+)\s*$/.exec(raw)
  if (m) return { text: m[1].trim(), line: Math.max(1, Number(m[2])) }
  return { text: raw.trim(), line: null }
}

/** A name cut into the parts the search's words match (the first place each word falls, case-insensitive) and the
 * rest, for the result row to mark. Pure. */
export function nameSegments(name: string, text: string): { text: string; hit: boolean }[] {
  const low = name.toLowerCase()
  const marked = new Array<boolean>(name.length).fill(false)
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = low.indexOf(w)
    if (i >= 0) marked.fill(true, i, i + w.length)
  }
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < name.length; i++) {
    const last = out[out.length - 1]
    if (last && last.hit === marked[i]) last.text += name[i]
    else out.push({ text: name[i], hit: marked[i] })
  }
  return out
}

/** How many files found by name the search lists before the matches inside files, until the analyst asks for all. */
export const NAMES_SHOWN = 8

/** A row of the file search's results: a heading, a file found by its name, the row that lists the rest of them, a
 * file whose text holds the words (it opens at its first match), or one of its matching lines. */
export type ResultRow =
  | { kind: 'head'; key: string; text: string; note: string }
  | { kind: 'name'; key: string; path: string }
  | { kind: 'more'; key: string; n: number }
  | { kind: 'file'; key: string; path: string; line: number; total: number; complete: boolean }
  | { kind: 'match'; key: string; path: string; line: number; text: string; hit: [number, number] }

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The search's rows, VS Code's quick open and search in one list: the files whose names hold the words first (at
 * most NAMES_SHOWN of them unless `allNames`, then a row for the rest), then the files whose text holds them, each
 * followed by its matching lines. Each part has a heading with its count; a part with nothing found is left out, and
 * the text's part says how far its search read when it stopped at the most files it lists (the row under the results
 * says it when the analyst stopped it), its count marked + once it stopped early. Pure. */
export function resultRows(
  names: { files: readonly { path: string }[]; total: number } | null,
  grep: { files: readonly GrepFile[]; done: GrepDone | null; stopped?: boolean },
  allNames: boolean,
): ResultRow[] {
  const out: ResultRow[] = []
  if (names && names.files.length) {
    const shown = allNames ? names.files : names.files.slice(0, NAMES_SHOWN)
    out.push({ kind: 'head', key: 'h:names', text: 'File names', note: names.total > names.files.length ? `${names.files.length.toLocaleString()} of ${names.total.toLocaleString()}` : names.total.toLocaleString() })
    for (const f of shown) out.push({ kind: 'name', key: `n:${f.path}`, path: f.path })
    if (shown.length < names.files.length) out.push({ kind: 'more', key: 'more', n: names.files.length - shown.length })
  }
  if (grep.files.length) {
    const hits = grep.files.reduce((n, f) => n + f.total, 0)
    const d = grep.done
    const more = grep.stopped || grep.files.some((f) => !f.complete) || (d && !d.complete)
    const note = `${plural(hits, 'match', 'matches')}${more ? '+' : ''} in ${plural(grep.files.length, 'file')}${d && !d.complete && !grep.stopped ? ` · searched ${d.scanned.toLocaleString()} of ${d.of.toLocaleString()} files` : ''}`
    out.push({ kind: 'head', key: 'h:text', text: 'In files', note })
    for (const f of grep.files) {
      out.push({ kind: 'file', key: `f:${f.path}`, path: f.path, line: f.matches[0]?.line ?? 1, total: f.total, complete: f.complete })
      for (const m of f.matches) out.push({ kind: 'match', key: `m:${f.path}:${m.line}`, path: f.path, line: m.line, text: m.text, hit: m.hit })
    }
  }
  return out
}

/** Characters of a snippet a row keeps before its match, so the match shows in the sidebar's narrow column. */
export const SNIP_LEAD = 14

/** A snippet cut at its match, for the row to mark it: the text before (its last SNIP_LEAD characters, after an
 * ellipsis when there were more), the match and the text after. Pure. */
export function snippetParts(text: string, hit: readonly [number, number]): [string, string, string] {
  const a = Math.max(0, Math.min(text.length, hit[0]))
  const b = Math.max(a, Math.min(text.length, hit[1]))
  const before = text.slice(0, a)
  const lead = before.length > SNIP_LEAD ? `…${before.slice(-SNIP_LEAD).trimStart()}` : before
  return [lead, text.slice(a, b), text.slice(b)]
}

/** The go-to-line form of the find field, `:<n>`: the line asked for, 0 while only the colon is typed, null when the
 * field holds text to find. Pure. */
export function lineAsked(raw: string): number | null {
  const m = /^\s*:\s*(\d*)\s*$/.exec(raw)
  if (!m) return null
  return m[1] ? Number(m[1]) : 0
}

/** The match to show first: the first line at or after `from` (the top of what the reader shows), else the first
 * one, as a search from the cursor wraps to the top. -1 when there is none. Pure. */
export function firstMatchFrom(lines: readonly number[], from: number): number {
  if (!lines.length) return -1
  const i = lines.findIndex((l) => l >= from)
  return i < 0 ? 0 : i
}

/** The match a step lands on: `i` moved by `dir`, wrapping at either end of the listed lines. Pure. */
export function stepMatch(i: number, dir: 1 | -1, count: number): number {
  if (count <= 0) return -1
  return (((i + dir) % count) + count) % count
}

/** Where the find stands: the listed line `i` and the match `k` inside it. */
export interface MatchAt {
  i: number
  k: number
}

/** The step to the next or the previous match inside the line (`counts[i]`, how many times it matches), else null,
 * when the step leaves the line. Pure. */
export function stepInLine(at: MatchAt, dir: 1 | -1, counts: readonly number[]): MatchAt | null {
  const k = at.k + dir
  return k >= 0 && k < (counts[at.i] ?? 1) ? { i: at.i, k } : null
}

/** The match's number among the listed ones, from 0: the matches of the lines before it, then its place in its line.
 * Pure. */
export function matchNumber(at: MatchAt, counts: readonly number[]): number {
  let n = 0
  for (let j = 0; j < at.i; j++) n += counts[j] ?? 1
  return n + at.k
}

/** The find field's count: `3 of 120`, `3 of 5,000+` when the search listed or read only part of the file, `No
 * results`. Pure. */
export function matchCount(i: number, total: number, partial: boolean): string {
  if (!total) return partial ? 'No results yet' : 'No results'
  return `${(i + 1).toLocaleString()} of ${total.toLocaleString()}${partial ? '+' : ''}`
}

const FIND = 'reader-find'
const CURRENT = 'reader-find-current'

type HighlightRegistry = Map<string, unknown>
type HighlightCtor = new (...ranges: Range[]) => unknown

/** The places `text` shows (case-insensitive) under `root`, in document order, each with its record's line
 * (`.reader-card[data-line]`). A text whose lower case changes its length is left out, since offsets would shift. */
export function findRanges(root: HTMLElement, text: string): { range: Range; line: string | null }[] {
  const needle = text.toLowerCase()
  const out: { range: Range; line: string | null }[] = []
  if (!needle) return out
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    const low = value.toLowerCase()
    if (low.length !== value.length) continue
    let at = low.indexOf(needle)
    if (at < 0) continue
    const line = node.parentElement?.closest('.reader-card')?.getAttribute('data-line') ?? null
    while (at >= 0) {
      const range = root.ownerDocument.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      out.push({ range, line })
      at = low.indexOf(needle, at + needle.length)
    }
  }
  return out
}

/** Marks every place `text` shows under `root` with the CSS highlight `reader-find` and the current match with
 * `reader-find-current` (files.css), so the views need no part in it: the `k`-th place inside the record of `current`
 * (the last one there when it shows fewer), or every place in that record when `k` is null. Returns the current match's
 * range, or null when the record shows none or the browser has no CSS highlights. */
export function markMatches(root: HTMLElement | null, text: string, current: number | null, k: number | null = null): Range | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
  if (!registry || !Highlight) return null
  registry.delete(FIND)
  registry.delete(CURRENT)
  if (!root || !text) return null
  const found = findRanges(root, text)
  const inCurrent = current == null ? [] : found.filter((f) => f.line === String(current)).map((f) => f.range)
  const pick = k == null ? inCurrent : inCurrent.length ? [inCurrent[Math.min(k, inCurrent.length - 1)]] : []
  registry.set(FIND, new Highlight(...found.map((f) => f.range).filter((r) => !pick.includes(r))))
  registry.set(CURRENT, new Highlight(...pick))
  return k == null ? inCurrent[0] ?? null : pick[0] ?? null
}

/** Where the find's marks stand in their records (`.reader-card[data-line]`): per line, the middle of each mark as a
 * fraction of its record's height. Empty without CSS highlights. */
export function markSpots(): Map<number, number[]> {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  const out = new Map<number, number[]>()
  if (!registry) return out
  const boxes = new Map<Element, DOMRect>()
  for (const name of [FIND, CURRENT]) {
    const ranges = registry.get(name) as Iterable<Range> | undefined
    for (const range of ranges ?? []) {
      const node = range.startContainer
      const card = (node instanceof Element ? node : node.parentElement)?.closest('.reader-card[data-line]')
      if (!card) continue
      let box = boxes.get(card)
      if (!box) boxes.set(card, (box = card.getBoundingClientRect()))
      const r = range.getBoundingClientRect()
      if (box.height <= 0 || r.height <= 0) continue
      const line = Number(card.getAttribute('data-line'))
      const list = out.get(line) ?? []
      list.push((r.top + r.height / 2 - box.top) / box.height)
      out.set(line, list)
    }
  }
  return out
}

/** The DOM event a folded block (views/common Collapsible) opens on. */
export const UNFOLD_EVENT = 'reader-unfold'

/** Opens the folded block that holds `range`, if one does, and says whether it did: the match then shows once the
 * block has rendered open. */
export function unfoldAt(range: Range): boolean {
  const node = range.startContainer
  const folded = (node instanceof Element ? node : node.parentElement)?.closest('.reader-collapsed')
  if (!folded) return false
  folded.dispatchEvent(new Event(UNFOLD_EVENT))
  return true
}

/** Takes the find's marks away. */
export function clearMatches(): void {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  registry?.delete(FIND)
  registry?.delete(CURRENT)
}
