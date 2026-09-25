// @vitest-environment jsdom
// The browser's usage record (src/lib/telemetry.ts).
// The server keeps telemetry as a closed vocabulary and refuses a batch with a kind it does not know
// (backend/app/telemetry.py KINDS), so every kind the page sends must be one of those. A message the analyst types is
// recorded as its length, never its text, and a click is named by a control's short label, never by text on the page.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { CLIENT_KINDS, classifyRequest, labelOf } from '../../src/lib/telemetry.ts'

const SECRET = 'the analyst typed this private sentence'

/** The kinds backend/app/telemetry.py accepts. */
function serverKinds(): Set<string> {
  const py = readFileSync(path.resolve(__dirname, '../../../backend/app/telemetry.py'), 'utf8')
  const block = /^KINDS = frozenset\(\{([\s\S]*?)^\}\)/m.exec(py)
  if (!block) throw new Error('backend/app/telemetry.py defines KINDS')
  return new Set([...block[1].replace(/#.*$/gm, '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]))
}

/** The requests the page makes that carry the analyst's words, each as (method, url, body). */
const WORDY: [string, string, object][] = [
  ['POST', '/api/ws/w/events', { kind: 'main', payload: { text: SECRET } }],
  ['POST', '/api/ws/w/events', { kind: 'thread', payload: { thread: 't1', text: SECRET } }],
  ['POST', '/api/ws/w/orientation/message', { text: SECRET }],
  ['POST', '/api/ws/w/events', { kind: 'write', payload: { doc: 'report', text: SECRET } }],
  ['POST', '/api/ws/w/chats', { anchor: 'card:ab12', text: SECRET }],
  ['PUT', '/api/ws/w/chats/t1', { title: SECRET }],
  ['PUT', '/api/ws/w/cells/ab12', { takeaway: SECRET }],
  ['PUT', '/api/ws/w/cells/ab12', { code: SECRET }],
]

describe('telemetry', () => {
  test('every kind the page sends is one the server accepts', () => {
    const server = serverKinds()
    expect(server.size).toBeGreaterThan(40)
    expect(CLIENT_KINDS.filter((k) => !server.has(k))).toEqual([])
  })

  test('every kind a request is classified as is a kind the page declares', () => {
    const kinds = new Set<string>(CLIENT_KINDS)
    const requests: [string, string, object | null][] = [
      ...WORDY,
      ['POST', '/api/ws/w/chats/t1/interrupt', null],
      ['DELETE', '/api/ws/w/chats/t1', null],
      ['PUT', '/api/ws/w/canvas/active-group', { group: 'g1' }],
      ['POST', '/api/ws/w/events', { kind: 'start', payload: { effort: 'high' } }],
      ['PUT', '/api/ws/w/filters', { scope: 'canvas', concept: 'c1', value: 'yes' }],
      ['DELETE', '/api/ws/w/filters/canvas', null],
      ['POST', '/api/ws/w/cells/ab12/run', null],
      ['DELETE', '/api/ws/w/cells/ab12', null],
      ['POST', '/api/ws/w/views/proposals/review-threads/retry', null],
    ]
    for (const [method, url, body] of requests) {
      const row = classifyRequest(method, url, body ? JSON.stringify(body) : null)
      expect(row, `${method} ${url}`).not.toBeNull()
      expect(kinds.has(row!.kind), `${method} ${url}: ${row!.kind}`).toBe(true)
    }
  })

  test("a message's row holds its length and where it was sent, never its text", () => {
    for (const [method, url, body] of WORDY) {
      const row = classifyRequest(method, url, JSON.stringify(body))
      expect(JSON.stringify(row ?? null), `${method} ${url}`).not.toContain('private sentence')
    }
    expect(classifyRequest('POST', '/api/ws/w/events', JSON.stringify(WORDY[0][2]))).toEqual({ kind: 'ask-send', target: 'chat:main', detail: { event: 'main', chars: SECRET.length } })
  })

  test('the requests that are no analyst action, and the telemetry route itself, make no row', () => {
    expect(classifyRequest('GET', '/api/ws/w/canvas', null)).toBeNull()
    expect(classifyRequest('POST', '/api/ws/w/telemetry', '[]')).toBeNull()
    expect(classifyRequest('POST', '/api/corpora', null)).toBeNull()
    expect(classifyRequest('POST', '/api/ws/w/events', 'not json')).toBeNull()
  })

  test("a click is named by a control's short label, and never by a sentence or long text inside it", () => {
    const el = (tag: string, text: string, role?: string) => {
      const e = document.createElement(tag)
      e.textContent = text
      if (role) e.setAttribute('role', role)
      return e
    }
    expect(labelOf(el('button', 'Export'), null)).toBe('Export')
    expect(labelOf(el('div', 'Run check', 'button'), 'button')).toBe('Run check')
    expect(labelOf(el('button', SECRET), null)).toBeNull()
    expect(labelOf(el('button', 'Stop.'), null)).toBeNull()
    expect(labelOf(el('div', 'Export'), null)).toBeNull()
  })
})
