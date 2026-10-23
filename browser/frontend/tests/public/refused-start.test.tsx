// @vitest-environment jsdom
// A start of one of thimble's agents that did not happen (src/chat/Refused.tsx): the card offers the kind's buttons
// (Start it, Try again, Dismiss), and an auto-mode refusal shows the request in full before Start it, a click of its
// own route.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PERMISSIONS_LINE, RefusedCard, refusalActions} from '../../src/chat/Refused.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let posted: [string, unknown][] = []
beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push([String(url), JSON.parse(String(init.body))])
      return new Response(JSON.stringify({ agentId: 'a7', request: 'r1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const request = { id: 'r1', kind: 'start', route: 'typed', role: 'orientation', input: { subagent_type: 'thimble:orientation', description: 'orientation: moderators', prompt: '[thimble request r1]\nOrient on the moderators.' }, values: { model: 'claude-opus-5-5[1m]', effort: 'max' }, state: 'refused' }
    return new Response(JSON.stringify(request), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const buttons = (el: HTMLElement) => [...el.querySelectorAll('.chat-refused-acts button')].map((b) => b.textContent)

describe('the reason and the buttons, by kind', () => {

  test('Start it for auto mode and a call main did not make, Try again at the limit and for an unanswered click, Dismiss always', () => {
    expect(refusalActions('auto-mode')).toEqual(['start-it', 'dismiss'])
    expect(refusalActions('no-call')).toEqual(['start-it', 'dismiss'])
    expect(refusalActions('limit')).toEqual(['try-again', 'dismiss'])
    expect(refusalActions('no-module', true)).toEqual(['try-again', 'dismiss'])
    for (const k of ['no-module', 'not-launched', 'hook', 'earlier-session', 'error']) expect(refusalActions(k)).toEqual(['dismiss'])
  })

})

describe('the card', () => {
  test('an auto-mode refusal shows the request in full, the /permissions line, and Start it posts start-it', async () => {
    const started: unknown[] = []
    const el = await mount(<RefusedCard ws="mini" what="the orientation" refusal={{ kind: 'auto-mode', reason: '[Credential Exploration]', request: 'r1' }} text="moderators" onDismiss={() => {}} onStarted={(a) => started.push(a)} />)
    await settle()
    expect(el.querySelector('.chat-refused-title')?.textContent).toBe("The orientation didn't start")
    expect(el.textContent).toContain(PERMISSIONS_LINE)
    expect(el.querySelector('.chat-refused-line')?.textContent).toBe('thimble:orientation · Opus 5.5 · max')
    expect(el.querySelector('.chat-refused-prompt')?.textContent).toContain('Orient on the moderators.')
    expect(buttons(el)).toEqual(['Start it', 'Dismiss'])
    expect(el.textContent).not.toMatch(/Allow it/)
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-refused-start')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/subagents/start-it', { request: 'r1' }]])
    expect(started).toEqual([{ agentId: 'a7', request: 'r1' }])
  })

})

