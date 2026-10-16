// The refs the terminal opens the page at (src/lib/teleport.ts pageRef; `thimble open --ref`, contract C12) that name
// no element: home opens nothing more, checks the report (its Checks pane), files:<folder> the File browser at the
// folder, ticket:<id> the thread that ran the ticket, answer:<turn>#s<n> main's chat at the passage. Element refs still
// go to the surface that owns them.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { teleport } from '../../src/lib/teleport.ts'

let heard: [string, unknown][] = []
let offs: (() => void)[] = []
beforeEach(() => {
  heard = []
  offs = (['showTab', 'openRef', 'openChat'] as const).map((name) => bus.on(name, (e) => heard.push([name, e])))
  vi.stubGlobal('fetch', async (url: unknown) =>
    new Response(JSON.stringify(String(url).endsWith('/dev/tickets/t7') ? { id: 't7', n: 7, status: 'done', chat: 'dev-7' } : {}), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  offs.forEach((off) => off())
  vi.unstubAllGlobals()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

test('home, checks and files refs', () => {
  teleport('home')
  expect(heard).toEqual([])
  teleport('checks')
  expect(heard).toEqual([['showTab', { tab: 'report' }]])
  heard = []
  teleport('files:agents/2026')
  expect(heard).toEqual([['showTab', { tab: 'files' }], ['openRef', { ref: 'agents/2026/', browser: true }]])
  heard = []
  teleport('files:')
  teleport('files:.')
  expect(heard).toEqual([['showTab', { tab: 'files' }], ['showTab', { tab: 'files' }]])
})

test("a ticket opens the thread that ran it, and an answer's passage main's chat", async () => {
  teleport('ticket:t7')
  await tick()
  await tick()
  expect(heard).toEqual([['openChat', { chatId: 'dev-7' }]])
  heard = []
  teleport('answer:5e55a000-0000-4000-8000-00000000a001#s2')
  expect(heard).toEqual([['openChat', { chatId: 'main' }], ['openRef', { ref: 'answer:5e55a000-0000-4000-8000-00000000a001#s2' }]])
})
