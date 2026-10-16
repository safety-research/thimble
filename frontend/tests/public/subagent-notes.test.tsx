// @vitest-environment jsdom
// What else the browser says about thimble's agents as subagents of main: the line on the session-gone card naming the
// agents main's quit stopped (src/shell/SessionGone.tsx), and in a thread, where each message came from, a follow-up not
// passed on with Send again, and the line when a typed follow-up ran on the role's current values (src/chat/Rows.tsx).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChipRow, notPassedOn } from '../../src/chat/Rows.tsx'
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
