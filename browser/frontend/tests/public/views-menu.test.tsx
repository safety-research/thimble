// @vitest-environment jsdom
// The ⋯ menu at the end of the views bar (src/files/ViewsMenu.tsx, ViewsBar.tsx): always there, after New view. It holds
// Propose views, whether thimble proposes views (PUT settings `propose_views`: false, or null for the default, on), and a
// check per view built for the workspace, the hidden ones too (GET /ws/{c}/views/local), each turned with PUT
// /ws/{c}/views/{slug}/on, its description beside the menu on hover. Both apply at once and leave the menu open. The
// view proposal's Don't ask again and a notice's Turn off view proposals turn the same Propose views off. In a pane's
// head, the views the bar has no room for come first in the menu, each a pick that closes it.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runNotice } from '../../src/chat/Notice.tsx'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import { PROPOSALS_OFF_LINE, ProposalCard } from '../../src/chat/ProposalCard.tsx'
import { ViewsBar, type BuiltView } from '../../src/files/ViewsBar.tsx'
import { fitViews } from '../../src/files/viewsFit.ts'
import { PROPOSE_VIEWS, VIEWS_MENU, ViewsMenu, viewTip, withShown } from '../../src/files/ViewsMenu.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { LocalViewRow } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const T = '2026-11-05T10:00:00Z'
const NIGHT: LocalViewRow = { slug: 'night-runs', name: 'Night Runs', description: "Last night's import run on top, its status and its rows.", file_viewer: false, on: true }
const STAGES: LocalViewRow = { slug: 'stage-times', name: 'Stage Times', description: 'How long each stage takes, run by run.', file_viewer: false, on: true }
const OLD: LocalViewRow = { slug: 'old-board', name: 'Old Board', description: '', file_viewer: false, on: false }
const SUBS: LocalViewRow = { slug: 'subtitles', name: 'Subtitles', description: 'Each cue with its time.', file_viewer: true, on: true }
const BAR: BuiltView[] = [
  { slug: 'night-runs', name: 'Night Runs' },
  { slug: 'stage-times', name: 'Stage Times' },
]

let settings: Record<string, unknown>
let local: LocalViewRow[]
let sent: { method: string; url: string; body: unknown }[]
let refuse: boolean

beforeEach(() => {
  settings = { models: {} }
  local = [NIGHT, STAGES, OLD]
  sent = []
  refuse = false
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const u = String(url)
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (method !== 'GET' && !u.includes('/telemetry')) sent.push({ method, url: u, body })
    if (u.endsWith('/settings') && method === 'PUT') {
      if (refuse) return json({ detail: 'the config file cannot be written' }, 500)
      const patch = body as { propose_views?: boolean | null }
      if (patch.propose_views === null) delete settings.propose_views
      else settings = { ...settings, ...patch }
      return json(settings)
    }
    if (u.endsWith('/settings')) return json(settings)
    if (u.endsWith('/views/local')) return json({ name: 'w', views: local })
    const on = /\/views\/([^/]+)\/on$/.exec(u)
    if (on && method === 'PUT') {
      if (refuse) return json({ detail: 'the view is gone' }, 404)
      local = withShown(local, on[1], (body as { on: boolean }).on)
      return json({ name: 'w', views: local })
    }
    if (u.endsWith('/views/proposals')) return json([{ slug: 'rows', name: 'Rows per Stage', description: 'Rows at each stage.', task: '', claims: ['runs/*.jsonl'], status: 'suggested', offered: { at: T, after: 'main' } }])
    if (/\/views(\?|$)/.test(u)) return json([])
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const menuButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(`.files-views button[aria-label="${VIEWS_MENU}"]`)!
const menu = () => document.querySelector<HTMLElement>(`.popover[role="menu"][aria-label="${VIEWS_MENU}"]`)
const rows = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? [])]
const row = (name: string) => rows().find((b) => b.querySelector('.menu-item-label')?.textContent === name)!
const checked = () => rows().map((b) => [b.querySelector('.menu-item-label')?.textContent, b.getAttribute('role'), b.getAttribute('aria-checked')])
const open = async (el: HTMLElement) => {
  await act(async () => menuButton(el).click())
  await settle()
}

async function bar(ws: string, compact = false) {
  invalidateSettings(ws)
  const el = await mount(<ViewsBar ws={ws} value="browser" onChange={() => undefined} views={BAR} compact={compact} />)
  await settle()
  return el
}

describe('the ⋯ menu at the end of the views bar', () => {
  test('it is always the bar’s last control, after New view, with no view built too', async () => {
    const el = await bar('w1')
    const buttons = [...el.querySelectorAll<HTMLElement>('.files-views > button, .files-views > span > button')]
    expect(buttons.slice(-2).map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['New view', VIEWS_MENU])
    unmountAll()
    local = []
    const empty = await mount(<ViewsBar ws="w1b" value="browser" onChange={() => undefined} views={[]} />)
    await settle()
    expect(menuButton(empty)).not.toBeNull()
    await open(empty)
    expect(checked()).toEqual([[PROPOSE_VIEWS, 'menuitemcheckbox', 'true']])
  })

  test('it lists Propose views and each view built here, hidden ones too, each checked while it shows', async () => {
    const el = await bar('w2')
    expect(menu()).toBeNull()
    await open(el)
    expect(menuButton(el).getAttribute('aria-expanded')).toBe('true')
    expect(checked()).toEqual([
      [PROPOSE_VIEWS, 'menuitemcheckbox', 'true'],
      ['Night Runs', 'menuitemcheckbox', 'true'],
      ['Stage Times', 'menuitemcheckbox', 'true'],
      ['Old Board', 'menuitemcheckbox', 'false'],
    ])
    // a separator between Propose views and the views
    expect(menu()!.querySelectorAll('.menu-sep')).toHaveLength(1)
    // a hidden view's check holds its place, so the names line up
    expect(row('Old Board').querySelector('.menu-check')?.classList.contains('is-off')).toBe(true)
    expect(sent).toEqual([])
  })

  test('a view’s description shows beside the menu on hover', async () => {
    local = [NIGHT, SUBS, OLD]
    const el = await bar('w3')
    await open(el)
    await act(async () => void row('Night Runs').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const tip = () => document.querySelector<HTMLElement>('.tip[role="tooltip"]')
    expect(tip()?.textContent).toBe(NIGHT.description)
    expect(row('Night Runs').getAttribute('aria-describedby')).toBe(tip()?.id)
    await act(async () => void row('Night Runs').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
    expect(tip()).toBeNull()
    expect(viewTip(SUBS)).toBe('Each cue with its time.')
    expect(viewTip(OLD)).toBe('')
  })

  test('a view’s check hides it or shows it again at once, and the menu stays open', async () => {
    const el = await bar('w4')
    await open(el)
    await act(async () => row('Stage Times').click())
    expect(row('Stage Times').getAttribute('aria-checked')).toBe('false')
    await settle()
    expect(sent).toEqual([{ method: 'PUT', url: '/api/ws/w4/views/stage-times/on', body: { on: false } }])
    expect(menu()).not.toBeNull()
    await act(async () => row('Old Board').click())
    await settle()
    expect(sent.slice(1)).toEqual([{ method: 'PUT', url: '/api/ws/w4/views/old-board/on', body: { on: true } }])
    expect(checked().slice(1).map(([name, , on]) => [name, on])).toEqual([['Night Runs', 'true'], ['Stage Times', 'false'], ['Old Board', 'true']])
  })

  test('a check that cannot be saved says so and shows what the server holds', async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    try {
      const el = await bar('w5')
      await open(el)
      refuse = true
      await act(async () => row('Night Runs').click())
      await settle()
      await settle()
      expect(toasts).toEqual(['Could not hide Night Runs. the view is gone'])
      expect(row('Night Runs').getAttribute('aria-checked')).toBe('true')
    } finally {
      off()
    }
  })

  test('Propose views turns view proposals off and on at once, as Settings did, and the menu stays open', async () => {
    const el = await bar('w6')
    await open(el)
    await act(async () => row(PROPOSE_VIEWS).click())
    expect(row(PROPOSE_VIEWS).getAttribute('aria-checked')).toBe('false')
    await settle()
    expect(sent).toEqual([{ method: 'PUT', url: '/api/ws/w6/settings', body: { propose_views: false } }])
    expect(settings.propose_views).toBe(false)
    expect(row(PROPOSE_VIEWS).getAttribute('aria-checked')).toBe('false')
    await act(async () => row(PROPOSE_VIEWS).click())
    await settle()
    expect(sent.slice(1)).toEqual([{ method: 'PUT', url: '/api/ws/w6/settings', body: { propose_views: null } }])
    expect('propose_views' in settings).toBe(false)
    expect(row(PROPOSE_VIEWS).getAttribute('aria-checked')).toBe('true')
    expect(menu()).not.toBeNull()
  })

  test("the proposal's Don't ask again and a notice's Turn off view proposals turn the same Propose views off", async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    try {
      invalidateSettings('w7')
      const el = await mount(
        <>
          <ProposalCard ws="w7" />
          <ViewsBar ws="w7" value="browser" onChange={() => undefined} views={BAR} />
        </>,
      )
      await settle()
      await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
      await act(async () => el.querySelector<HTMLButtonElement>('.chat-offer-off')!.click())
      await settle()
      expect(settings.propose_views).toBe(false)
      expect(toasts).toEqual([PROPOSALS_OFF_LINE])
      expect(PROPOSALS_OFF_LINE).toContain('Settings')
      expect(el.querySelector('.chat-offer')).toBeNull()
      await open(el)
      expect(row(PROPOSE_VIEWS).getAttribute('aria-checked')).toBe('false')
      // on again from the menu: the proposal is back above the composer
      await act(async () => row(PROPOSE_VIEWS).click())
      await settle()
      await settle()
      expect(el.querySelector('.chat-offer')).not.toBeNull()
      // a notice's Turn off view proposals
      expect(await act(async () => runNotice('w7', { label: 'Turn off view proposals', do: 'proposals-off' }))).toBe(true)
      await settle()
      expect(row(PROPOSE_VIEWS).getAttribute('aria-checked')).toBe('false')
    } finally {
      off()
    }
  })
})

describe('in a pane’s head', () => {
  test('the views the bar has no room for come first, each a pick that closes the menu', async () => {
    const picked = vi.fn()
    const el = await mount(<ViewsMenu ws="w8" size="sm" overflow={[{ value: 'v:stage-times', label: 'Stage Times', icon: 'view', checked: false, note: 'new', onSelect: picked }]} dot />)
    await settle()
    expect(el.querySelector('.files-views-more-dot')).not.toBeNull()
    await act(async () => el.querySelector<HTMLButtonElement>('button')!.click())
    await settle()
    expect(checked().map(([name, role]) => [name, role])).toEqual([
      ['Stage Times', 'menuitemradio'],
      [PROPOSE_VIEWS, 'menuitemcheckbox'],
      ['Night Runs', 'menuitemcheckbox'],
      ['Stage Times', 'menuitemcheckbox'],
      ['Old Board', 'menuitemcheckbox'],
    ])
    expect(rows()[0].querySelector('.menu-item-note')?.textContent).toBe('new')
    expect(menu()!.querySelectorAll('.menu-sep')).toHaveLength(2)
    await act(async () => rows()[0].click())
    expect(picked).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  test('what fits beside New view and the ⋯ menu, which always show', () => {
    // 3 options of 100, a gap of 4, + and ⋯ 24 each (52 with their gap)
    const widths = [100, 100, 100]
    expect(fitViews({ widths, room: 3 * 100 + 3 * 4 + 52, gap: 4, tail: 52, more: 0, active: 0 })).toEqual([0, 1, 2])
    expect(fitViews({ widths, room: 3 * 100 + 3 * 4 + 51, gap: 4, tail: 52, more: 0, active: 0 })).toEqual([0, 1])
    // the picked option keeps its place among those shown
    expect(fitViews({ widths, room: 2 * 100 + 2 * 4 + 52, gap: 4, tail: 52, more: 0, active: 2 })).toEqual([0, 2])
  })
})
