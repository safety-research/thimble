// @vitest-environment jsdom
// Where the orientation finished, in main (src/chat/AgentCard.tsx OrientLanding): since 0.8.0 the orientation writes no
// report, so a report the analyst asked for later is theirs and the landing does not count it; a writer of the report
// pass of an orientation from before 0.8.0 (its meta's `orient` names the orientation) still counts as its draft report.
// Every writer started since 0.8.0 carries `orient` (null when the analyst asked for it: backend write_session.start),
// so only an older meta with no `orient` at all is told by when it ran.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { OrientLanding } from '../../src/chat/AgentCard.tsx'
import { orientWriters } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const ORIENT = { id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-10-14T10:00:00Z', ts_end: '2026-10-14T10:20:00Z', parent: 'main', status: 'done' } as unknown as ChatMeta
const writer = (orient: string | null) => ({ id: 'w1', kind: 'agent', role: 'writer', title: 'Write report', doc: 'report', created_at: '2026-10-14T10:20:30Z', ts_end: '2026-10-14T10:30:00Z', parent: 'main', status: 'done', orient, orient_run: 0 }) as unknown as ChatMeta

let read: string[] = []
beforeEach(() => {
  read = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    read.push(u)
    // a report generated after the orientation began, which the landing used to claim
    const body = u.endsWith('/chats/o1') ? { meta: ORIENT, events: [] } : u.includes('/frame') ? { generated_at: '2026-10-14T10:31:00Z' } : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const landing = async (metas: ChatMeta[]) => {
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map(), metas: new Map(metas.map((m) => [m.id, m])) }}>
      <OrientLanding ws="mini" chat="o1" />
    </ThreadsContext.Provider>,
  )
  await settle()
  await settle()
  return el.querySelector('.chat-landing-line')?.textContent ?? ''
}

test("a report the analyst asked for after the orientation ended is not the orientation's", async () => {
  const line = await landing([ORIENT, writer(null)])
  expect(line).toBe('Orientation has finished.')
  expect(read.some((u) => u.includes('/frame'))).toBe(false)
})

test("the report pass of an orientation from before 0.8.0 is still its draft report", async () => {
  expect(await landing([ORIENT, writer('o1')])).toBe('Orientation has finished. thimble has a draft report for you to review.')
})

test('a writer whose meta says `orient: null` is never the report pass, however soon after the orientation it ran', () => {
  const { orient: _o, orient_run: _r, ...old } = writer(null) as unknown as Record<string, unknown>
  expect(orientWriters([ORIENT, writer(null)])).toEqual([])
  expect(orientWriters([ORIENT, writer('o1')]).map((w) => [w.chat, w.orient, !!w.inferred])).toEqual([['w1', 'o1', false]])
  // a meta from before writers carried `orient`, started within ORIENT_WRITER_GAP_MS of the orientation's end
  expect(orientWriters([ORIENT, old as unknown as ChatMeta]).map((w) => [w.chat, w.orient, !!w.inferred])).toEqual([['w1', 'o1', true]])
})
