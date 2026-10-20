// @vitest-environment jsdom
// Download in the File browser (src/files/Reader.tsx DownloadButton): the bar of an open file, whatever its kind (text,
// a PDF, an image, a binary file), has the button, which saves the file from the download route under its own name; a
// folder's bar has none. FilesTab is mounted fresh for each open tab, as a reload mounts it, over a server that answers
// the calls it makes.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { api } from '../../src/lib/api.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let WS = ''
let n = 0
const file = (path: string, kind = 'text') => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size_bytes: 100, kind })
const LISTINGS: Record<string, object> = {
  '.': { path: '', folders: [{ path: 'notes', name: 'notes', is_run: false }, { path: 'docs', name: 'docs', is_run: false }], files: [file('README.md'), file('blob.bin')], n_files: 4 },
  notes: { path: 'notes', folders: [], files: [file('notes/day 1 notes.txt'), file('notes/chart.png')], n_files: 2 },
  docs: { path: 'docs', folders: [], files: [file('docs/report.pdf')], n_files: 1 },
}
// what each anchor the button clicked pointed at
let clicked: { href: string | null; download: string }[] = []

beforeEach(() => {
  // jsdom has no ResizeObserver, which the sidebar's dock and the tabs measure with
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  localStorage.clear()
  WS = `download${++n}`
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute('href'), download: this.download })
  })
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    const p = url.pathname
    if (p.endsWith('/sources') && LISTINGS[url.searchParams.get('path') ?? '']) return json(LISTINGS[url.searchParams.get('path')!])
    if (p.endsWith('/views') || p.endsWith('/views/proposals') || p.endsWith('/chats') || p.endsWith('/concepts')) return json([])
    if (p.endsWith('/filters') || p.endsWith('/labels/presence')) return json({})
    // what the question does not need (a file's text, its line count) is not found
    return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Files mounted with `path` the open tab */
async function openTab(path: string) {
  localStorage.setItem(`thimble:${WS}:filesTabs`, JSON.stringify({ tabs: [path], current: path }))
  const el = await mount(<FilesTab ws={WS} active />)
  await settle()
  await settle()
  return el
}
const downloadIn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.reader-bar button[aria-label="Download"]')

describe('Download in the File browser', () => {
  test.each([
    ['a text file in a folder, its name with spaces', 'notes/day 1 notes.txt', 'day 1 notes.txt'],
    ['a PDF', 'docs/report.pdf', 'report.pdf'],
    ['an image', 'notes/chart.png', 'chart.png'],
    ['a binary file', 'blob.bin', 'blob.bin'],
  ])('the bar of %s has the button, which saves the file from the download route under its own name', async (_, path, name) => {
    const el = await openTab(path)
    const button = downloadIn(el)
    expect(button, `${path}: Download in the bar`).not.toBeNull()
    await act(async () => button!.click())
    const url = api.downloadUrl(WS, path)
    expect(url).toBe(`/api/corpora/${WS}/download/${path.split('/').map(encodeURIComponent).join('/')}`)
    expect(clicked).toEqual([{ href: url, download: name }])
    // the anchor it clicked is gone again
    expect(document.querySelector('a[download]')).toBeNull()
  })

  test('a folder open in the File browser has no Download', async () => {
    const el = await openTab('notes')
    expect(el.querySelector('.folder-pane-row'), 'the folder pane lists the folder').not.toBeNull()
    expect(el.querySelector('.reader-bar'), 'the folder pane has its bar').not.toBeNull()
    expect(downloadIn(el)).toBeNull()
  })
})
