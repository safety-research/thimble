// @vitest-environment jsdom
// Hand back to main under a finished side thread (src/chat/HandBack.tsx): offered while the thread's meta says `offer`,
// a press posts the hand-back (backend threads.hand_back, which sends main the answer as the analyst's message), and the
// line then says it was handed back, with no button; nothing while the thread runs or has no answer.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HANDED_BACK, HAND_BACK, HandBack } from '../../src/chat/HandBack.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

function stubFetch(status = 200): string[] {
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${url}`)
    const body = status === 200 ? { thread: 't1', event: 'e1', text: 'From thread "Why?": Because.', hand_back: 'handed' } : { detail: 'this answer was handed back to main already' }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

const button = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === HAND_BACK)

describe('Hand back to main', () => {
  test('a finished answer offers it; a press posts the hand-back once and the line says it was handed back', async () => {
    const sent = stubFetch()
    const reload = vi.fn(async () => undefined)
    const el = await mount(<HandBack ws="mini" id="t1" state="offer" onDone={reload} />)
    const b = button(el)
    expect(b).toBeDefined()
    expect(b!.disabled).toBe(false)
    expect(el.querySelector('.chat-hand-back')?.getAttribute('data-state')).toBe('offer')
    await act(async () => b!.click())
    await settle()
    expect(sent.filter((x) => !x.startsWith('GET') && !x.includes('/telemetry'))).toEqual(['POST /api/ws/mini/chats/t1/hand-back'])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(button(el)).toBeUndefined()
    expect(el.textContent).toContain(HANDED_BACK)
    expect(el.querySelector('.chat-hand-back')?.getAttribute('data-state')).toBe('handed')
  })

  test('an answer handed back says so with no button; a thread that runs or has no answer shows nothing', async () => {
    stubFetch()
    const handed = await mount(<HandBack ws="mini" id="t1" state="handed" />)
    expect(button(handed)).toBeUndefined()
    expect(handed.textContent).toBe(HANDED_BACK)
    const none = await mount(<HandBack ws="mini" id="t2" state="" />)
    expect(none.innerHTML).toBe('')
    const unknown = await mount(<HandBack ws="mini" id="t3" state={undefined} />)
    expect(unknown.innerHTML).toBe('')
  })

  test('with no session attached the button is disabled; a refusal keeps it offered', async () => {
    stubFetch()
    const off = await mount(<HandBack ws="mini" id="t1" state="offer" detached />)
    expect(button(off)!.disabled).toBe(true)
    unmountAll()
    const sent = stubFetch(409)
    const el = await mount(<HandBack ws="mini" id="t1" state="offer" />)
    await act(async () => button(el)!.click())
    await settle()
    expect(sent.some((x) => x === 'POST /api/ws/mini/chats/t1/hand-back')).toBe(true)
    expect(button(el)).toBeDefined()
    expect(el.textContent).not.toContain(HANDED_BACK)
  })

  test('a later answer the meta offers again shows the button again', async () => {
    stubFetch()
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<HandBack ws="mini" id="t1" state="offer" />))
    await act(async () => button(host)!.click())
    await settle()
    expect(host.textContent).toContain(HANDED_BACK)
    await act(async () => root.render(<HandBack ws="mini" id="t1" state="handed" />))
    expect(host.textContent).toContain(HANDED_BACK)
    await act(async () => root.render(<HandBack ws="mini" id="t1" state="offer" />))
    expect(button(host)).toBeDefined()
    act(() => root.unmount())
  })
})
