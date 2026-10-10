// @vitest-environment jsdom
// The view Files shows is kept per workspace (src/files/FilesTab.tsx keptView), so a page reload opens Files on that
// view again rather than on the File browser, and on the File browser once the views are read and the view is gone.
// FilesTab is mounted fresh, as a reload mounts it, over a server that answers the calls it makes.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FilesTab, keptView } from '../../src/files/FilesTab.tsx'
import { BROWSER, viewKey } from '../../src/files/ViewsBar.tsx'
import { refreshProposals } from '../../src/lib/proposals.ts'
import { refreshViews } from '../../src/lib/views.ts'
import { mount, settle, unmountAll } from './mount.tsx'

// each test its own workspace, since the views list is read once per workspace and shared
let WS = ''
let n = 0
const BOARD = { slug: 'board', origin: 'workspace', name: 'Board', description: '', claims: ['board.jsonl'], accepts: [], units: [], libs: [], built: '2026-10-10T00:00:00Z', ok: true, forms: [], first_file: 'board.jsonl', files: ['board.jsonl'], n_files: 1 }
const LISTING = { path: '', folders: [], files: [{ path: 'README.md', name: 'README.md', size_bytes: 10, kind: 'text' }, { path: 'board.jsonl', name: 'board.jsonl', size_bytes: 100, kind: 'jsonl' }], n_files: 2 }

let views: object[] = []
// the views list answers once `release` is called, as a slow server does
let release: () => void = () => undefined

beforeEach(() => {
  // jsdom has no ResizeObserver, which the sidebar's dock measures with
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  localStorage.clear()
  WS = `kept${++n}`
  views = [BOARD]
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  release = open
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    const p = url.pathname
    if (p.endsWith('/views') && !url.search) return gate.then(() => json(views))
    if (p.endsWith('/views') || p.endsWith('/views/proposals') || p.endsWith('/chats') || p.endsWith('/concepts')) return json([])
    if (p.endsWith('/filters') || p.endsWith('/labels/presence')) return json({})
    if (p.endsWith('/sources')) return json(LISTING)
    if (p.endsWith('/frame')) return new Response('<!doctype html><html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    // what neither question needs (a file's text, the view's notes) is not found
    return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** Files mounted as a reload mounts it, the views list read when `release` lets it answer */
async function reload() {
  const el = await mount(<FilesTab ws={WS} active />)
  void refreshProposals(WS)
  const read = refreshViews(WS)
  await settle()
  return { el, read }
}
const shows = (el: HTMLElement) => (el.querySelector('.view-pane') ? 'view' : el.querySelector('.files-body.is-view') ? 'waiting' : el.querySelector('.files-side-tree') ? 'browser' : 'none')

describe('the view Files shows, kept through a reload', () => {
  test('what the bar opens on: the kept view while it is listed or the views are not read yet, else the File browser', () => {
    expect(keptView('board', [], false)).toBe(viewKey('board'))
    expect(keptView('board', [{ slug: 'board' }], true)).toBe(viewKey('board'))
    expect(keptView('board', [{ slug: 'inbox' }], true)).toBe(BROWSER)
    expect(keptView(null, [{ slug: 'board' }], true)).toBe(BROWSER)
  })

  test('a reload opens Files on the view it showed, waiting for the views list rather than showing the File browser first', async () => {
    localStorage.setItem(`thimble:${WS}:filesView`, JSON.stringify('board'))
    const { el, read } = await reload()
    expect(shows(el)).toBe('waiting')
    release()
    await act(async () => void (await read))
    await settle()
    expect(shows(el)).toBe('view')
    expect(el.querySelector('.view-pane-name')?.textContent).toBe('Board')
    // the File browser picked in the bar is what the next reload opens on
    const browser = [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((o) => o.textContent?.includes('File browser'))!
    await act(async () => browser.click())
    await settle()
    expect(shows(el)).toBe('browser')
    expect(JSON.parse(localStorage.getItem(`thimble:${WS}:filesView`)!)).toBe(null)
    // and the view picked again is kept again
    const board = [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((o) => o.textContent?.includes('Board'))!
    await act(async () => board.click())
    await settle()
    expect(shows(el)).toBe('view')
    expect(JSON.parse(localStorage.getItem(`thimble:${WS}:filesView`)!)).toBe('board')
  })

  test('a reload whose view is gone opens on the File browser and forgets it', async () => {
    localStorage.setItem(`thimble:${WS}:filesView`, JSON.stringify('board'))
    views = []
    const { el, read } = await reload()
    release()
    await act(async () => void (await read))
    await settle()
    expect(shows(el)).toBe('browser')
    expect(JSON.parse(localStorage.getItem(`thimble:${WS}:filesView`)!)).toBe(null)
  })
})
