// @vitest-environment jsdom
// Report a problem (src/shell/ProblemReport.tsx): the form offers two actions. File an issue on GitHub writes the zip
// and opens the prefilled new issue in the same click, and the dialog then shows the zip, to attach. Fix it with
// /thimble-fix shows wherever /thimble-fix works (GET /fixes says no problem), whatever the code tickets' runner says
// (GET /dev/status), and starts a fix with the description. The dialog names no code ticket and no developer agent.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import type { ProblemReport } from '../../src/lib/types.ts'
import { ProblemReportPopover } from '../../src/shell/ProblemReport.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

/** Why fixes cannot be made (backend fixes.OFF_LINE) and why code tickets do not run (backend dev.NO_RUNNER_LINE). */
const FIXES_OFF = "thimble's fixes are off on this server (THIMBLE_FIXES=off)"
const NO_TICKETS = 'This server runs no dev tickets (THIMBLE_DEV_STACK is off, as on a validation stack).'
const ISSUE = 'https://github.com/safety-research/thimble/issues/new?title=Minimap&body=Minimap'
const ZIP: ProblemReport = {
  path: '/home/analyst/Downloads/thimble-feedback-20261109-101500.zip',
  name: 'thimble-feedback-20261109-101500.zip',
  bytes: 154_000,
  size: '151 KB',
  files: ['contents.txt', 'description.txt'],
  can_reveal: false,
  contact: '@maintainer',
  contact_url: 'https://github.com/maintainer',
  instructions: 'Attach the zip to a GitHub issue only if you are happy to share it publicly.',
  issue_url: ISSUE,
}
const WORDS = "The canvas's minimap button is too small\nIt is hard to hit on a laptop."

let fixProblem = ''
let tickets = ''
let sent: [string, unknown][] = []
let opened: unknown[][] = []
let chats: string[] = []
let closed = 0
let offChat = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  fixProblem = ''
  tickets = ''
  sent = []
  opened = []
  chats = []
  closed = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url).replace(/^.*\/api/, '')
    const method = init.method ?? 'GET'
    if (method !== 'GET') sent.push([`${method} ${u}`, JSON.parse(String(init.body ?? 'null'))])
    if (u === '/fixes') return json({ problem: fixProblem, fixes: [] })
    if (u === '/dev/status') return json({ running: false, tickets, queued: 0 })
    if (u === '/dev/tickets') return json({ id: 'fix-4', title: 'x', status: 'running', chat: null, fix: { id: 4 } }, 202)
    if (u === '/ws/mini/feedback') return json(ZIP, 201)
    return json({})
  })
  vi.spyOn(window, 'open').mockImplementation((...args: unknown[]) => {
    opened.push(args)
    return null
  })
  offChat = bus.on('openChat', (e) => void chats.push(e.chatId))
})
afterEach(() => {
  offChat()
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
const buttons = () => [...dialog().querySelectorAll('button')]
const button = (name: string) => buttons().find((b) => b.textContent === name)
const click = async (el: Element | null | undefined) => {
  await act(async () => (el as HTMLButtonElement).click())
  await settle()
}

/** Type `text` into the description as React hears it. */
async function describe(text: string) {
  const box = dialog().querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function open() {
  const anchor = document.body.appendChild(document.createElement('button'))
  await mount(<ProblemReportPopover ws="mini" anchor={anchor} open onClose={() => void closed++} />)
  await settle()
}

/** All the dialog says, its tooltips among it. */
const words = () => [dialog().textContent ?? '', ...buttons().map((b) => b.title)].join(' ')

test('where /thimble-fix works, the form offers Fix it with /thimble-fix and File an issue on GitHub, each with a tooltip', async () => {
  tickets = NO_TICKETS // the code tickets' runner is off here: that does not matter
  await open()
  expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Fix it with /thimble-fix', 'File an issue on GitHub'])
  expect(button('Fix it with /thimble-fix')!.title).toMatch(/in your own thimble/)
  expect(button('File an issue on GitHub')!.title).toMatch(/opens a new GitHub issue/)
  expect(words()).not.toMatch(/ticket|developer|bundle/i)
})

test('where /thimble-fix does not work, the form offers no fix, even where code tickets run', async () => {
  fixProblem = FIXES_OFF
  tickets = '' // the code tickets' runner would take one
  await open()
  expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'File an issue on GitHub'])
  expect(words()).not.toMatch(/ticket|developer/i)
})

test('Fix it with /thimble-fix starts a fix with the description, and the dialog closes on main\'s chat', async () => {
  await open()
  expect(button('Fix it with /thimble-fix')!.disabled).toBe(true) // nothing to fix yet
  await describe(WORDS)
  await click(button('Fix it with /thimble-fix'))
  expect(sent).toEqual([['POST /dev/tickets', { workspace: 'mini', title: "The canvas's minimap button is too small", body: WORDS, source: 'ui' }]])
  expect(closed).toBe(1)
  expect(chats).toEqual(['main'])
  expect(opened).toEqual([])
})

test('File an issue on GitHub writes the zip and opens the prefilled issue in the same click; the dialog shows the zip', async () => {
  await open()
  await describe(WORDS)
  await click(button('File an issue on GitHub'))
  expect(sent.map(([what]) => what)).toEqual(['POST /ws/mini/feedback'])
  expect(sent[0][1]).toMatchObject({ description: WORDS, logs: true, screenshot: null, screenshot_asked: false })
  expect(opened).toEqual([[ISSUE, '_blank', 'noopener,noreferrer']])
  expect(dialog().querySelector('[data-panel="problem"]')?.getAttribute('data-state')).toBe('done')
  expect(dialog().querySelector('.problem-path')?.textContent).toBe(ZIP.path)
  // a browser that blocked the tab opened after the zip was written: the issue opens from here
  await click(button('Open a GitHub issue'))
  expect(opened).toHaveLength(2)
  expect(closed).toBe(0)
})
