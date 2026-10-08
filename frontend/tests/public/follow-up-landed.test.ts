// A message the analyst sends from an orientation's thread shows as on its way (ChatPanel's outbox) until the thread's
// log holds it. The server records a browser follow-up as it passes it on, `by` browser and with no `run`, since a
// message to a running orientation starts none (orient_session._show_message): live check L17 (group c) saw every sent
// message stay below the thread with a spinner after it had reached the orientation.
import { expect, test } from 'vitest'
import { foldRecords, landedTexts } from '../../src/chat/model.ts'
import type { ChatRecord } from '../../src/lib/types.ts'

const records = (list: object[]) => list as unknown as ChatRecord[]

test('a browser follow-up the log records has landed, with or without a run', () => {
  const rows = foldRecords(records([
    { type: 'user', ts: '2026-10-06T09:45:33Z', text: 'Make two cards.' },
    { type: 'text', delta: 'Done.' },
    { type: 'user', ts: '2026-10-06T09:47:30Z', text: 'Reply Done. and nothing else.', by: 'browser' },
    { type: 'user', ts: '2026-10-06T09:49:05Z', text: '  And April?  ', by: 'browser', run: 2 },
    { type: 'user', ts: '2026-10-06T09:50:05Z', text: 'From the tray.', by: 'terminal', run: 3 },
  ]))
  const landed = landedTexts(rows)
  expect(landed.has('Reply Done. and nothing else.')).toBe(true)
  expect(landed.has('And April?')).toBe(true)
  expect(landed.has('From the tray.')).toBe(true)
  expect(landed.has('Make two cards.')).toBe(false)
})
