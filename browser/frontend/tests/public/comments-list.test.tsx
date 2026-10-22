// @vitest-environment jsdom
// The Comments list next to the Labels in the right sidebar (src/shell/CommentsList.tsx): the open comments on the
// cards and in the report in one list, and Apply sends a comment to Claude in main's chat.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { applyText, CommentsList } from '../../src/shell/CommentsList.tsx'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const CARD_NOTE = { id: 'n1', card: 'c7', step: null, n: null, ref: 'card:c7', check: 'details', run: 'r1', author: 'check', text: 'The chart leaves out June.', details: 'June has 40 rows.', ts: '', status: 'open' }
const REPORT_NOTE = { id: 'm1', sentence_id: 's3', text: 'This number has no citation.', author: 'check', ts: '', reply: null, status: 'open', check: 'details', quote: 'Most runs fail' }

function serve() {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/canvas/comments')) return json({ comments: [CARD_NOTE] })
    if (url.includes('/types/report')) return json({ title: 'Report', sections: [], comments: [REPORT_NOTE, { ...REPORT_NOTE, id: 'm2', status: 'dismissed' }] })
    if (url.endsWith('/checks')) return json([{ id: 'details', name: 'Important details', builtin: true, shown: true, covers: ['documents', 'cards'] }])
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
})

test('the list holds the open comments of the cards and the report, and Apply sends one to main in the chat', async () => {
  serve()
  const asked: { chatId: string; send?: string }[] = []
  const off = bus.on('openChat', (e) => asked.push(e))
  const el = await mount(<CommentsList ws="w1" />)
  await settle()
  const rows = [...el.querySelectorAll('.lside-comment')]
  expect(rows.map((r) => r.getAttribute('data-surface'))).toEqual(['canvas', 'report'])
  expect(el.textContent).toContain('The chart leaves out June.')
  expect(el.textContent).toContain('“Most runs fail”')
  const apply = [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Apply')!
  await act(async () => apply.click())
  expect(asked).toEqual([{ chatId: 'main', send: 'Apply this comment of the check “Important details” on card:c7: The chart leaves out June.\n\nJune has 40 rows.' }])
  off()
})

test('the sidebar shows Comments next to Labels, by the list the top bar asked for', async () => {
  serve()
  const el = await mount(<LabelsSidebar ws="w1" tab="comments" onClose={() => undefined} />)
  await settle()
  expect(el.querySelector('aside')?.getAttribute('data-tab')).toBe('comments')
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Comments')
  expect(el.querySelectorAll('.lside-comment').length).toBe(2)
})
