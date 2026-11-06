// @vitest-environment jsdom
// thimble's start page (src/shell/StartPage.tsx): a URL with no workspace shows the server's workspaces (GET
// /workspaces), each row a link to its workspace, named by the server's label, else the folder's name.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../../src/App.tsx'
import type { CorpusInfo, WorkspaceRow } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const ROWS: WorkspaceRow[] = [
  { name: 'logs', kind: 'folder', label: 'logs', folder: 'logs', path: '/home/ana/data/logs' },
  // a row from a server that sends no label: the folder's name all the same
  { name: 'runs-2', kind: 'folder', folder: 'runs', path: '/home/ana/data/runs' },
]

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/workspaces') return json(ROWS)
    if (url === '/api/corpora') return json(ROWS.map((r) => ({ name: r.name, manifest: {}, path: r.path })) satisfies CorpusInfo[])
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('a URL with no workspace is the start page: a row per workspace, each a link to it', async () => {
  const el = await mount(<App />)
  await settle()
  const rows = [...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')]
  expect(rows.map((a) => a.getAttribute('href'))).toEqual(['/?ws=logs', '/?ws=runs-2'])
  expect(rows.map((a) => a.querySelector('.ws-row-name')?.textContent)).toEqual(['logs', 'runs'])
})
