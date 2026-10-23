// @vitest-environment jsdom
// A fix of the person's thimble runs in the background in a thread of its own (backend fixes.fixer_chat): the tree lists
// it by the fix's name (`fixing <name>`, `changing <name>` for a round of a fix they have), its steps show there, and
// main's chat shows the person's message as they typed it and one line that points at the thread. A message typed in
// the fix's thread is a round of that fix.
import { afterEach, describe, expect, test } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { fixStarted, Rows } from '../../src/chat/Rows.tsx'
import { composerTarget, pickItems, threadKind, threadNodes } from '../../src/chat/threads.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: '2026-10-23T10:00:00Z', parent: null } as ChatMeta
const fixer = (over: Partial<ChatMeta> = {}): ChatMeta =>
  ({ id: 'f1', kind: 'agent', role: 'fixer', title: 'fixing Card counts its rows', created_at: '2026-10-23T10:01:00Z', parent: 'main', status: 'running', fix: 4, ...over }) as ChatMeta

afterEach(() => unmountAll())

describe('the fix in the tree', () => {
  test('listed under main by its name, not its number, running while its fixer works', () => {
    expect(threadKind(fixer())).toBe('fix')
    const items = pickItems([main, fixer()], () => false, () => false)
    const it = items.find((x) => x.id === 'f1')!
    expect([it.kind, it.label, it.title, it.parent, it.running, it.hidden]).toEqual(['fix', 'main/fixing Card counts its rows', 'fixing Card counts its rows', 'main', true, false])
    const node = threadNodes(items).find((n) => n.id === 'f1')!
    expect(node.name).toBe('fixing Card counts its rows')
    const ended = pickItems([main, fixer({ status: 'done', title: 'changing Card counts its rows', ts_end: '2026-10-23T10:05:00Z' } as Partial<ChatMeta>)], () => false, () => false).find((x) => x.id === 'f1')!
    expect([ended.title, ended.running, ended.ended, ended.hidden]).toEqual(['changing Card counts its rows', false, 'done', false])
  })

  test('a message typed in its thread goes to the fix, as a round of it', () => {
    expect(composerTarget('fix', fixer(), null)).toEqual({ to: 'fix', fix: 4 })
  })
})

describe("main's chat", () => {
  const records = [
    { type: 'user', ts: '2026-10-23T10:01:00Z', text: '/thimble-fix make the card count its rows', by: 'browser' },
    { type: 'agent', ts: '2026-10-23T10:01:00Z', chat: 'f1', role: 'fixer', title: 'fixing make the card count its rows', by: 'browser' },
  ] as unknown as ChatRecord[]

  test('the message as typed, then one line that points at the fix thread; none of the fixer\'s steps', async () => {
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map([['f1', 'main/fixing make the card count its rows']]) }}>
        <Rows rows={foldRecords(records)} ws="w" chat="main" streaming={false} />
      </ThreadsContext.Provider>,
    )
    await settle()
    expect(el.querySelector('.chat-user')?.textContent).toContain('/thimble-fix make the card count its rows')
    const note = el.querySelector('.chat-fix-started')!
    expect(note.getAttribute('data-chat')).toBe('f1')
    expect(note.textContent).toContain('Fixing it in the background in')
    expect(note.textContent).toContain('fixing make the card count its rows')
    // no agent card or chip of the fixer, whose steps are its thread's
    expect(el.querySelector('.chat-agent')).toBeNull()
    expect(el.textContent).not.toMatch(/^\s*\d+ /)
  })

  test('a round of a fix the person has says it changes it', () => {
    expect(fixStarted('changing Card counts its rows')).toBe('Changing it in the background in')
    expect(fixStarted('fixing Card counts its rows')).toBe('Fixing it in the background in')
  })
})
