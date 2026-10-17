// @vitest-environment jsdom
// What else the browser says about thimble's agents as subagents of main: the line on the session-gone card naming the
// agents main's quit stopped (src/shell/SessionGone.tsx), and in a thread, where each message came from, a follow-up not
// passed on with Send again, and the line when a typed follow-up ran on the role's current values (src/chat/Rows.tsx).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChipRow, notPassedOn } from '../../src/chat/Rows.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { stoppedAgentsLine } from '../../src/shell/SessionGone.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let posted: [string, unknown][] = []
beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body))])
    return new Response(JSON.stringify({ status: 'sent' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('the session-gone card', () => {
  const agent = (role: string, session: string, ts_end: string): ChatMeta =>
    ({ id: role, kind: 'agent', role, title: role, created_at: '', parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, route: 'subagent', status: 'stopped', stopped_by: 'quit', session, sessions: [session], ts_end }) as ChatMeta

  // bug hunt 7, H17: an orientation an earlier quit had stopped was named again when a later session ended
  test('names only the agents that stopped with the session that ended, not those an earlier quit stopped', () => {
    const metas = [agent('orient', 'sess-early', '2026-10-17T16:51:14Z'), agent('writer', 'sess-late', '2026-10-17T17:19:38Z')]
    const ended = { session: 'sess-late', cwd: '/data/wiki', at: '2026-10-17T17:19:38Z', since: '2026-10-17T17:16:24Z' }
    expect(stoppedAgentsLine(metas, ended)).toBe("thimble's agents stopped with it: a writer.")
    // an end that does not say when its session was attached: the agents that ran in it
    expect(stoppedAgentsLine(metas, { ...ended, since: undefined })).toBe("thimble's agents stopped with it: a writer.")
    // the same session id continued and quit again (`claude -c`): only what stopped after it was attached again
    const again = [agent('orient', 'sess-late', '2026-10-17T16:51:14Z'), agent('writer', 'sess-late', '2026-10-17T17:19:38Z')]
    expect(stoppedAgentsLine(again, ended)).toBe("thimble's agents stopped with it: a writer.")
    expect(stoppedAgentsLine([metas[0]], ended)).toBe('')
  })
})

describe('in a thread', () => {

  test('a follow-up not passed on shows why and the message, and Send again sends it to the orientation', async () => {
    const el = await mount(<ChipRow ws="mini" item={{ kind: 'chip', index: 3, chip: 'not_passed_on', text: "thimble's module did not answer.", message: 'Does April look the same?' }} />)
    expect(el.textContent).toContain(notPassedOn("thimble's module did not answer."))
    expect(el.querySelector('.chat-not-passed-text')?.textContent).toBe('Does April look the same?')
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-send-again')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/orientation/message', { text: 'Does April look the same?' }]])
  })
})
