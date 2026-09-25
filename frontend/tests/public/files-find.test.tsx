// @vitest-environment jsdom
// The Files view's ways to find something on a large corpus (src/files/find.ts, FileSearch.tsx, FindBar.tsx, the
// Reader): the shortcuts, the file search's query and rows, the find bar's count and steps, a transcript whose first
// page holds only hidden system records, and a binary file told by the server. The corpus is invented; a stand-in for
// the routes answers.
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FileSearch } from '../../src/files/FileSearch.tsx'
import { findKey, firstMatchFrom, lineAsked, matchCount, matchNumber, NAMES_SHOWN, nameSegments, parseFileQuery, resultRows, snippetParts, stepInLine, stepMatch, unfoldAt } from '../../src/files/find.ts'
import { Collapsible } from '../../src/files/views/common.tsx'
import { takeLines } from '../../src/lib/api.ts'
import { binaryReason, Reader, type FindAsk } from '../../src/files/Reader.tsx'
import { findColumn } from '../../src/files/Ruler.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { HIDDEN_RUN_NOTE, hiddenRuns } from '../../src/files/views/transcript.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const labels = { on: [], all: [], presence: new Map() } as unknown as FilesLabels
type Route = (url: URL) => unknown
let route: Route = () => ({})
const requests: string[] = []

beforeEach(() => {
  requests.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    requests.push(url.pathname + url.search)
    const body = route(url)
    // a route may answer a stream of JSON lines as its text
    return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': typeof body === 'string' ? 'application/x-ndjson' : 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Wait past the searches' debounce, inside act. */
const pause = (ms = 320) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))

function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra })))

describe('the pure parts', () => {
  test('the search results: names first, capped until asked, then each file whose text matched and its lines', () => {
    const names = { files: Array.from({ length: NAMES_SHOWN + 3 }, (_, i) => ({ path: `runs/r${i}/otters.jsonl` })), total: 40 }
    const grep = {
      files: [{ path: 'a.txt', total: 12, complete: false, matches: [{ line: 2, text: 'an otter', hit: [3, 8] as [number, number] }] }],
      done: { done: true as const, files: 1, hits: 12, scanned: 3, of: 9, complete: false },
    }
    const rows = resultRows(names, grep, false)
    expect(rows.map((r) => r.kind)).toEqual(['head', ...Array(NAMES_SHOWN).fill('name'), 'more', 'head', 'file', 'match'])
    expect(rows[0]).toMatchObject({ text: 'File names', note: `${NAMES_SHOWN + 3} of 40` })
    expect(rows.find((r) => r.kind === 'more')).toMatchObject({ n: 3 })
    expect(rows.find((r) => r.key === 'h:text')).toMatchObject({ text: 'In files', note: '12 matches+ in 1 file · searched 3 of 9 files' })
    expect(rows.find((r) => r.kind === 'file')).toMatchObject({ path: 'a.txt', line: 2 })
    expect(resultRows(names, grep, true).filter((r) => r.kind === 'name')).toHaveLength(NAMES_SHOWN + 3)
    expect(resultRows({ files: [], total: 0 }, { files: [], done: null }, false)).toEqual([])
    expect(snippetParts('an otter swims', [3, 8])).toEqual(['an ', 'otter', ' swims'])
    expect(snippetParts('short', [3, 99])).toEqual(['sho', 'rt', ''])
    expect(snippetParts('…a long run of words before the otter', [32, 37])).toEqual(['…ds before the ', 'otter', ''])
  })
  test('a stream of JSON lines is cut at its line ends, the part still arriving kept for the next chunk', () => {
    expect(takeLines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(takeLines('{"b":2}\n\n', false)).toEqual({ lines: ['{"b":2}'], rest: '' })
    expect(takeLines('{"c":3}', true)).toEqual({ lines: ['{"c":3}'], rest: '' })
  })

  test('the shortcuts: ⌘ on a Mac, Ctrl elsewhere, and Ctrl+G for a line on both', () => {
    const k = (key: string, m: Partial<KeyboardEventInit> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m })
    expect(findKey(k('p', { metaKey: true }), true)).toBe('files')
    expect(findKey(k('f', { metaKey: true }), true)).toBe('find')
    expect(findKey(k('g', { ctrlKey: true }), true)).toBe('line')
    expect(findKey(k('g', { metaKey: true }), true)).toBe(null)
    expect(findKey(k('p', { ctrlKey: true }), true)).toBe(null)
    expect(findKey(k('P', { ctrlKey: true }), false)).toBe('files')
    expect(findKey(k('f', { ctrlKey: true }), false)).toBe('find')
    expect(findKey(k('g', { ctrlKey: true }), false)).toBe('line')
    expect(findKey(k('f', { ctrlKey: true, shiftKey: true }), false)).toBe(null)
    expect(findKey(k('f'), false)).toBe(null)
  })

  test('the file query, its line and the marked name', () => {
    expect(parseFileQuery('  shard_07.jsonl:4120 ')).toEqual({ text: 'shard_07.jsonl', line: 4120 })
    expect(parseFileQuery('logs day-3')).toEqual({ text: 'logs day-3', line: null })
    expect(parseFileQuery(':12')).toEqual({ text: ':12', line: null })
    expect(nameSegments('Shard_07.jsonl', 'shard 07')).toEqual([
      { text: 'Shard', hit: true },
      { text: '_', hit: false },
      { text: '07', hit: true },
      { text: '.jsonl', hit: false },
    ])
  })

  test('the find field: a line, the first match from the top, steps that wrap and the count', () => {
    expect([lineAsked(':'), lineAsked(' :88 '), lineAsked('otter'), lineAsked(':8a')]).toEqual([0, 88, null, null])
    expect(firstMatchFrom([4, 40, 400], 41)).toBe(2)
    expect(firstMatchFrom([4, 40, 400], 401)).toBe(0)
    expect(firstMatchFrom([], 1)).toBe(-1)
    expect([stepMatch(2, 1, 3), stepMatch(0, -1, 3), stepMatch(0, 1, 0)]).toEqual([0, 2, -1])
    expect([matchCount(0, 1200, false), matchCount(4, 5000, true), matchCount(-1, 0, false)]).toEqual(['1 of 1,200', '5 of 5,000+', 'No results'])
  })

  test('the matches inside a line: a step stays in the line until its last match, and each has its number', () => {
    const counts = [3, 1, 2]
    expect(stepInLine({ i: 0, k: 0 }, 1, counts)).toEqual({ i: 0, k: 1 })
    expect(stepInLine({ i: 0, k: 2 }, 1, counts)).toBeNull()
    expect(stepInLine({ i: 2, k: 1 }, -1, counts)).toEqual({ i: 2, k: 0 })
    expect(stepInLine({ i: 1, k: 0 }, -1, counts)).toBeNull()
    expect([matchNumber({ i: 0, k: 2 }, counts), matchNumber({ i: 1, k: 0 }, counts), matchNumber({ i: 2, k: 1 }, counts)]).toEqual([2, 3, 5])
  })

  test('the ruler marks each matching line of the find, and the transcript notes the long runs of hidden records', () => {
    const col = findColumn([1, 2, 3, 5000, 10000], 10000, 'clock.wait')
    expect(col.id).toBe('find')
    expect(col.name).toBe('“clock.wait”')
    expect(col.ticks.map((t) => [t.from, t.to])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [5000, 5000],
      [10000, 10000],
    ])
    const long = Array(HIDDEN_RUN_NOTE).fill('system')
    const types = [...long, 'assistant', 'system', 'user', ...long]
    const lines = types.map((_, i) => i + 1)
    expect([...hiddenRuns(types, lines)]).toEqual([
      [1, HIDDEN_RUN_NOTE],
      [HIDDEN_RUN_NOTE + 4, HIDDEN_RUN_NOTE],
    ])
    expect([...hiddenRuns(['system', 'tool_progress'], [7, 8])]).toEqual([[7, 2]])
    expect(binaryReason(8_375_611_944)).toBe('A binary file of 7.8 GB (8,375,611,944 bytes), with no text to show here.')
  })
})

describe('a match inside a folded tool output', () => {
  test('opens the block that holds it; a match outside any folded block opens nothing', async () => {
    const text = Array.from({ length: 20 }, (_, i) => (i === 17 ? 'asv_bench ran' : `line ${i}`)).join('\n')
    const el = await mount(
      <>
        <Collapsible lines={20}>
          <div className="reader-block">{text}</div>
        </Collapsible>
        <p>asv_bench outside</p>
      </>,
    )
    const at = (node: Node, needle: string) => {
      const r = document.createRange()
      const i = node.nodeValue!.indexOf(needle)
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      return r
    }
    const block = el.querySelector('.reader-block')!.firstChild!
    expect(el.querySelector('.reader-collapse')!.className).toContain('reader-collapsed')
    expect(unfoldAt(at(el.querySelector('p')!.firstChild!, 'asv_bench'))).toBe(false)
    let opened = false
    await act(async () => void (opened = unfoldAt(at(block, 'asv_bench'))))
    expect(opened).toBe(true)
    expect(el.querySelector('.reader-collapse')!.className).not.toContain('reader-collapsed')
    expect(el.querySelector('.reader-expand')!.textContent).toBe('Collapse')
    expect(unfoldAt(at(block, 'asv_bench')), 'an open block needs no unfolding').toBe(false)
  })
})

describe('the file search', () => {
  test('rows for the words typed, ↓ and Enter open one, at the line the query names', async () => {
    route = (url) =>
      url.pathname.endsWith('/sources/find')
        ? { q: url.searchParams.get('q'), total: 2, files: [
            { path: 'runs/a/shard_07.jsonl', kind: 'text', size_bytes: 10, title: 'shard_07' },
            { path: 'runs/b/shard_07_eval.jsonl', kind: 'text', size_bytes: 10, title: 'shard_07_eval' },
          ] }
        : {}
    const opened: [string, number | null][] = []
    const el = await mount(
      <FileSearch ws="otters" inputRef={{ current: null }} onOpen={(p, l) => opened.push([p, l])}>
        <div className="the-tree">tree</div>
      </FileSearch>,
    )
    expect(el.querySelector('.the-tree')).not.toBeNull()
    const input = el.querySelector<HTMLInputElement>('.files-search input')!
    type(input, 'shard_07:31')
    await pause(250)
    expect(requests.some((u) => u.startsWith('/api/corpora/otters/sources/find?q=shard_07'))).toBe(true)
    expect(el.querySelector('.the-tree')).toBeNull()
    const rows = [...el.querySelectorAll('.files-found-row')]
    expect(rows.map((r) => r.querySelector('.files-found-dir')?.textContent)).toEqual(['runs/a', 'runs/b'])
    expect(rows[0].querySelector('mark')?.textContent).toBe('shard_07')
    expect([...el.querySelectorAll('.files-found-head')].map((h) => h.textContent)).toEqual(['File names2'])
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(opened).toEqual([['runs/b/shard_07_eval.jsonl', 31]])
    key(input, 'Escape')
    expect(input.value).toBe('')
    expect(el.querySelector('.the-tree')).not.toBeNull()
  })

  test('file names first, then the files whose text holds the words with their lines; Enter on a line opens the file there', async () => {
    const grepped = [
      { path: 'notes/otters.md', total: 3, complete: true, matches: [
        { line: 4, text: 'sea otter holds a stone', hit: [4, 9] },
        { line: 9, text: 'the otter dives', hit: [4, 9] },
      ] },
      { done: true, files: 1, hits: 3, scanned: 7, of: 7, complete: true },
    ]
    route = (url) =>
      url.pathname.endsWith('/sources/find')
        ? { q: 'otter', total: 1, files: [{ path: 'otter_log.txt', kind: 'text', size_bytes: 10, title: 'otter_log' }] }
        : url.pathname.endsWith('/sources/grep')
          ? grepped.map((g) => JSON.stringify(g)).join('\n') + '\n'
          : {}
    const opened: [string, number | null][] = []
    const el = await mount(
      <FileSearch ws="otters" inputRef={{ current: null }} onOpen={(p, l) => opened.push([p, l])}>
        <div className="the-tree">tree</div>
      </FileSearch>,
    )
    const input = el.querySelector<HTMLInputElement>('.files-search input')!
    type(input, 'otter')
    await pause(400)
    expect(requests.some((u) => u === '/api/corpora/otters/sources/grep?q=otter')).toBe(true)
    expect([...el.querySelectorAll('.files-found-head')].map((h) => h.textContent)).toEqual(['File names1', 'In files3 matches in 1 file'])
    const lines = [...el.querySelectorAll('.files-found-line')]
    expect(lines.map((l) => l.querySelector('.files-found-lno')?.textContent)).toEqual(['4', '9'])
    expect(lines[0].querySelector('mark')?.textContent).toBe('otter')
    expect(lines[0].getAttribute('data-anchor')).toBe('notes/otters.md#L4')
    expect(el.querySelector('.files-found-infile .files-found-n')?.textContent).toBe('3')
    // the name, the file whose text matched, its first line, its second
    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(opened).toEqual([['notes/otters.md', 9]])
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(opened.at(-1)).toEqual(['otter_log.txt', null])
  })
})

const stream = (line: number, type: string) => ({
  line,
  record: type === 'system' ? { type, subtype: 'thinking_tokens', session_id: 's1' } : { type, session_id: 's1', message: { role: type, content: `turn at ${line}` } },
  blocks: [{ kind: 'text', text: type === 'system' ? 'thinking_tokens' : `turn at ${line} about otters` }],
  meta: {},
})

describe('the reader', () => {
  // jsdom lays nothing out: the reader's body is given a height of 600px and each record shown 30px, so the reader
  // knows when the records fill it, as a browser does
  const own = (name: 'scrollHeight' | 'clientHeight') => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  const kept = { scrollHeight: own('scrollHeight'), clientHeight: own('clientHeight') }
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('reader-body') ? 600 : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList.contains('reader-body') ? this.querySelectorAll('.reader-card').length * 30 : 0 } })
  })
  afterEach(() => {
    for (const [name, d] of Object.entries(kept)) if (d) Object.defineProperty(HTMLElement.prototype, name, d)
  })

  test('a transcript whose first page is all hidden system records pages on and says how many it hides', async () => {
    const types = (n: number) => (n <= 130 ? 'system' : n % 2 ? 'assistant' : 'user')
    route = (url) => {
      if (!url.pathname.endsWith('/source')) return {}
      const start = Number(url.searchParams.get('start') ?? 1)
      const count = Number(url.searchParams.get('count') ?? 100)
      const records = []
      for (let n = start; n < start + count && n <= 180; n++) records.push(stream(n, types(n)))
      return { path: 'run/transcript.jsonl', kind: 'text', total_lines: 180, start, records }
    }
    const el = await mount(<Reader workspace="otters" path="run/transcript.jsonl" kind="text" lead={null} labels={labels} />)
    for (let i = 0; i < 6; i++) await settle()
    expect(requests.some((u) => u.includes('start=101'))).toBe(true)
    expect(el.querySelector('.reader-hidden-run')?.textContent).toContain('130 system records hidden')
    expect(el.querySelector('.reader-rec-assistant')?.getAttribute('data-line')).toBe('131')
  })

  test('a binary file says so with its size at once, with no ruler and no find', async () => {
    route = (url) => (url.pathname.endsWith('/source') ? { path: 'blobs/weights.bin', kind: 'text', total_lines: 0, start: 1, records: [], binary: true, size_bytes: 3 * 1024 ** 3 } : {})
    const el = await mount(<Reader workspace="otters" path="blobs/weights.bin" kind="text" lead={<span />} labels={labels} findAsk={{ mode: 'find', n: 0 }} />)
    await settle()
    await settle()
    expect(el.querySelector('.reader-noview-reason')?.textContent).toBe('A binary file of 3.0 GB (3,221,225,472 bytes), with no text to show here.')
    expect(el.querySelector('.reader-ruler')).toBeNull()
    expect(el.querySelector('.reader-find-open')).toBeNull()
  })

  test('the find bar: a shortcut opens it, the server counts, Enter steps and loads a far match, :<n> goes to a line', async () => {
    route = (url) => {
      if (url.pathname.endsWith('/source/find')) return { path: 'notes.log', q: url.searchParams.get('q'), lines: [3, 900], total: 2, complete: true, scanned: 1000, total_lines: 1000 }
      if (url.pathname.endsWith('/source/around')) {
        const line = Number(url.searchParams.get('line'))
        const records = []
        for (let n = Math.max(1, line - 50); n <= Math.min(1000, line + 50); n++) records.push({ line: n, record: { text: n % 897 === 3 ? `the otter at ${n}` : `line ${n}` }, blocks: [], meta: {} })
        return { path: 'notes.log', kind: 'text', total_lines: 1000, start: Math.max(1, line - 50), records }
      }
      if (url.pathname.endsWith('/source')) {
        const start = Number(url.searchParams.get('start') ?? 1)
        const count = Number(url.searchParams.get('count') ?? 100)
        const records = []
        for (let n = start; n < start + count && n <= 1000; n++) records.push({ line: n, record: { text: n === 3 ? 'the otter at 3' : `line ${n}` }, blocks: [], meta: {} })
        return { path: 'notes.log', kind: 'text', total_lines: 1000, start, records }
      }
      return {}
    }
    const props = { workspace: 'otters', path: 'notes.log', kind: 'text' as const, lead: <span />, labels }
    // FilesTab's shortcuts reach the reader as a bumped ask
    function WithShortcuts() {
      const [ask, setAsk] = useState<FindAsk>({ mode: 'find', n: 0 })
      return (
        <>
          <button className="ask-find" onClick={() => setAsk((a) => ({ mode: 'find', n: a.n + 1 }))} />
          <button className="ask-line" onClick={() => setAsk((a) => ({ mode: 'line', n: a.n + 1 }))} />
          <Reader {...props} findAsk={ask} />
        </>
      )
    }
    const again = await mount(<WithShortcuts />)
    await settle()
    expect(again.querySelector('.reader-find')).toBeNull()
    act(() => again.querySelector<HTMLButtonElement>('.ask-line')!.click())
    let input = again.querySelector<HTMLInputElement>('.reader-find input')!
    expect(input.value).toBe(':')
    expect(document.activeElement).toBe(input)
    // the bar's own button closes it, and the find shortcut opens it again with the focus in the field
    act(() => again.querySelector<HTMLButtonElement>('.reader-find-open')!.click())
    expect(again.querySelector('.reader-find')).toBeNull()
    act(() => again.querySelector<HTMLButtonElement>('.ask-find')!.click())
    input = again.querySelector<HTMLInputElement>('.reader-find input')!
    expect(document.activeElement).toBe(input)
    type(input, 'otter')
    await pause()
    await settle()
    expect(requests.some((u) => u.startsWith('/api/corpora/otters/source/find?path=notes.log&q=otter'))).toBe(true)
    expect(again.querySelector('.reader-find-count')?.textContent).toBe('1 of 2')
    key(input, 'Enter')
    await settle()
    await settle()
    expect(again.querySelector('.reader-find-count')?.textContent).toBe('2 of 2')
    expect(requests.some((u) => u.includes('/source/around') && u.includes('line=900'))).toBe(true)
    key(input, 'Enter', { shiftKey: true })
    expect(again.querySelector('.reader-find-count')?.textContent).toBe('1 of 2')
    // go to a line
    type(input, ':450')
    expect(again.querySelector('.reader-find-count')?.textContent).toBe('of 1,000')
    key(input, 'Enter')
    await settle()
    await settle()
    expect(requests.some((u) => u.includes('/source/around') && u.includes('line=450'))).toBe(true)
    expect(again.querySelector('.reader-find')).toBeNull()
  })

  test('the find bar counts every match in a file of one long line and steps through them inside it', async () => {
    const text = Array.from({ length: 5 }, (_, i) => `note ${i}: the otter surfaced`).join(' … ')
    route = (url) => {
      if (url.pathname.endsWith('/source/find')) return { path: 'log.json', q: 'otter', lines: [1], counts: [5], total: 1, matches: 5, complete: true, scanned: 1, total_lines: 1 }
      if (url.pathname.endsWith('/source')) return { path: 'log.json', kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text }, blocks: [], meta: {} }] }
      return {}
    }
    const el = await mount(<Reader workspace="otters" path="log.json" kind="text" lead={<span />} labels={labels} />)
    await settle()
    act(() => el.querySelector<HTMLButtonElement>('.reader-find-open')!.click())
    const input = el.querySelector<HTMLInputElement>('.reader-find input')!
    type(input, 'otter')
    await pause()
    await settle()
    expect(el.querySelector('.reader-find-count')?.textContent).toBe('1 of 5')
    for (const want of ['2 of 5', '3 of 5', '4 of 5', '5 of 5', '1 of 5']) {
      key(input, 'Enter')
      await settle()
      expect(el.querySelector('.reader-find-count')?.textContent).toBe(want)
    }
    key(input, 'Enter', { shiftKey: true })
    expect(el.querySelector('.reader-find-count')?.textContent).toBe('5 of 5')
    // one line holds every match: no step asks for another place in the file
    expect(requests.filter((u) => u.includes('/source/around'))).toEqual([])
  })
})
