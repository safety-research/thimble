// @vitest-environment jsdom
// Where Files sends what it opens when the main area holds several panes (src/files/FilesTab.tsx, src/lib/surfaces.ts):
// a ref placed after a slow answer from the server still names the pane it was asked from, a press in a layer portaled
// out of the shell counts for the pane that opened it, and a view that a pane shows on its own is not shown in Files as
// well. The corpus and the view are invented; a stand-in for the routes answers.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { bus, type Events } from '../../src/lib/bus.ts'
import { FROM_PANE_MS, notePress, pressedPane, renewPress, setShownSurfaces } from '../../src/lib/surfaces.ts'
import { mount, settle, unmountAll } from './mount.tsx'

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Route = (url: URL) => unknown
let route: Route = () => ({})
let held: ((url: URL) => Promise<void>) | null = null
let now = 1_000_000

const VIEW = { slug: 'board', name: 'Board', ok: true, origin: 'workspace', first_file: 'posts.jsonl', claims: ['posts.jsonl'] }

beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    if (held) await held(url)
    const body = url.pathname.endsWith('/proposals')
      ? []
      : url.pathname.endsWith('/sources')
        ? { path: '.', files: [{ path: 'notes.log', size_bytes: 10, kind: 'text' }, { path: 'posts.jsonl', size_bytes: 10, kind: 'jsonl' }], folders: [], n_files: 2 }
        : /\/source(\/around)?$/.test(url.pathname)
          ? { path: url.searchParams.get('path'), kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text: 'a line' }, blocks: [], meta: {} }] }
          : route(url)
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  setShownSurfaces(['files', 'report'])
})

afterEach(() => {
  unmountAll()
  held = null
  route = () => ({})
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setShownSurfaces([])
})

function paneEl(id: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-pane', id)
  el.appendChild(document.createElement('button'))
  document.body.appendChild(el)
  return el.firstElementChild as HTMLElement
}

function collect<K extends keyof Events>(name: K): Events[K][] {
  const got: Events[K][] = []
  const off = bus.on(name, (e) => void got.push(e))
  afterEach(off)
  return got
}

describe('the pane a press landed in', () => {
  test('is the pane a press inside it names, for FROM_PANE_MS', () => {
    notePress(paneEl('p2'))
    expect(pressedPane()).toBe('p2')
    now += FROM_PANE_MS + 1
    expect(pressedPane()).toBe(null)
  })

  test('a press outside every pane names none; a press in a layer outside the shell keeps the pane that opened it', () => {
    notePress(paneEl('p3'))
    now += 1000
    renewPress()
    now += 1000
    expect(pressedPane()).toBe('p3')
    notePress(document.body)
    expect(pressedPane()).toBe(null)
  })
})

describe('Files in a pane', () => {
  test('a ref Files places after the server is slow still opens beside the pane it was asked from', async () => {
    const shows = collect('showTab')
    let release = () => {}
    held = (url) => (url.pathname.endsWith('/views') && url.searchParams.has('path') ? new Promise<void>((r) => (release = r)) : Promise.resolve())
    route = (url) => (url.pathname.endsWith('/views') ? [] : {})
    await mount(<FilesTab ws="corpus" active focused={false} />)
    await settle()
    notePress(paneEl('p2'))
    act(() => bus.emit('openRef', { ref: 'notes.log#L3' }))
    await settle()
    // the answer comes after the press has stopped counting
    now += FROM_PANE_MS * 3
    release()
    await settle()
    await settle()
    expect(shows.at(-1)).toEqual({ tab: 'files', from: 'p2' })
  })

  test('a view that a pane shows on its own gets the place Files showed in it, and Files goes back to the File browser', async () => {
    const shows = collect('showTab')
    const places = collect('openInView')
    route = (url) => {
      if (url.pathname.endsWith('/views')) return [VIEW]
      if (url.pathname.endsWith('/ref')) return { kind: 'record', refs: ['posts.jsonl#L7'], meta: {} }
      return {}
    }
    const el = await mount(<FilesTab ws="corpus" active focused />)
    await settle()
    act(() => bus.emit('openRef', { ref: 'view:board/post-7' }))
    await settle()
    await settle()
    const picked = () => el.querySelector('.files-views [aria-checked="true"]')?.textContent
    expect(picked()).toBe('Board')
    act(() => setShownSurfaces(['files', 'view:board']))
    await settle()
    expect(places.at(-1)).toMatchObject({ slug: 'board', path: 'posts.jsonl', ref: 'view:board/post-7' })
    expect(shows.at(-1)).toMatchObject({ tab: 'view:board' })
    expect(picked()).toBe('File browser')
  })
})
