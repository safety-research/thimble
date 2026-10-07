// @vitest-environment jsdom
// thimble's start page (src/shell/StartPage.tsx) and the top bar's switcher (TopBar WorkspaceSwitcher), which draw the
// server's workspaces (GET /workspaces) in the groups Demo, Examples and Your folders, an empty group left out, each row
// a link to its workspace. A URL with no workspace, or with one the server does not hold, is the start page (App); in a
// workspace the folder name opens the same list with that workspace marked.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../../src/App.tsx'
import type { CorpusInfo, WorkspaceRow } from '../../src/lib/types.ts'
import { groupWorkspaces, workspaceHref } from '../../src/lib/workspace.ts'
import { WorkspaceSwitcher } from '../../src/shell/TopBar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const ROWS: WorkspaceRow[] = [
  { name: 'collusion-wiki', kind: 'demo', folder: 'collusion-wiki', path: '/h/.thimble/demo/collusion-wiki', dataset: 'collusion-wiki', title: 'collusion.wiki', blurb: 'Logs of a small wiki.', ready: true },
  { name: 'mythos-5', kind: 'demo', folder: 'mythos-5', path: '/h/.thimble/demo/mythos-5', dataset: 'mythos-5', title: 'Mythos 5', blurb: 'The transcript.', ready: false },
  { name: 'example-timeline', kind: 'example', folder: 'example-timeline', path: '/h/.thimble/examples/example-timeline', view: { slug: 'timeline', name: 'Timeline' } },
  { name: 'logs', kind: 'folder', folder: 'logs', path: '/home/ana/data/logs' },
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
    if (url === '/api/corpora') return json(served.map((r) => ({ name: r.name, manifest: {}, path: r.path })) satisfies CorpusInfo[])
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('the groups come in order, each with its rows, and an empty group is left out', () => {
  expect(groupWorkspaces(ROWS).map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
    ['Demo', ['collusion-wiki', 'mythos-5']],
    ['Examples', ['example-timeline']],
    ['Your folders', ['logs']],
  ])
  expect(groupWorkspaces(ROWS.filter((r) => r.kind !== 'example')).map((g) => g.title)).toEqual(['Demo', 'Your folders'])
  expect(groupWorkspaces([])).toEqual([])
})

test('a row opens its workspace, an example at its view, and keeps a page key the server has not taken yet', () => {
  expect(workspaceHref(ROWS[0])).toBe('/?ws=collusion-wiki')
  expect(workspaceHref(ROWS[2])).toBe('/?ws=example-timeline&ref=view%3Atimeline')
  expect(workspaceHref(ROWS[3], '/', '#k=abc')).toBe('/?ws=logs#k=abc')
  expect(workspaceHref(ROWS[3], '/', '#other=1')).toBe('/?ws=logs')
})

test('a URL with no workspace is the start page: a title and the rows, each a link to its workspace', async () => {
  const el = await mount(<App />)
  await settle()
  expect(el.querySelector('.start-title')?.textContent).toBe('Workspaces')
  expect([...el.querySelectorAll('.ws-group-title')].map((h) => h.textContent)).toEqual(['Demo', 'Examples', 'Your folders'])
  const rows = [...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')]
  expect(rows.map((a) => a.getAttribute('href'))).toEqual(['/?ws=collusion-wiki', '/?ws=mythos-5', '/?ws=example-timeline&ref=view%3Atimeline', '/?ws=logs'])
  const [cw, m5, ex, logs] = rows
  expect(cw.textContent).toContain('Logs of a small wiki.')
  expect(cw.querySelector('.ws-ready')?.textContent).toBe('analysis ready')
  expect(m5.querySelector('.ws-ready')).toBeNull()
  expect(ex.querySelector('.ws-view')?.textContent).toBe('Timeline')
  expect(logs.querySelector('.ws-row-name')?.textContent).toBe('logs')
  expect(logs.textContent).toContain('~/data/logs')
  expect(el.querySelector('[aria-current]')).toBeNull()
  expect(el.querySelector('.start-missing')).toBeNull()
  // no paragraph explains anything: the title, the group titles and the rows
  expect(el.querySelectorAll('p').length).toBe(0)
})

test('a URL naming a workspace the server does not hold is the start page, saying so in one line', async () => {
  window.history.replaceState(null, '', '/?ws=gone-folder')
  const el = await mount(<App />)
  await settle()
  await settle()
  expect(el.querySelector('.start-missing')?.textContent).toContain('gone-folder')
  expect(el.querySelectorAll('a.ws-row').length).toBe(4)
})

test('with only the analyst\'s folders the page shows that group alone, and with none it says how to open one', async () => {
  served = ROWS.filter((r) => r.kind === 'folder')
  let el = await mount(<App />)
  await settle()
  expect([...el.querySelectorAll('.ws-group-title')].map((h) => h.textContent)).toEqual(['Your folders'])
  unmountAll()
  served = []
  el = await mount(<App />)
  await settle()
  expect(el.querySelector('.ws-list')).toBeNull()
  expect(el.querySelector('.start-empty')?.textContent).toContain('thimble demo')
})

test('the folder name in the top bar opens the same list with this workspace marked', async () => {
  const el = await mount(<WorkspaceSwitcher ws="mythos-5" label="~/.thimble/demo/mythos-5" />)
  const button = el.querySelector<HTMLButtonElement>('button.shell-corpus-name')!
  expect(button.textContent).toBe('~/.thimble/demo/mythos-5')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(fetched).not.toContain('/api/workspaces') // loaded when it opens
  await act(async () => button.click())
  await settle()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const sheet = document.querySelector('.popover.ws-switcher')!
  expect(sheet.getAttribute('aria-label')).toBe('Workspaces')
  expect([...sheet.querySelectorAll('.ws-group-title')].map((h) => h.textContent)).toEqual(['Demo', 'Examples', 'Your folders'])
  const current = sheet.querySelectorAll('a.ws-row[aria-current="page"]')
  expect(current.length).toBe(1)
  expect(current[0].getAttribute('data-ws')).toBe('mythos-5')
  expect(current[0].querySelector('.ws-here')).not.toBeNull()
  expect(sheet.querySelector<HTMLAnchorElement>('a.ws-row[data-ws="logs"]')?.getAttribute('href')).toBe('/?ws=logs')
  // Escape closes it
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('.popover.ws-switcher')).toBeNull()
})
