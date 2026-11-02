// @vitest-environment jsdom
// The ask before a request to a host the analyst has not allowed (src/chat/HostAsk.tsx, backend host_asks.py): under
// the command that waits, what Claude said the command does, the host, the command (a tool other than Bash: its URL)
// and the three choices, and nothing else, each choice sent to the server; a chat whose meta carries one waits for the
// analyst (src/chat/waiting.ts), which the thread tree and the folded chat column's dot show.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { HOST_CHOICES, HostAsks } from '../../src/chat/HostAsk.tsx'
import { hostAsks, waitingAt, waitingChats } from '../../src/chat/waiting.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const ASK = { id: 'h1', host: 'data.example-lab.test', since: '2026-11-02T10:00:00Z' }
const CURL = 'curl -sS -m 30 -o "$TMPDIR/runs.json" https://data.example-lab.test/api/runs'
const CHOICE_WORDS = HOST_CHOICES.map((c) => c.words).join('')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meta = (id: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({ id, kind: 'main', role: 'main', title: '', created_at: '2026-11-02T09:00:00Z', parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, ...extra })
/** The words of each line of an ask's card, top to bottom. */
const lines = (row: Element) => [...row.children].map((c) => c.textContent)

test('the ask names the host and offers Allow once, Always allow and Deny, with no other words', async () => {
  const el = await mount(<HostAsks ws="mini" asks={[ASK]} />)
  const row = el.querySelector('.chat-host-ask')!
  expect(row.getAttribute('data-host')).toBe('data.example-lab.test')
  expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Allow once', 'Always allow', 'Deny'])
  expect(row.textContent).toBe(`data.example-lab.test${CHOICE_WORDS}`)
  expect((await mount(<HostAsks ws="mini" asks={[]} />)).textContent).toBe('')
})

test('the ask says first what Claude said its command does, then the host, then the command', async () => {
  const call = { tool: 'Bash', input: { command: CURL, description: "Fetch the runs from the lab's API" } }
  const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, call }]} />)
  expect(lines(el.querySelector('.chat-host-ask')!)).toEqual(["Fetch the runs from the lab's API", 'data.example-lab.test', CURL, CHOICE_WORDS])
})

test('a command with no description shows the command alone', async () => {
  const call = { tool: 'Bash', input: { command: CURL } }
  const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, call }]} />)
  const row = el.querySelector('.chat-host-ask')!
  expect(row.querySelector('.chat-host-ask-what')).toBeNull()
  expect(lines(row)).toEqual(['data.example-lab.test', CURL, CHOICE_WORDS])
})

test('a request of a tool other than Bash shows its URL in place of the command', async () => {
  const call = { tool: 'WebFetch', input: { url: 'https://data.example-lab.test/api/runs', prompt: 'List the runs' } }
  const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, call }]} />)
  expect(lines(el.querySelector('.chat-host-ask')!)).toEqual(['data.example-lab.test', 'https://data.example-lab.test/api/runs', CHOICE_WORDS])
})

test('a long command shows on one line as its step line does, and whole once clicked', async () => {
  const script = "python3 - <<'EOF'\nimport json, urllib.request\nruns = json.load(urllib.request.urlopen('https://data.example-lab.test/api/runs'))\nprint(len(runs))\nEOF"
  const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, call: { tool: 'Bash', input: { command: script, description: 'Count the runs' } } }]} />)
  const cmd = el.querySelector<HTMLButtonElement>('.chat-host-ask-call')!
  const line = cmd.textContent!
  expect(line).toMatch(/^python3 - <<'EOF' import json, urllib\.request runs = .*…$/)
  expect(line.length).toBeLessThanOrEqual(110)
  expect(cmd.getAttribute('aria-expanded')).toBe('false')
  await act(async () => cmd.click())
  expect([cmd.textContent, cmd.getAttribute('aria-expanded')]).toEqual([script, 'true'])
  await act(async () => cmd.click())
  expect(cmd.textContent).toBe(line)
})

test('each choice goes to the server for its ask, and a failed answer can be given again', async () => {
  const sent: { url: string; body: unknown }[] = []
  let status = 200
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return json({})
    sent.push({ url, body: JSON.parse(String(init.body)) })
    return status === 200 ? json({ ok: true }) : json({ detail: 'the server is down' }, status)
  })
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  for (const choice of ['once', 'always', 'deny'] as const) {
    const el = await mount(<HostAsks ws="mini" asks={[{ ...ASK, id: `h-${choice}` }]} />)
    await act(async () => el.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click())
    await settle()
    expect(sent.at(-1)?.url).toMatch(new RegExp(`/ws/mini/host-asks/h-${choice}$`))
    expect(sent.at(-1)?.body).toEqual({ choice })
    // sent: every choice holds until the chat's next read takes the row away
    expect([...el.querySelectorAll('button')].every((b) => b.disabled)).toBe(true)
  }
  status = 500
  const el = await mount(<HostAsks ws="mini" asks={[ASK]} />)
  await act(async () => el.querySelector<HTMLButtonElement>('[data-choice="once"]')!.click())
  await settle()
  expect(toasts.at(-1)).toMatch(/^Could not answer/)
  expect([...el.querySelectorAll('button')].some((b) => b.disabled)).toBe(false)
  off()
})

test('a chat waits for the analyst while it holds an ask about a host', () => {
  const asking = meta('main', { running: true, hosts: [ASK] })
  expect(hostAsks(asking)).toEqual([ASK])
  expect(hostAsks({ ...asking, hosts: [] })).toEqual([])
  const agent = meta('w1', { kind: 'agent', role: 'writer', parent: 'main', status: 'running', hosts: [{ ...ASK, id: 'h2', since: '2026-11-02T10:05:00Z' }] })
  expect(waitingChats([meta('t1', { kind: 'thread', running: true }), agent, asking]).map((m) => m.id)).toEqual(['main', 'w1'])
  expect(waitingAt('w1', [asking, agent])?.id).toBe('w1')
  expect(waitingChats([{ ...agent, hosts: undefined }])).toEqual([])
})
