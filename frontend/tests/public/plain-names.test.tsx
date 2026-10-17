// @vitest-environment jsdom
// Words and names a new analyst can read (bug hunt G11): a step names thimble's own command by its name, never its
// absolute path (src/chat/model.ts thimbleCommands); the analyst's own message in a side thread carries no "sent from"
// line (src/chat/Rows.tsx byLabel); a passage's chip names its line without the block (src/lib/refs.ts refLabel); the
// analyst's own card is headed `you` (src/canvas/layout.ts cellThread); a table holds back `1 more row`
// (src/canvas/FrameTable.tsx); a view's chip names the view (src/lib/cellName.ts registerViewNames); and a report
// nothing is written in points to the documents that are (src/report/ReportTab.tsx blankFrame).
import { afterEach, expect, test } from 'vitest'
import { cellThread } from '../../src/canvas/layout.ts'
import { moreRows } from '../../src/canvas/FrameTable.tsx'
import { callLineText, thimbleCommands } from '../../src/chat/model.ts'
import { byLabel } from '../../src/chat/Rows.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import { registerViewNames } from '../../src/lib/cellName.ts'
import { refLabel } from '../../src/lib/refs.ts'
import type { Writeup } from '../../src/lib/types.ts'
import { blankFrame } from '../../src/report/ReportTab.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

test("a step names thimble's own command by its name, never its absolute path", () => {
  expect(thimbleCommands('/srv/tools/thimble/plugin/bin/thimble-run card runs')).toBe('thimble-run card runs')
  expect(thimbleCommands('cd x && "/home/ada/.thimble/app/plugin/bin/thimble" state labels | head')).toBe('cd x && thimble state labels | head')
  expect(thimbleCommands('cat /srv/bin/thimbles.txt')).toBe('cat /srv/bin/thimbles.txt')
  expect(callLineText('Bash', { command: '/srv/tools/thimble/plugin/bin/thimble-run card runs' }, 'teashop')).toBe('Bash thimble-run card runs')
})

test("the analyst's own message carries no line saying where it was sent from; the agent tray's still does", () => {
  expect(byLabel('browser', 'thread-7')).toBeNull()
  expect(byLabel('browser', 'main')).toBeNull()
  expect(byLabel('terminal', 'thread-7', true)).toBe('typed in the agent tray')
})

test("a passage's chip names its file and line, never the block", () => {
  expect(refLabel('P5/transcript.md#L873.b0')).toBe('P5 › transcript.md L873')
  expect(refLabel('P5/transcript.md#L873.b1:c4-20')).toBe('P5 › transcript.md L873')
})

test("the analyst's own card is headed you, and still asks in main; main's cards are main's", () => {
  const chats = new Map()
  expect(cellThread('user', chats)).toMatchObject({ chatId: 'main', name: 'main', writable: true, maker: 'you' })
  expect(cellThread('chat:main', chats).maker ?? cellThread('chat:main', chats).name).toBe('main')
  expect(cellThread('terminal', chats).maker).toBe('main')
})

test('a table counts the rows it holds back with their unit', () => {
  expect(moreRows(1)).toBe('1 more row')
  expect(moreRows(1091)).toBe('1,091 more rows')
})

test("a view's chip names the view once Files listed it", async () => {
  registerViewNames([['tea-board', 'Tea Board']])
  const el = await mount(<RefChip ref="view:tea-board" compact workspace="w" />)
  expect(el.querySelector('.chip-text')?.textContent).toBe('Tea Board')
})

test('a report frame with nothing in it is blank; a written one or one with words is not', () => {
  const frame = (sections: unknown[]) => ({ title: '', frame: true, sections }) as unknown as Writeup
  expect(blankFrame(frame([]))).toBe(true)
  expect(blankFrame(frame([{ id: 's', heading: '', paragraphs: [{ id: 'p', sentences: [{ id: 'x', text: ' ' }] }] }]))).toBe(true)
  expect(blankFrame(frame([{ id: 's', heading: 'Teas', paragraphs: [] }]))).toBe(false)
  expect(blankFrame({ title: 'Teas', sections: [] } as unknown as Writeup)).toBe(false)
})
