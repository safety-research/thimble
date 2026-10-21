// @vitest-environment jsdom
// Report a problem's preview (shell/ShareReport): the exact issue text with each placeholder marked, the privacy scan
// beside it with Keep on each hit but a key or a token, and Send and Save as file that carry the ask id, the only way a
// report leaves. Fix this and Report this ask main to draft the report. All names and data here are made up.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { markPieces, reportMessage, ReportThis, ShareReportDialog, type IssueDraft } from '../../src/shell/ShareReport.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const DRAFT: IssueDraft = {
  slug: 'rows-fails-ab12',
  title: 'Rows fails on ‹data file›',
  text: '# Rows fails on ‹data file›\n\n## What happened\nRows could not open ‹data file›: the cited row was ‹field› = ‹email›.\n',
  draft: '',
  hits: [
    { id: 'h1', kind: 'file', found: 'tickets.csv', replacement: '‹data file›', kept: false, keepable: true },
    { id: 'h2', kind: 'field', found: 'queue_owner', replacement: '‹field›', kept: false, keepable: true },
    { id: 'h3', kind: 'email', found: 'dana@example.org', replacement: '‹email›', kept: false, keepable: true },
    { id: 'h4', kind: 'token', found: 'made-up-token', replacement: '‹secret›', kept: false, keepable: false },
  ],
  ask: 'ask-made-up',
  repo: 'safety-research/thimble',
  login: 'made-up-tester',
}

test('the preview marks each placeholder, offers Keep but for a token, and only its clicks send with the ask id', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    sent.push({ url: String(url), body })
    if (String(url).endsWith('/keep')) return json({ ...DRAFT, text: DRAFT.text.replaceAll('‹field›', 'queue_owner'), hits: DRAFT.hits.map((h) => (h.id === 'h2' ? { ...h, kept: true } : h)) })
    return json({ status: 'sent', url: 'https://github.com/example/thimble/issues/1' })
  })
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  let closed = 0
  const el = await mount(<ShareReportDialog ws="w" draft={DRAFT} fix onClose={() => closed++} />)

  expect(el.querySelector('h2')?.textContent).toBe('Share this report')
  expect(el.textContent).toContain('from your login @made-up-tester')
  expect(el.textContent).toContain('fixes are made from the terminal plugin for now')
  const marks = [...el.querySelectorAll('.share-ph')].map((m) => m.textContent)
  expect(marks).toEqual(['‹data file›', '‹data file›', '‹field›', '‹email›'])
  expect(el.querySelector('[data-testid="share-text"]')?.textContent).toBe(DRAFT.text)
  expect(el.textContent).toContain('4 found in this text · all removed')
  const hits = [...el.querySelectorAll('.share-hit')]
  expect(hits.map((h) => h.querySelector('.share-keep')?.textContent ?? h.querySelector('.share-never')?.textContent)).toEqual(['Keep', 'Keep', 'Keep', 'never sent'])
  expect(sent).toEqual([])

  await act(async () => (hits[1].querySelector('.share-keep') as HTMLButtonElement).click())
  await settle()
  expect(sent[0].url).toMatch(/\/ws\/w\/issues\/rows-fails-ab12\/keep$/)
  expect(sent[0].body).toEqual({ hit: 'h2', keep: true, ask: 'ask-made-up' })
  expect(el.textContent).toContain('3 removed, 1 kept')

  const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLButtonElement
  await act(async () => send.click())
  await settle()
  expect(sent[1].url).toMatch(/\/issues\/rows-fails-ab12\/send$/)
  expect(sent[1].body).toEqual({ answer: 'send', ask: 'ask-made-up' })
  expect(closed).toBe(1)
  expect(toasts[0]).toContain('https://github.com/example/thimble/issues/1')
  off()
})

test('Fix this and Report this ask main to draft a report of the failure', async () => {
  const got: { mode: string; text: string }[] = []
  const off = bus.on('reportThis', (p) => got.push(p))
  const el = await mount(<ReportThis text="Rows could not open the file" />)
  const [fix, report] = [...el.querySelectorAll('button')]
  await act(async () => fix.click())
  await act(async () => report.click())
  expect(got).toEqual([{ mode: 'fix', text: 'Rows could not open the file' }, { mode: 'report', text: 'Rows could not open the file' }])
  expect(reportMessage('fix', 'x')).toBe('Fix this problem in thimble: x')
  expect(reportMessage('report', '')).toMatch(/^I want to report a problem with thimble/)
  expect(markPieces('a ‹path› b', ['‹path›'])).toEqual([{ text: 'a ', mark: false }, { text: '‹path›', mark: true }, { text: ' b', mark: false }])
  off()
})
