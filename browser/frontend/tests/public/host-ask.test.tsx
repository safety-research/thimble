// @vitest-environment jsdom
// The ask before a request to a host the analyst has not allowed (src/chat/HostAsk.tsx, backend host_asks.py): under
// the command that waits, what Claude said the command does, the host, the command and the three choices, each sent to
// the server for its ask.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { HostAsks } from '../../src/chat/HostAsk.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const CURL = 'curl -sS -m 30 -o "$TMPDIR/runs.json" https://data.example-lab.test/api/runs'
const ASK = { id: 'h1', host: 'data.example-lab.test', since: '2026-11-02T10:00:00Z', call: { tool: 'Bash', input: { command: CURL, description: "Fetch the runs from the lab's API" } } }

test('the ask says what the command does, its host and the command, and each choice goes to the server for its ask', async () => {
  const sent: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') sent.push({ url, body: JSON.parse(String(init.body)) })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  for (const choice of ['once', 'always', 'deny'] as const) {
    const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, id: `h-${choice}` }]} />)
    const row = el.querySelector('.chat-host-ask')!
    expect([...row.children].slice(0, 3).map((c) => c.textContent)).toEqual(["Fetch the runs from the lab's API", 'data.example-lab.test', CURL])
    expect([...row.querySelectorAll('[data-choice]')].map((b) => b.textContent)).toEqual(['Allow once', 'Always allow', 'Deny'])
    await act(async () => el.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click())
    await settle()
    expect(sent.at(-1)).toEqual({ url: `/api/ws/mini/host-asks/h-${choice}`, body: { choice } })
    unmountAll()
  }
})
