// @vitest-environment jsdom
// The views bar (src/files/ViewsBar.tsx). A view and a proposal are the same button, the proposal with its build's
// state after its name; only a view the analyst asked for shows a failure, with Retry, and a proposal the orientation
// dropped (backend views.drop) is shown nowhere, in the bar, in what a run made or as a chip. New view's popover holds a
// field that says what to type and where it goes, and a send square beside it, off while the field is empty. Enter or
// the square asks main for the view as a browser message, and the popover closes. A chip that names a view in the chat
// wears the colours the bar gives a view that is not picked. The server is a fake fetch.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewChip } from '../../src/chat/ViewChip.tsx'
import { buildLabel, NEW_VIEW_PLACEHOLDER, ViewsBar } from '../../src/files/ViewsBar.tsx'
import { isDropped, withoutDropped } from '../../src/lib/proposals.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let posted: { url: string; body: unknown }[] = []

beforeEach(() => {
  posted = []
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ id: 'e1', kind: 'main', delivered: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Type into a controlled input as a person does, so React sees the change. */
function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const proposal = (slug: string, name: string, status: Proposal['status'], extra: Partial<Proposal> = {}): Proposal => ({
  slug, name, status, why: '', claims: ['board.jsonl'], arrangement: '', proposed_by: 'orient', ts: '2026-09-25T10:00:00+00:00', ...extra,
})

describe('the views and the proposals', () => {
  test('a view and a proposal are the same button in the bar, the proposal with its build state after its name', async () => {
    const proposals = [
      proposal('life', 'Topic map', 'building', { chat: 'c1' }),
      proposal('mine', 'Page timeline', 'failed', { asked: true, chat: 'c2', error: 'checks failed: the page did not load' }),
    ]
    const el = await mount(<ViewsBar ws="toy" value="browser" onChange={() => undefined} views={[{ slug: 'board', name: 'Thread board' }]} proposals={proposals} />)
    const opts = [...el.querySelectorAll('.files-views .seg-opt')]
    expect(opts.map((o) => o.getAttribute('data-anchor'))).toEqual([null, 'view:board', 'view:life', 'view:mine'])
    expect(opts.map((o) => o.querySelector('.seg-label')?.textContent)).toEqual(['File browser', 'Thread board', 'Topic map', 'Page timeline'])
    expect(el.querySelector('.view-chip'), 'no small dashed chip in the bar').toBeNull()
    const building = el.querySelector('.files-proposal[data-status="building"]')!
    expect(building.querySelector('.seg-opt .spinner')?.getAttribute('aria-label')).toBe('Building')
    expect(building.querySelector('.files-proposal-retry, .mark-failed')).toBeNull()
    const failed = el.querySelector('.files-proposal[data-status="failed"]')!
    expect(failed.querySelector('.seg-opt .mark-failed')).not.toBeNull()
    expect(failed.querySelector('.files-proposal-retry')?.textContent).toBe('Retry')
    await act(async () => failed.querySelector<HTMLButtonElement>('.files-proposal-retry')!.click())
    await settle()
    expect(posted.map((p) => p.url)).toContain('/api/ws/toy/views/proposals/mine/retry')
  })

  test("a build's spinner says it waits for permission while a request of its session is on the card", async () => {
    expect(buildLabel('queued', false)).toBe('Queued')
    expect(buildLabel('building', false)).toBe('Building')
    expect(buildLabel('building', true)).toBe('Waiting for permission')
    const ask = { id: 'p1', tool: 'WebFetch', what: 'https://vega.github.io/vega-lite/docs/bar.html' }
    vi.stubGlobal('fetch', async (url: string) => {
      const body = String(url).endsWith('/chats') ? [{ id: 'c1', kind: 'agent', role: 'dev', status: 'running', permissions: [ask] }, { id: 'c2', kind: 'agent', role: 'dev', status: 'running', permissions: [{ ...ask, expired: 'x' }] }] : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const proposals = [proposal('life', 'Topic map', 'building', { chat: 'c1' }), proposal('mine', 'Page timeline', 'building', { chat: 'c2' })]
    const el = await mount(<ViewsBar ws="asks" value="browser" onChange={() => undefined} views={[]} proposals={proposals} />)
    await settle()
    const spin = (slug: string) => el.querySelector(`.files-proposal:has([data-anchor="view:${slug}"]) .spinner`)?.getAttribute('aria-label')
    expect(spin('life')).toBe('Waiting for permission')
    expect(spin('mine')).toBe('Building')
  })

  test('a proposal the orientation dropped is shown nowhere: not in what a run made, not as a chip', async () => {
    const dropped = proposal('gone', 'Deletion timeline', 'dropped', { error: 'checks failed' })
    const built = proposal('board', 'Thread board', 'built')
    const made = { views: ['Thread board', 'Deletion timeline'], viewSlugs: { 'Deletion timeline': 'gone' } }
    expect(isDropped([dropped, built], 'gone')).toBe(true)
    expect(isDropped([dropped, built], null, 'Deletion timeline')).toBe(true)
    expect(isDropped([dropped, built], null, 'Thread board')).toBe(false)
    expect(withoutDropped(made, [dropped, built]).views).toEqual(['Thread board'])
    expect(withoutDropped(made, null)).toBe(made)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([dropped, built]), { status: 200, headers: { 'content-type': 'application/json' } }))
    const el = await mount(
      <span>
        <ViewChip ws="drops" slug="gone" name="Deletion timeline" />
        <ViewChip ws="drops" slug="board" name="Thread board" />
      </span>,
    )
    await settle()
    expect([...el.querySelectorAll('.view-chip')].map((c) => c.getAttribute('data-anchor'))).toEqual(['view:board'])
  })

  test('a built view whose change failed shows the failure with Retry on its chip, and Retry makes the change again', async () => {
    const changed = proposal('board', 'Thread board', 'built', { asked: true, chat: 'c3', failed_change: 'Newest thread first', error: "Anthropic's API was overloaded each time the build tried over 28 min" })
    const plain = proposal('life', 'Topic map', 'built')
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push({ url: String(url), body: null })
      return new Response(JSON.stringify(init?.method === 'POST' ? { ...changed, status: 'queued' } : [changed, plain]), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const el = await mount(
      <span>
        <ViewChip ws="changes" slug="board" name="Thread board" />
        <ViewChip ws="changes" slug="life" name="Topic map" />
      </span>,
    )
    await settle()
    const [failedChip, readyChip] = [...el.querySelectorAll('.view-chip')]
    expect(failedChip.querySelector('.view-chip-mark')).not.toBeNull()
    expect(failedChip.querySelector('.view-chip-word'), 'not also ready').toBeNull()
    expect(readyChip.querySelector('.view-chip-mark, .view-chip-retry')).toBeNull()
    await act(async () => failedChip.querySelector<HTMLButtonElement>('.view-chip-retry')!.click())
    await settle()
    expect(posted.map((p) => p.url)).toContain('/api/ws/changes/views/proposals/board/retry')
  })
})

describe('New view', () => {
  test('the field says what to type, the square sends, and main is asked for the view', async () => {
    const el = await mount(<ViewsBar ws="toy" value="browser" onChange={() => undefined} views={[]} proposals={[]} />)
    const open = el.querySelector<HTMLButtonElement>('.files-views-new')!
    await act(async () => open.click())
    await settle()
    const input = document.querySelector<HTMLInputElement>('.files-views-ask input')!
    expect(input.placeholder).toBe(NEW_VIEW_PLACEHOLDER)
    expect(NEW_VIEW_PLACEHOLDER).toBe('Describe a view; Enter asks main')
    const send = document.querySelector<HTMLButtonElement>('.files-views-ask-send')!
    expect(send.disabled).toBe(true)
    await act(async () => type(input, 'a board of the agents by round'))
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/toy/events', body: { kind: 'main', payload: { text: 'Build a view: a board of the agents by round' } } }])
    expect(document.querySelector('.files-views-ask input')).toBeNull()
  })
})

describe("a chip that names a view", () => {
  /** The colour declarations (color, background, box-shadow) of the first rule whose selector is `selector`. */
  const colours = (file: string, selector: string): Record<string, string> => {
    const css = readFileSync(path.resolve(__dirname, '../../src/styles', file), 'utf8')
    const at = css.indexOf(`\n${selector} {`)
    expect(at, `${file} has ${selector}`).toBeGreaterThanOrEqual(0)
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/^\s*(color|background|box-shadow)\s*:\s*([^;]+);/gm)) out[m[1]] = m[2].trim()
    return out
  }

  test("wears the views bar's colours for a view that is not picked, and no dashed edge", () => {
    const bar = colours('files.css', ".files-views .seg-opt[data-anchor^='view:']:not(.active)")
    const chip = colours('chat.css', '.view-tab')
    expect(chip).toEqual(bar)
    expect(bar.color).toBe('var(--text-accent)')
    expect(readFileSync(path.resolve(__dirname, '../../src/styles/chat.css'), 'utf8')).not.toMatch(/\.view-tab[^{]*\{[^}]*dashed/)
  })
})
