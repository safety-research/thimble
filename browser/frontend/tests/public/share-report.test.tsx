// @vitest-environment jsdom
// Report a problem's preview (shell/ShareReport): the exact issue text with each placeholder marked, the privacy scan
// beside it with Keep on each hit but a key or a token, and Send and Save as file that carry the ask id, the only way a
// report leaves. Fix this and Report this ask main to draft the report. All names and data here are made up.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { diffLines, markPieces, reportMessage, ReportThis, ShareReportDialog, type IssueDraft } from '../../src/shell/ShareReport.tsx'
import { FixState, fixLine, fixMessage, fixStep } from '../../src/shell/FixEntry.tsx'
import { busySteps, pageJob } from '../../src/lib/busy.ts'
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
  const el = await mount(<ShareReportDialog ws="w" draft={DRAFT} onClose={() => closed++} />)

  expect(el.querySelector('h2')?.textContent).toBe('Share this report')
  expect(el.textContent).toContain('from your login @made-up-tester')
  expect(el.querySelector('[data-testid="share-change-tab"]')).toBeNull()
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
  expect(reportMessage('fix', 'x')).toBe('/fix x')
  expect(reportMessage('report', '')).toMatch(/^I want to report a problem with thimble/)
  expect(markPieces('a ‹path› b', ['‹path›'])).toEqual([{ text: 'a ', mark: false }, { text: '‹path›', mark: true }, { text: ' b', mark: false }])
  off()
})

test('a fix with a change shows its pull request: the files it changes and the diff, and Send says drafts', async () => {
  const diff = 'diff --git a/plugin/claims/order.py b/plugin/claims/order.py\n--- a/plugin/claims/order.py\n+++ b/plugin/claims/order.py\n@@ -1 +1 @@\n-ORDER = 1\n+ORDER = 2\n'
  const draft: IssueDraft = { ...DRAFT, kind: 'change', pr: '## Change\nNewest first.\n', diff, files: [{ path: 'plugin/claims/order.py', added: 1, removed: 1 }] }
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    sent.push(String(url))
    return json({ status: 'sent', url: 'https://github.com/example/thimble/issues/3', pr_url: 'https://github.com/example/thimble/pull/4' })
  })
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  const el = await mount(<ShareReportDialog ws="w" draft={draft} onClose={() => undefined} />)
  expect(el.querySelector('h2')?.textContent).toBe('Share this fix')
  expect(el.textContent).toContain('a draft pull request with the change below and an issue that links it')
  const tab = el.querySelector('[data-testid="share-change-tab"]') as HTMLButtonElement
  expect(tab.textContent).toBe('Pull request · 1 file')
  await act(async () => tab.click())
  expect(el.querySelector('[data-testid="share-change"]')?.textContent).toContain('plugin/claims/order.py +1 −1')
  expect([...el.querySelectorAll('.share-dl-add')].map((l) => l.textContent)).toEqual(['+ORDER = 2\n'])
  const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLButtonElement
  await act(async () => send.click())
  await settle()
  expect(toasts[0]).toBe('Sent as drafts: pull request https://github.com/example/thimble/pull/4 · issue https://github.com/example/thimble/issues/3')
  expect(diffLines('+a\n-b\n c').map((l) => l.kind)).toEqual(['add', 'del', 'ctx'])
  off()
})

test("the top bar's Fix… sends /fix, and the fix line offers what the fix's state allows", () => {
  expect(fixMessage('  sort claims\n newest first ')).toBe('/fix sort claims newest first')
  const f = { slug: 'sort-claims', title: 'Sort claims newest first', status: 'working' }
  // while Claude works on it the busy line says so, and the top bar's line shows nothing
  expect(fixLine(f, null)).toBeNull()
  expect(fixStep(f)).toBe('fixing: Sort claims newest first')
  expect(fixStep({ ...f, status: 'ready' })).toBeNull()
  expect(fixLine({ ...f, status: 'applied' }, 'sort-claims')).toEqual({ words: '✓ fixed: Sort claims newest first', good: true, actions: ['submit', 'undo'] })
  expect(fixLine({ ...f, status: 'ready' }, null)?.actions).toEqual(['try', 'submit'])
  // the terminal plugin's marketplace may run the fix (applied), but the browser does not: Try it is offered
  expect(fixLine({ ...f, status: 'applied' }, null)?.actions).toEqual(['try', 'submit'])
  expect(fixLine({ ...f, status: 'sent' }, null)).toBeNull()
  expect(fixLine({ ...f, status: 'sent' }, 'sort-claims')).toEqual({ words: '✓ fixed: Sort claims newest first · sent', good: true, actions: ['undo'] })
})

test('Undo restarts the browser on the release: one toast in browser words, then the page reloads', async () => {
  const f = { slug: 'sort-claims', title: 'Sort claims newest first', status: 'ready' }
  let boot = 'boot-a'
  const posted: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return json({ ok: true, boot })
    if (init?.method === 'POST') {
      posted.push(u)
      boot = 'boot-b' // the server restarts
      return json({ fixes: [f], active: null, restarting: true, said: 'Restarting thimble browser without your fix. The page reloads when it is back.' })
    }
    return json({ fixes: [f], active: 'sort-claims' })
  })
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  const el = await mount(<FixState ws="w" />)
  await settle()
  const undo = el.querySelector('[data-fix-action="undo"]') as HTMLButtonElement
  expect(el.textContent).toContain('✓ fixed: Sort claims newest first')
  await act(async () => undo.click())
  await act(async () => new Promise((r) => setTimeout(r, 700)))
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatch(/\/ws\/w\/fixes\/undo$/)
  expect(toasts).toEqual(['Restarting thimble browser without your fix. The page reloads when it is back.'])
  expect(toasts.join(' ')).not.toContain('reload-plugins')
  expect(reload).toHaveBeenCalledTimes(1)
  // the busy line said the restart while it ran, and the button kept its own word
  expect(busySteps()).toContain('restarting without the fix')
  expect(el.textContent).not.toContain('Restarting…')
  pageJob('fix:restart', null)
  off()
})
