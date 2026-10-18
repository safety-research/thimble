// @vitest-environment jsdom
// The pictures the analyst pasted into a message (src/chat/Rows.tsx Pictures): the message's record names them
// (`images`, the files the server keeps in the workspace), and its row shows each under the message as a picture that
// opens full size; a message with none shows no picture. Bug hunt I9: a prompt with a picture never reached the chat.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('a message with pasted pictures shows each under it, opening full size; one without shows none', async () => {
  const records: ChatRecord[] = [
    { type: 'user', text: 'This is my browser: [Image #1] Make a bar chart card.', by: 'terminal', images: ['08e8476587c74445-1.png'] },
    { type: 'text', delta: 'I made the bar chart card.' },
    { type: 'user', text: 'And one more table.', by: 'terminal' },
  ]
  const rows = foldRecords(records)
  expect(rows[0]).toMatchObject({ kind: 'user', images: ['08e8476587c74445-1.png'] })
  const el = await mount(<Rows rows={rows} ws="mini" />)
  const users = [...el.querySelectorAll('.chat-user')]
  expect(users).toHaveLength(2)
  const img = users[0]!.querySelector('.chat-picture img') as HTMLImageElement
  expect(img.getAttribute('src')).toMatch(/\/ws\/mini\/pictures\/08e8476587c74445-1\.png$/)
  expect((users[0]!.querySelector('a.chat-picture') as HTMLAnchorElement).getAttribute('href')).toBe(img.getAttribute('src'))
  expect(users[1]!.querySelector('.chat-picture')).toBeNull()
})
