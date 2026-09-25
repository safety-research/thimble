// @vitest-environment jsdom
// Report a problem (src/shell/ProblemReport.tsx): the dialog sends what the analyst chose, with the tab's recent errors
// when the logs go in and the chats a failure named first; once the server has written the bundle it shows where the
// zip is, the sentence that says to attach it only if it may be public with the maintainer's handle as a link, Open a
// GitHub issue, which opens the server's prefilled new-issue link in a new tab, and Show in folder only when the
// server's machine can show it; a failure says why and keeps the form. A stand-in fetch answers for the server; the
// handle, the repository and the zip are invented.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { recordProblem } from '../../src/lib/problemLog.ts'
import { failureText, linkPieces, LOGS_NOTE, ProblemReportPopover } from '../../src/shell/ProblemReport.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const CONTACT = '@maintainer'
const CONTACT_URL = 'https://github.com/maintainer'
const INSTRUCTIONS = `Attach the zip to a GitHub issue only if you are happy to share it publicly; otherwise reach ${CONTACT} on GitHub for private logs.`
const ISSUE_URL = 'https://github.com/example/thimble/issues/new?title=The%20chart%20is%20blank.&body=The%20chart%20is%20blank.%0A%0A-%20thimble%3A%20release%201.0'
const PATH = '/home/tester/Downloads/thimble-feedback-20260925-021500.zip'
const REPORT = (over: Record<string, unknown> = {}) => ({
  path: PATH,
  name: 'thimble-feedback-20260925-021500.zip',
  bytes: 188_416,
  size: '184 KB',
  files: ['contents.txt', 'description.txt', 'versions.txt', 'doctor.txt'],
  can_reveal: false,
  contact: CONTACT,
  contact_url: CONTACT_URL,
  instructions: INSTRUCTIONS,
  issue_url: ISSUE_URL,
  ...over,
})

const posted: { url: string; body: Record<string, unknown> }[] = []
const opened: unknown[][] = []
let answer: { status: number; body: unknown } = { status: 201, body: REPORT() }

beforeEach(() => {
  posted.length = 0
  opened.length = 0
  answer = { status: 201, body: REPORT() }
  vi.stubGlobal('open', (...args: unknown[]) => {
    opened.push(args)
    return null
  })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

async function dialog(prefill: { description: string; focus?: string[] } | null = null): Promise<HTMLElement> {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  await mount(<ProblemReportPopover ws="mini" anchor={anchor} open onClose={() => {}} prefill={prefill} />)
  await settle()
  return document.body
}

const button = (root: HTMLElement, name: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === name)
const press = async (b: HTMLElement | undefined) => {
  await act(async () => b!.click())
  await settle()
}

describe('the sentence that says where to send it', () => {
  test('each place it names is a link, in order', () => {
    const pieces = linkPieces(INSTRUCTIONS, [{ text: CONTACT, href: CONTACT_URL }, { text: 'GitHub issue', href: 'https://i' }])
    expect(pieces.map((p) => p.text).join('')).toBe(INSTRUCTIONS)
    expect(pieces.filter((p) => p.href).map((p) => [p.text, p.href])).toEqual([['GitHub issue', 'https://i'], [CONTACT, CONTACT_URL]])
    expect(linkPieces('plain', [{ text: '', href: 'x' }])).toEqual([{ text: 'plain' }])
  })

  test("a failure's description is what failed, then its error on the next line when it has one", () => {
    expect(failureText('The orientation failed.', 'Claude Code exited 1')).toBe('The orientation failed.\nClaude Code exited 1')
    expect(failureText('The orientation failed.', '  ')).toBe('The orientation failed.')
  })
})

describe('the dialog', () => {
  test('sends what failed, the logs with the tab\'s errors, and the chats a failure named; then shows where the zip is', async () => {
    recordProblem({ kind: 'request', method: 'GET', url: '/api/ws/mini/views', status: 500, text: '500 Internal Server Error: boom' })
    const root = await dialog({ description: 'The orientation failed.\nClaude Code exited 1', focus: ['orient1'] })
    const form = root.querySelector('.problem[data-state="form"]')!
    expect(form.querySelector('textarea')?.value).toBe('The orientation failed.\nClaude Code exited 1')
    const [shot, logs] = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(shot.checked).toBe(false)
    expect(logs.checked).toBe(true)
    expect(form.querySelector('.problem-note')?.textContent).toBe(LOGS_NOTE)
    await press(button(root, 'Prepare bundle'))
    expect(posted).toHaveLength(1)
    const { url, body } = posted[0]
    expect(url).toBe('/api/ws/mini/feedback')
    expect(body).toMatchObject({ description: 'The orientation failed.\nClaude Code exited 1', screenshot: null, screenshot_asked: false, logs: true, focus: ['orient1'] })
    expect((body.browser as { url: string }[]).map((e) => e.url)).toContain('/api/ws/mini/views')
    const done = root.querySelector('.problem[data-state="done"]')!
    expect(done.querySelector('.problem-path')?.textContent).toBe(PATH)
    expect(done.textContent).toContain('Bundle ready, 184 KB')
    expect(button(root, 'Download')).toBeTruthy()
    expect(button(root, 'Copy path')).toBeTruthy()
    expect(button(root, 'Show in folder')).toBeUndefined()
    const links = [...done.querySelectorAll<HTMLAnchorElement>('.problem-send a')].map((a) => [a.textContent, a.getAttribute('href'), a.target])
    expect(links).toEqual([[CONTACT, CONTACT_URL, '_blank']])
    expect(done.querySelector('.problem-send')?.textContent).toBe(INSTRUCTIONS)
    expect(done.textContent).not.toMatch(/mailto|@example\.org/)
    expect(opened).toEqual([])
    const issue = button(root, 'Open a GitHub issue')!
    expect(issue.classList.contains('btn-primary')).toBe(true)
    await press(issue)
    expect(opened).toEqual([[ISSUE_URL, '_blank', 'noopener,noreferrer']])
    expect(root.querySelector('.problem[data-state="done"]'), 'the dialog stays, with the zip to attach').toBeTruthy()
  })

  test('without the logs no browser entry goes, and Show in folder asks the server when its machine can show the zip', async () => {
    answer = { status: 201, body: REPORT({ can_reveal: true }) }
    const root = await dialog({ description: 'The chart is blank.' })
    const logs = root.querySelectorAll<HTMLInputElement>('.problem input[type="checkbox"]')[1]
    await act(async () => logs.click())
    await press(button(root, 'Prepare bundle'))
    expect(posted[0].body).toMatchObject({ logs: false, browser: [] })
    answer = { status: 200, body: { ok: true } }
    await press(button(root, 'Show in folder'))
    expect(posted.at(-1)).toEqual({ url: '/api/feedback/reveal', body: { path: PATH } })
  })

  test('a failure says why and keeps the form as it was', async () => {
    answer = { status: 507, body: { detail: 'the disk that holds /home/tester/Downloads is full' } }
    const root = await dialog({ description: 'The chart is blank.' })
    await press(button(root, 'Prepare bundle'))
    const form = root.querySelector('.problem[data-state="form"]')!
    expect(form.querySelector('.problem-error')?.textContent).toMatch(/^The bundle could not be written: .*the disk that holds \/home\/tester\/Downloads is full/)
    expect(form.querySelector('textarea')?.value).toBe('The chart is blank.')
    expect(root.querySelector('.problem[data-state="done"]')).toBeNull()
  })
})
