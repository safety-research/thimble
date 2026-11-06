// @vitest-environment jsdom
// thimble's start page (src/shell/StartPage.tsx) and the top bar's switcher (TopBar WorkspaceSwitcher), which draw the
// server's workspaces (GET /workspaces) under Your folders, each row a link to its workspace. A URL with no workspace,
// or with one the server does not hold, is the start page (App); in a workspace the folder name opens the same list
// with that workspace marked.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../../src/App.tsx'
import { CODE_GONE_TEXT, showCodeGone } from '../../src/lib/notices.ts'
import type { CorpusInfo, WorkspaceRow } from '../../src/lib/types.ts'
import { workspaceHref, workspaceLabel } from '../../src/lib/workspace.ts'
import { WorkspaceSwitcher } from '../../src/shell/TopBar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const ROWS: WorkspaceRow[] = [
  { name: 'logs', kind: 'folder', label: 'logs', folder: 'logs', path: '/home/ana/data/logs' },
  // a row from a server that sends no label: the folder's name all the same
  { name: 'runs-2', kind: 'folder', folder: 'runs', path: '/home/ana/data/runs' },
]

let served: WorkspaceRow[] = ROWS
let fetched: string[] = []

beforeEach(() => {
  // the switcher's popover places itself as it resizes; jsdom has no ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  served = ROWS
  fetched = []
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/workspaces') return json(served)
    if (url === '/api/ui/key') return new Response(null, { status: 204 })
    if (url === '/api/corpora') return json(served.map((r) => ({ name: r.name, manifest: {}, path: r.path })) satisfies CorpusInfo[])
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('a row opens its workspace, and carries no sign-in code, which works once', async () => {
  expect(workspaceHref(ROWS[0])).toBe('/?ws=logs')
  expect(workspaceHref(ROWS[1], '/b/k/')).toBe('/b/k/?ws=runs-2')
  // a start page opened from a link with a code
  window.history.replaceState(null, '', '/#p=abc')
  const el = await mount(<App />)
  await settle()
  expect([...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')].map((a) => a.getAttribute('href'))).toEqual(['/?ws=logs', '/?ws=runs-2'])
})

test('a URL with no workspace is the start page: a title and the rows, each a link to its workspace', async () => {
  const el = await mount(<App />)
  await settle()
  expect(el.querySelector('.start-title')?.textContent).toBe('Workspaces')
  expect([...el.querySelectorAll('.ws-group-title')].map((h) => h.textContent)).toEqual(['Your folders'])
  const rows = [...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')]
  expect(rows.map((a) => a.getAttribute('href'))).toEqual(['/?ws=logs', '/?ws=runs-2'])
  expect(rows.map((a) => a.querySelector('.ws-row-name')?.textContent)).toEqual(['logs', 'runs'])
  expect(rows[0].textContent).toContain('~/data/logs')
  expect(el.querySelector('[aria-current]')).toBeNull()
  expect(el.querySelector('.start-missing')).toBeNull()
  // no paragraph explains anything: the title, the group titles and the rows
  expect(el.querySelectorAll('p').length).toBe(0)
})

test("a link's sign-in code that is gone shows under the title, and its × takes it away with no request", async () => {
  const el = await mount(<App />)
  await settle()
  expect(el.querySelector('.start-notices')).toBeNull()
  await act(async () => showCodeGone())
  expect(el.querySelector('.start-notices .chat-notice-text')?.textContent).toBe(CODE_GONE_TEXT.replace(/`/g, ''))
  const before = fetched.length
  await act(async () => el.querySelector<HTMLButtonElement>('.start-notices .chat-notice-x')!.click())
  expect(el.querySelector('.start-notices')).toBeNull()
  expect(fetched.slice(before)).toEqual([])
})

test('a row shows the server\'s label, else the folder\'s name or the workspace\'s name', () => {
  expect(ROWS.map(workspaceLabel)).toEqual(['logs', 'runs'])
  expect(workspaceLabel({ name: 'odd', folder: '' })).toBe('odd')
})

test('a URL naming a workspace the server does not hold is the start page, saying so in one line', async () => {
  window.history.replaceState(null, '', '/?ws=gone-folder')
  const el = await mount(<App />)
  await settle()
  await settle()
  expect(el.querySelector('.start-missing')?.textContent).toContain('gone-folder')
  expect(el.querySelectorAll('a.ws-row').length).toBe(2)
})

test('with no folder the page says how to open one', async () => {
  served = []
  const el = await mount(<App />)
  await settle()
  expect(el.querySelector('.ws-list')).toBeNull()
  expect(el.querySelector('.start-empty code')?.textContent).toBe('thimble-browser')
})

test('the folder name in the top bar opens the same list with this workspace marked', async () => {
  const el = await mount(<WorkspaceSwitcher ws="runs-2" label="~/data/runs" />)
  const button = el.querySelector<HTMLButtonElement>('button.shell-corpus-name')!
  expect(button.textContent).toBe('~/data/runs')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(fetched).not.toContain('/api/workspaces') // loaded when it opens
  await act(async () => button.click())
  await settle()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const sheet = document.querySelector('.popover.ws-switcher')!
  expect(sheet.getAttribute('aria-label')).toBe('Workspaces')
  expect([...sheet.querySelectorAll('.ws-group-title')].map((h) => h.textContent)).toEqual(['Your folders'])
  const current = sheet.querySelectorAll('a.ws-row[aria-current="page"]')
  expect(current.length).toBe(1)
  expect(current[0].getAttribute('data-ws')).toBe('runs-2')
  expect(current[0].querySelector('.ws-row-name')?.textContent).toBe('runs') // as the start page shows it
  expect(current[0].querySelector('.ws-here')).not.toBeNull()
  expect(sheet.querySelector<HTMLAnchorElement>('a.ws-row[data-ws="logs"]')?.getAttribute('href')).toBe('/?ws=logs')
  // Escape closes it
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('.popover.ws-switcher')).toBeNull()
})
