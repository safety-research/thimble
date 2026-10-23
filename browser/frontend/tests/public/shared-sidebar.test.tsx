// @vitest-environment jsdom
// The shared Labels and Comments sidebar (src/shell/LabelsSidebar.tsx, src/shell/CommentsList.tsx): one sidebar that
// shows the labels or the comment categories, the section the top bar's Labels or Comments button opened; a category's
// Show in sets where its check comments (Chat: Claude's answers), its detail edits its definition and lists its open
// comments as links, those on Claude's answers too, and Apply sends a comment to Claude in main's chat.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { applyText, type CommentItem } from '../../src/shell/CommentsList.tsx'
import { commentCategories, LabelsSidebar, NOTES, withCover } from '../../src/shell/LabelsSidebar.tsx'
import type { Check } from '../../src/lib/types.ts'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const CARD_NOTE = { id: 'n1', card: 'c7', step: null, n: null, ref: 'card:c7', check: 'details', run: 'r1', author: 'check', text: 'The chart leaves out June.', details: 'June has 40 rows.', ts: '', status: 'open' }
const ANSWER_NOTE = { id: 'a1', check: 'details', check_name: 'Important details', color: 1, turn: 't1', row: '0', ref: 'answer:t1#s2', start: 0, end: 20, quote: 'Most runs **fail** at night.', text: 'Only the nightly runs fail.', details: '', status: 'open' }
const REPORT_NOTE = { id: 'm1', sentence_id: 's3', text: 'This number has no citation.', author: 'check', ts: '', reply: null, status: 'open', check: 'details', quote: 'Most runs fail' }

const CHECKS = [
  { id: 'details', name: 'Important details', prompt: 'Mark what the reader should know.', colour: 1, builtin: true, shown: true, covers: ['documents', 'cards', 'answers'] },
  { id: 'judgment', name: 'Judgment calls', prompt: 'Mark the calls Claude made for the reader.', colour: 2, builtin: true, shown: false, covers: ['documents'] },
]

function serve(patches: { url: string; body: unknown }[] = []) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(String(init.body)) })
      return json({ ...CHECKS[1], ...JSON.parse(String(init.body)) })
    }
    if (url.includes('/canvas/comments')) return json({ comments: [CARD_NOTE] })
    if (url.includes('/answer-comments')) return json({ comments: [ANSWER_NOTE, { ...ANSWER_NOTE, id: 'a2', status: 'dismissed' }], running: [] })
    if (url.includes('/types/report')) return json({ title: 'Report', sections: [], comments: [REPORT_NOTE, { ...REPORT_NOTE, id: 'm2', status: 'dismissed' }, { ...REPORT_NOTE, id: 'm3', check: null, author: 'analyst', text: 'Say why.' }] })
    if (url.endsWith('/checks')) return json(CHECKS)
    if (url.includes('/concepts')) return json([])
    return json({})
  })
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))

test("Apply's message names the check, the place and what the comment says", () => {
  const item = { id: 'n1', surface: 'canvas' as const, check: 'details', author: 'check', text: 'The chart leaves out June.', details: 'June has 40 rows.', ref: 'card:c7', where: 'card c7' }
  expect(applyText(item, 'Important details')).toBe('Apply this comment of the check “Important details” on card:c7: The chart leaves out June.\n\nJune has 40 rows.')
  const inReport = { ...item, surface: 'report' as const, ref: 'report:report#s3', quote: 'Most runs fail', details: '' }
  expect(applyText(inReport, 'Important details')).toBe('Apply this comment of the check “Important details” in the report at “Most runs fail” (report:report#s3): The chart leaves out June.')
  const onAnswer = { ...item, surface: 'chat' as const, ref: 'answer:t1#s2', quote: 'Most runs fail', details: '' }
  expect(applyText(onAnswer, 'Important details')).toBe('Apply this comment of the check “Important details” on your answer at “Most runs fail”: The chart leaves out June.')
})

const item = (id: string, check: string | null, surface: 'canvas' | 'report'): CommentItem => ({ id, surface, check, author: check ? 'check' : 'analyst', text: id, details: '', ref: `card:${id}`, where: id })

test('the categories are the checks in order, then a check the list lacks, then Notes', () => {
  const cats = commentCategories(CHECKS as unknown as Check[], [item('a', 'details', 'canvas'), item('b', 'gone', 'report'), item('c', null, 'report'), item('d', 'details', 'report')])
  expect(cats.map((c) => [c.key, c.items.map((x) => x.id)])).toEqual([['details', ['a', 'd']], ['judgment', []], ['gone', ['b']], [NOTES, ['c']]])
})

test('a surface turned on or off changes what the check covers, and never leaves it covering nothing', () => {
  expect(withCover({ covers: ['documents'] }, 'cards', true)).toEqual(['documents', 'cards'])
  expect(withCover({ covers: ['documents', 'cards'] }, 'documents', false)).toEqual(['cards'])
  expect(withCover({ covers: ['documents'] }, 'documents', false)).toBeNull()
})

test('the sidebar shows the section its button opened: the labels, or the comment categories with their counts and Show in', async () => {
  serve()
  const labels = await mount(<LabelsSidebar ws="w1" section="labels" onClose={() => undefined} />)
  await settle()
  expect([...labels.querySelectorAll('.lside-section')].map((s) => s.getAttribute('data-section'))).toEqual(['labels'])
  expect(labels.querySelector('.lside-heading')?.textContent).toBe('Labels 0')
  expect(labels.querySelector('[data-category]')).toBeNull()
  unmountAll()
  const el = await mount(<LabelsSidebar ws="w1" section="comments" onClose={() => undefined} />)
  await settle()
  expect([...el.querySelectorAll('.lside-section')].map((s) => s.getAttribute('data-section'))).toEqual(['comments'])
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Comments 4')
  const rows = [...el.querySelectorAll('[data-category]')]
  expect(rows.map((r) => r.getAttribute('data-category'))).toEqual(['details', 'judgment', NOTES])
  expect(rows[0].querySelector('.lside-name')?.textContent).toBe('Important details3')
  const chips = [...rows[0].querySelectorAll('.lside-chip')].map((b) => [b.textContent, b.getAttribute('aria-checked'), (b as HTMLButtonElement).disabled])
  expect(chips).toEqual([['Chat1', 'true', false], ['Cards1', 'true', false], ['Report1', 'true', false]])
  // the only surface a check covers stays on
  const judgment = [...rows[1].querySelectorAll('.lside-chip')] as HTMLButtonElement[]
  expect(judgment.map((b) => b.disabled)).toEqual([false, false, true])
})

test("Cards on a category's Show in makes its check comment on the cards", async () => {
  const patches: { url: string; body: unknown }[] = []
  serve(patches)
  const el = await mount(<LabelsSidebar ws="w1" section="comments" onClose={() => undefined} />)
  await settle()
  const cards = [...el.querySelectorAll('[data-category="judgment"] .lside-chip')][1] as HTMLButtonElement
  await act(async () => cards.click())
  expect(patches).toEqual([{ url: expect.stringContaining('/checks/judgment'), body: { covers: ['documents', 'cards'] } }])
})

test("Chat on a category's Show in makes its check read Claude's answers", async () => {
  const patches: { url: string; body: unknown }[] = []
  serve(patches)
  const el = await mount(<LabelsSidebar ws="w1" section="comments" onClose={() => undefined} />)
  await settle()
  const chat = [...el.querySelectorAll('[data-category="judgment"] .lside-chip')][0] as HTMLButtonElement
  expect(chat.textContent).toBe('Chat')
  await act(async () => chat.click())
  expect(patches).toEqual([{ url: expect.stringContaining('/checks/judgment'), body: { covers: ['documents', 'answers'] } }])
})

test("a category's detail edits its definition and lists its comments as links, and Apply sends one to main", async () => {
  serve()
  const asked: { chatId: string; send?: string }[] = []
  const off = bus.on('openChat', (e) => asked.push(e))
  const el = await mount(<LabelsSidebar ws="w1" section="comments" onClose={() => undefined} />)
  await settle()
  const open = el.querySelector('[data-category="details"] .lside-name') as HTMLButtonElement
  await act(async () => open.click())
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Mark what the reader should know.')
  const rows = [...el.querySelectorAll('.lside-comment')]
  expect(rows.map((r) => r.getAttribute('data-surface'))).toEqual(['canvas', 'report', 'chat'])
  expect(rows.map((r) => r.querySelector('.lside-comment-where')?.textContent)).toEqual(['card c7', 'the report', "Claude's answer"])
  expect(el.textContent).toContain('“Most runs fail”')
  expect(rows[2].querySelector('.lside-comment-quote')?.textContent).toBe('“Most runs fail at night.”')
  const apply = [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Apply')!
  await act(async () => apply.click())
  expect(asked).toEqual([{ chatId: 'main', send: 'Apply this comment of the check “Important details” on card:c7: The chart leaves out June.\n\nJune has 40 rows.' }])
  off()
})
