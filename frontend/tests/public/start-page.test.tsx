// @vitest-environment jsdom
// thimble's start page (src/shell/StartPage.tsx) and the top bar's switcher (TopBar WorkspaceSwitcher), which draw the
// server's workspaces (GET /workspaces) in the groups Demo, Examples and Your folders, an empty group left out, under one
// line that says the demo datasets are example data while one is listed, each row
// a link to its workspace, a demo shown by its dataset's name rather than its workspace's demo-<dataset>, and a demo or an
// example opened at the view its row names. A URL with no workspace, or with one the server does not hold, is the start
// page (App), and one naming a workspace renamed since goes to its new name; a workspace opened the first time without a
// ref opens at its row's view (Shell); in a workspace the folder name opens the same list with that workspace marked.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../../src/App.tsx'
import type { CorpusInfo, WorkspaceRow } from '../../src/lib/types.ts'
import { groupWorkspaces, storageKey, workspaceHref } from '../../src/lib/workspace.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const ROWS: WorkspaceRow[] = [
  { name: 'demo-collusion-wiki', kind: 'demo', label: 'collusion-wiki', folder: 'collusion-wiki', path: '/h/.thimble/demo/collusion-wiki', dataset: 'collusion-wiki', title: 'collusion.wiki', blurb: 'Logs of a small wiki.', ready: true, renamed_from: ['collusion-wiki-2'], view: { slug: 'wiki-page-history', name: 'Wiki Page History' } },
  // a row from a server that sends no label: the dataset's name all the same
  { name: 'demo-mythos-5', kind: 'demo', folder: 'mythos-5', path: '/h/.thimble/demo/mythos-5', dataset: 'mythos-5', title: 'Mythos 5', blurb: 'The transcript.', ready: false },
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

test('the groups come in order, each with its rows, and an empty group is left out', () => {
  expect(groupWorkspaces(ROWS).map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
    ['Demo', ['demo-collusion-wiki', 'demo-mythos-5']],
    ['Examples', ['example-timeline']],
    ['Your folders', ['logs']],
  ])
  expect(groupWorkspaces(ROWS.filter((r) => r.kind !== 'example')).map((g) => g.title)).toEqual(['Demo', 'Your folders'])
  expect(groupWorkspaces([])).toEqual([])
})

test('a row opens its workspace, a demo or an example at its view, and carries no sign-in code, which works once', async () => {
  expect(workspaceHref(ROWS[0])).toBe('/?ws=demo-collusion-wiki&ref=view%3Awiki-page-history')
  expect(workspaceHref(ROWS[1])).toBe('/?ws=demo-mythos-5') // no view: Files
  expect(workspaceHref(ROWS[2])).toBe('/?ws=example-timeline&ref=view%3Atimeline')
  expect(workspaceHref(ROWS[3], '/')).toBe('/?ws=logs')
  // a start page opened from a link with a code (`thimble up`, `thimble demo`)
  window.history.replaceState(null, '', '/#p=abc')
  const el = await mount(<App />)
  await settle()
  expect([...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')].map((a) => a.getAttribute('href'))).toEqual([
    '/?ws=demo-collusion-wiki&ref=view%3Awiki-page-history',
    '/?ws=demo-mythos-5',
    '/?ws=example-timeline&ref=view%3Atimeline',
    '/?ws=logs',
  ])
})

test('a URL naming a workspace renamed since goes to its new name, and the workspace\'s browser state goes with it', async () => {
  window.history.replaceState(null, '', '/?ws=collusion-wiki-2&ref=card%3Ac1')
  window.localStorage.setItem(storageKey('collusion-wiki-2', 'kept-note'), JSON.stringify({ panes: 2 }))
  window.localStorage.setItem(storageKey('collusion-wiki-2-x', 'kept-note'), JSON.stringify({ panes: 3 }))
  const el = await mount(<App />)
  await settle()
  await settle()
  expect(window.location.search).toBe('?ws=demo-collusion-wiki&ref=card%3Ac1')
  expect(window.localStorage.getItem(storageKey('demo-collusion-wiki', 'kept-note'))).toBe(JSON.stringify({ panes: 2 }))
  expect(window.localStorage.getItem(storageKey('collusion-wiki-2', 'kept-note'))).toBeNull()
  expect(window.localStorage.getItem(storageKey('collusion-wiki-2-x', 'kept-note'))).toBe(JSON.stringify({ panes: 3 })) // another workspace's
  expect(el.querySelector('.start-missing')).toBeNull()
  window.localStorage.clear()
})

test('a URL naming a workspace the server does not hold is the start page, saying so in one line', async () => {
  window.history.replaceState(null, '', '/?ws=gone-folder')
  const el = await mount(<App />)
  await settle()
  await settle()
  expect(el.querySelector('.start-missing')?.textContent).toContain('gone-folder')
  expect(el.querySelectorAll('a.ws-row').length).toBe(4)
})
