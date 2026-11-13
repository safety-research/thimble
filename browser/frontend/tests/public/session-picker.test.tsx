// @vitest-environment jsdom
// A folder's session picker (src/shell/SessionPicker.tsx), which thimble-browser opens in a folder that has sessions
// (`?pick=<c>`) and the top bar's switcher shows for a folder: New session first, then the folder's sessions with
// their turns, cards and first message, those open now marked, the one this tab shows as such; a choice asks the
// server to open it (POST /ws/{c}/sessions/open). The switcher and the start page list a folder once, whatever number
// of its sessions are open (folderRows).
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import App from '../../src/App.tsx'
import { openBody, sessionWhen, SessionPicker } from '../../src/shell/SessionPicker.tsx'
import { folderRows } from '../../src/lib/workspace.ts'
import type { FolderSessions, WorkspaceRow } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const NOW = Date.now() / 1000
const SESSIONS: FolderSessions = {
  folder: 'logs',
  label: 'logs',
  path: '/home/t/data/logs',
  sessions: [
    { at: NOW - 30, first: 'Which service failed first?', turns: 3, cards: 2, slot: 'logs', archive: null, open: true },
    { at: NOW - 7200, first: '', turns: 0, cards: 1, slot: 'logs.2', archive: null, open: false },
    { at: NOW - 3 * 86400, first: 'Count the timeouts', turns: 5, cards: 4, slot: 'logs', archive: 'logs-2026-11-10-090000', open: false },
  ],
}
const posted: { url: string; body: unknown }[] = []

beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/ws/logs/sessions') return json(SESSIONS)
    if (url === '/api/ws/logs/sessions/open') {
      posted.push({ url, body: JSON.parse(String(init?.body)) })
      return json({ name: 'logs.3', open: false })
    }
    if (url === '/api/corpora') return json([{ name: 'logs', manifest: {}, path: '/home/t/data/logs' }])
    if (url === '/api/workspaces') return json([{ name: 'logs', kind: 'folder', label: 'logs', folder: 'logs', path: '/home/t/data/logs', of: 'logs' }])
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('a launch in a folder with sessions opens on its picker: New session first, then each session, the open ones marked', async () => {
  window.history.replaceState(null, '', '/?pick=logs')
  const el = await mount(<App />)
  await settle()
  const rows = [...el.querySelectorAll<HTMLButtonElement>('.session-row')]
  expect(rows.map((b) => b.dataset.session)).toEqual(['new', 'logs', 'logs.2', 'logs-2026-11-10-090000'])
  expect(rows[0].textContent).toContain('New session')
  expect(rows[1].textContent).toContain('Which service failed first?')
  expect(rows[1].textContent).toContain('3 turns · 2 cards')
  expect(rows[1].querySelector('.session-open')?.textContent).toBe('Open now')
  expect(rows[2].querySelector('.session-open')).toBeNull()
  expect(rows[2].textContent).toContain('No message yet')
  await act(async () => rows[0].click())
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/logs/sessions/open', body: { new: true } }])
})

test('a picker link for a workspace this server does not hold is the start page: it says so and lists the folders', async () => {
  window.history.replaceState(null, '', '/?pick=gone')
  const el = await mount(<App />)
  await settle()
  expect(el.querySelector('.start-missing')?.textContent).toBe('No workspace “gone” on this server.')
  expect([...el.querySelectorAll<HTMLAnchorElement>('a.ws-row')].map((a) => a.getAttribute('href'))).toEqual(['/?pick=logs'])
})

test('in the switcher the row of the session this tab shows says so, and a past session is opened by its archive', async () => {
  const el = await mount(<SessionPicker ws="logs" current="logs" compact />)
  await settle()
  expect(el.querySelector('.session-row.current .session-open')?.textContent).toBe('This tab')
  const past = el.querySelector<HTMLButtonElement>('[data-session="logs-2026-11-10-090000"]')!
  await act(async () => past.click())
  await settle()
  expect(posted.map((p) => p.body)).toEqual([{ archive: 'logs-2026-11-10-090000' }])
  expect(openBody(SESSIONS.sessions[1])).toEqual({ slot: 'logs.2' })
  expect(sessionWhen(NOW - 30, NOW)).toBe('just now')
  expect(sessionWhen(NOW - 7200, NOW)).toBe('2 hours ago')
})

test('a folder with two sessions open is one row, named by its own workspace', () => {
  const rows: WorkspaceRow[] = [
    { name: 'logs', kind: 'folder', label: 'logs · session 1', folder: 'logs', path: '/d/logs', of: 'logs', session: 1 },
    { name: 'logs.2', kind: 'folder', label: 'logs · session 2', folder: 'logs', path: '/d/logs', of: 'logs', session: 2 },
    { name: 'runs', kind: 'folder', label: 'runs', folder: 'runs', path: '/d/runs', of: 'runs' },
  ]
  expect(folderRows(rows).map(({ row, names }) => [row.name, row.label, names])).toEqual([
    ['logs', 'logs', ['logs', 'logs.2']],
    ['runs', 'runs', ['runs']],
  ])
})
