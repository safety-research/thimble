// @vitest-environment jsdom
// A start of one of thimble's agents that did not happen (src/chat/Refused.tsx, src/chat/OrientStart.tsx): the card
// says why by kind, in the words of whoever refused, shows the request in full before Start it, and offers the kind's
// buttons; Start it and Try again are clicks of their own routes; there is no Allow it anywhere. Main's chat says
// Starting… only after a click has gone a second unanswered, or while main makes a typed start.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { STARTING_AFTER_MS, shownRefusal, startingShown } from '../../src/chat/OrientStart.tsx'
import { NO_ANSWER_LINE, PERMISSIONS_LINE, RefusedCard, WAIT_SLOT_LINE, limitOf, refusalActions, refusalLine, requestLine, slotFree } from '../../src/chat/Refused.tsx'
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
  test('each kind says why in the words of whoever refused', () => {
    expect(refusalLine({ kind: 'auto-mode', reason: '[Auto-Mode Bypass]' })).toBe("Claude Code's auto mode refused main's call to start it: [Auto-Mode Bypass].")
    expect(refusalLine({ kind: 'no-call', reason: 'Auto mode told me not to pursue that.\nSo I stopped.\nThird line.' })).toBe('Your Claude Code session did not start it. It said: Auto mode told me not to pursue that. So I stopped.')
    expect(refusalLine({ kind: 'limit', reason: 'Maximum of 20 concurrent subagents reached' })).toMatch(/^Claude Code runs at most 20 subagents at once in this session/)
    expect(refusalLine({ kind: 'no-module', reason: '', expired: true })).toBe(NO_ANSWER_LINE)
    expect(refusalLine({ kind: 'hook', reason: 'An orientation is already running.' })).toBe('An orientation is already running.')
    expect(refusalLine({ kind: 'not-launched', reason: 'This session was not started with `thimble`' })).toBe('This session was not started with `thimble`.')
  })

  test('Start it and Edit request for auto mode and a call main did not make, Try again at the limit and for an unanswered click, Dismiss always', () => {
    expect(refusalActions('auto-mode')).toEqual(['start-it', 'edit', 'dismiss'])
    expect(refusalActions('no-call')).toEqual(['start-it', 'edit', 'dismiss'])
    expect(refusalActions('limit')).toEqual(['try-again', 'dismiss'])
    expect(refusalActions('no-module', true)).toEqual(['try-again', 'dismiss'])
    for (const k of ['no-module', 'not-launched', 'hook', 'earlier-session', 'error']) expect(refusalActions(k)).toEqual(['dismiss'])
  })

  test("the request's line names its type, model and effort", () => {
    expect(requestLine({ role: 'writer', input: null, values: { model: 'claude-opus-5-5', effort: 'high' } })).toBe('thimble:writer · Opus 5.5 · high')
  })
})

describe('the card', () => {
  test('an auto-mode refusal shows the request in full, the /permissions line, and Start it posts start-it', async () => {
    const started: unknown[] = []
    const el = await mount(<RefusedCard ws="mini" what="the orientation" refusal={{ kind: 'auto-mode', reason: '[Credential Exploration]', request: 'r1' }} text="moderators" onDismiss={() => {}} onEdit={() => {}} onStarted={(a) => started.push(a)} />)
    await settle()
    expect(el.querySelector('.chat-refused-title')?.textContent).toBe("The orientation didn't start")
    expect(el.textContent).toContain(PERMISSIONS_LINE)
    expect(el.querySelector('.chat-refused-line')?.textContent).toBe('thimble:orientation · Opus 5.5 · max')
    expect(el.querySelector('.chat-refused-prompt')?.textContent).toContain('Orient on the moderators.')
    expect(buttons(el)).toEqual(['Start it', 'Edit request', 'Dismiss'])
    expect(el.textContent).not.toMatch(/Allow it/)
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-refused-start')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/subagents/start-it', { request: 'r1' }]])
    expect(started).toEqual([{ agentId: 'a7', request: 'r1' }])
  })

  test("at Claude Code's limit Try again posts again; a hook refusal offers only Dismiss", async () => {
    const el = await mount(<RefusedCard ws="mini" what="the report's writer" refusal={{ kind: 'limit', reason: '20 concurrent subagents', request: 'r1' }} onDismiss={() => {}} />)
    await settle()
    expect(buttons(el)).toEqual(['Try again', 'Dismiss'])
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-refused-again')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/subagents/again', { request: 'r1' }]])
    const hook = await mount(<RefusedCard ws="mini" what="the orientation" refusal={{ kind: 'hook', reason: 'Your Claude Code session is in plan mode.', request: null }} onDismiss={() => {}} onEdit={() => {}} />)
    expect(buttons(hook)).toEqual(['Dismiss'])
  })
})

describe("Try again at Claude Code's limit waits for a free slot (live check L19)", () => {
  const agent = (status: 'running' | 'done', ts_end: string | null = null) => ({ kind: 'agent' as const, status, ts_end })

  test('the cap is read from either text; a slot is free when fewer run, or, with no cap named, once one ended', () => {
    expect(limitOf('Concurrent subagent limit reached. You can run 2 subagents at once.')).toBe(2)
    expect(limitOf('thimble: $.agent.spawn refused: 2 spawns are running at once')).toBe(2)
    expect(limitOf('Claude Code runs at most 20 concurrent subagents')).toBe(20)
    expect(limitOf('the limit')).toBeNull()
    expect(slotFree([agent('running'), agent('running')], 'You can run 2 subagents at once.', null)).toBe(false)
    expect(slotFree([agent('running'), agent('done', '2026-10-06T10:00:00Z')], 'You can run 2 subagents at once.', null)).toBe(true)
    expect(slotFree([agent('done', '2026-10-06T09:00:00Z')], 'the limit', '2026-10-06T09:30:00Z')).toBe(false)
    expect(slotFree([agent('done', '2026-10-06T10:00:00Z')], 'the limit', '2026-10-06T09:30:00Z')).toBe(true)
  })

  test('the button stays off, saying why, while as many subagents run as the cap', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = String(url).endsWith('/chats') ? [{ id: 'o', kind: 'agent', status: 'running' }, { id: 'w', kind: 'agent', status: 'running' }] : { id: 'r1', kind: 'start', state: 'refused' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const el = await mount(<RefusedCard ws="mini" what="the report's writer" refusal={{ kind: 'limit', reason: 'You can run 2 subagents at once.', request: 'r1' }} onDismiss={() => {}} />)
    await settle()
    const again = el.querySelector<HTMLButtonElement>('.chat-refused-again')!
    expect(again.disabled).toBe(true)
    expect(again.getAttribute('title')).toBe(WAIT_SLOT_LINE)
  })
})

describe("main's chat before the orientation's thread exists", () => {
  test('Starting… shows only after a click has gone a second unanswered, or while a typed start is pending', () => {
    expect(startingShown(null, 1000, 1000 + STARTING_AFTER_MS - 1)).toBe(false)
    expect(startingShown(null, 1000, 1000 + STARTING_AFTER_MS)).toBe(true)
    expect(startingShown({ status: 'starting', started_by: 'typed' }, null, 0)).toBe(true)
    expect(startingShown({ status: 'running' }, null, 0)).toBe(false)
  })

  test("the refusal is the record's, else the click's answer, and none once dismissed", () => {
    const run = { status: 'refused', request: 'r1', refused: { kind: 'no-module', reason: 'off', at: 't' } }
    expect(shownRefusal(run, null, [])).toEqual({ kind: 'no-module', reason: 'off', at: 't', request: 'r1' })
    expect(shownRefusal(run, null, ['r1'])).toBeNull()
    expect(shownRefusal({ status: 'starting' }, { kind: 'hook', reason: 'An orientation is already running.', request: 'r2' }, [])).toEqual({ kind: 'hook', reason: 'An orientation is already running.', request: 'r2', expired: undefined })
    expect(shownRefusal({ status: 'starting' }, { agentId: 'a1' }, [])).toBeNull()
  })
})

describe("a click start's answer", () => {
  test('a refusal the route answers raw gets its kind and reason from the key that carries it', async () => {
    const { startAnswer } = await import('../../src/lib/api.ts')
    expect(startAnswer({ 'no-module': "Claude Code did not load thimble's hooks module", request: 'r1' })).toMatchObject({ kind: 'no-module', reason: "Claude Code did not load thimble's hooks module" })
    expect(startAnswer({ deny: 'An orientation is already running.' })).toMatchObject({ kind: 'hook', reason: 'An orientation is already running.' })
    expect(startAnswer({ limit: '20 concurrent subagents' })).toMatchObject({ kind: 'limit' })
    expect(startAnswer({ error: 'No transcript found', gone: true })).toMatchObject({ kind: 'earlier-session' })
    expect(startAnswer({ agentId: 'a1', request: 'r1' })).toEqual({ agentId: 'a1', request: 'r1' })
    expect(startAnswer({ kind: 'auto-mode', reason: 'x' })).toEqual({ kind: 'auto-mode', reason: 'x' })
  })
})
