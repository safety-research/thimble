// @vitest-environment jsdom
// A card's takeaway, in the canvas's `[[value|ref]]` form, goes through the healing pass as a reply does (lib/heal): the
// page sends it as Markdown links, each citation of a card shows a spinner while the check runs, then a re-pointed one
// opens its new place and a contradicted one carries a red ×.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { bus } from '../../src/lib/bus.ts'
import { healInput } from '../../src/lib/heal.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('a takeaway shows a spinner while its citations are checked, then each one healed in place', async () => {
  const take = 'Of all runs, [[31|card:aaaaaa#n/closed]] merged and [[30|card:aaaaaa#n/open]] stayed open, see [[runs/r1.jsonl#L4]].'
  expect(healInput(take)).toBe('Of all runs, [31](card:aaaaaa#n/closed) merged and [30](card:aaaaaa#n/open) stayed open, see [[runs/r1.jsonl#L4]].')
  let answer: (r: Response) => void = () => undefined
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/heal')) return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    sent.push(JSON.parse(String(init?.body)).text)
    return new Promise<Response>((r) => (answer = r))
  })
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={take} />
    </ChipContext.Provider>,
  )
  await settle()
  expect(sent).toEqual([healInput(take)])
  expect(el.querySelectorAll('.refchip-checking')).toHaveLength(2)

  answer(
    json({
      text: '',
      of: 'x',
      version: 'y',
      changes: [
        { label: '31', ref: 'card:aaaaaa#n/closed', state: 'linked', how: 'cell', to: 'card:aaaaaa#n/merged' },
        { label: '30', ref: 'card:aaaaaa#n/open', state: 'contradicted', how: 'contradicted', source: '4', why: 'the cited place shows 4' },
      ],
    }),
  )
  await settle()
  await settle()
  expect(el.querySelectorAll('.refchip-checking')).toHaveLength(0)
  const chips = [...el.querySelectorAll<HTMLElement>('.refchip-value')]
  expect(chips.map((c) => c.dataset.ref)).toEqual(['card:aaaaaa#n/merged', 'card:aaaaaa#n/open'])
  expect(chips[0].querySelector('.refchip-x')).toBeNull()
  expect(chips[1].classList.contains('broken') && chips[1].querySelector('.refchip-x')?.textContent).toBe('×')
})

test('a citation whose place is gone turns gray in a reply once the check says so, its reason on hover', async () => {
  const reply = 'The next page, dse/StartSeite, has [456](card:aaaaaa#page/dse/StartSeite) edits.'
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).endsWith('/heal')) return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    return json({ text: reply, of: 'x', version: 'x', changes: [{ label: '456', ref: 'card:aaaaaa#page/dse/StartSeite', state: 'quiet', how: 'gone', why: 'the card draws no part page/dse/StartSeite' }] })
  })
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={reply} />
    </ChipContext.Provider>,
  )
  await settle()
  await settle()
  const chip = el.querySelector<HTMLElement>('.refchip-value')!
  expect(chip.textContent).toBe('456')
  expect(chip.classList.contains('refchip-quiet')).toBe(true)
  expect(el.querySelectorAll('.refchip-checking')).toHaveLength(0)
})

test('a citation whose place is gone when it is opened turns gray with its reason, and so does each chip of its ref', async () => {
  const reply = 'The run [started here](runs/r1.jsonl#L4) and [it started](runs/r1.jsonl#L4) once.'
  let status = 404
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async () =>
    status === 404 ? new Response('{"detail":"\'runs/r1.jsonl#L4\'"}', { status: 404, headers: { 'content-type': 'application/json' } }) : json({ ref: 'runs/r1.jsonl#L4', kind: 'record', excerpt: 'a line' }),
  )
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={reply} />
    </ChipContext.Provider>,
  )
  await settle()
  const chips = () => [...el.querySelectorAll<HTMLElement>('.refchip-value')]
  expect(chips()).toHaveLength(2)
  expect(chips().some((c) => c.classList.contains('refchip-quiet'))).toBe(false)
  const hover = async () => {
    await act(async () => chips()[0].dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150))
    })
    await settle()
  }
  await hover()
  expect(chips().every((c) => c.classList.contains('refchip-quiet'))).toBe(true)
  expect(document.body.textContent).toContain('Not linked — the cited place is gone')
  // the place is back (an undo): the next hover opens it and the chips look as before
  status = 200
  await hover()
  expect(chips().some((c) => c.classList.contains('refchip-quiet'))).toBe(false)
})

const chipsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.refchip-value')]
const hoverChip = async (chip: HTMLElement) => {
  await act(async () => chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150))
  })
  await settle()
}

test('a takeaway checked before its card drew is checked again when the card runs, and the new answer shows', async () => {
  const take = 'Of the 36 tickets, [[26|card:bbbbbb#closed/all]] closed.'
  const sent: string[] = []
  // the first check comes before the card drew; the second after it ran
  const answers = [
    { label: '26', ref: 'card:bbbbbb#closed/all', state: 'quiet', how: 'gone', why: 'the card draws no part closed/all' },
    { label: '26', ref: 'card:bbbbbb#closed/all', state: 'linked', how: 'kept', to: 'card:bbbbbb#closed/all' },
  ]
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/heal')) return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    sent.push(JSON.parse(String(init?.body)).text)
    return json({ text: '', of: 'x', version: 'x', changes: [answers[Math.min(sent.length, answers.length) - 1]] })
  })
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={take} />
    </ChipContext.Provider>,
  )
  await settle()
  await settle()
  expect(sent).toHaveLength(1)
  expect(chipsOf(el)[0].classList.contains('refchip-quiet')).toBe(true)

  // a card the text does not cite changes: nothing is asked again
  await act(async () => bus.emit('cell', { notebook: 'n', cell: 'cccccc', kind: 'ran' }))
  await settle()
  expect(sent).toHaveLength(1)

  await act(async () => bus.emit('cell', { notebook: 'n', cell: 'bbbbbb', kind: 'ran' }))
  await settle()
  await settle()
  expect(sent).toEqual([healInput(take), healInput(take)])
  expect(el.querySelectorAll('.refchip-checking')).toHaveLength(0)
  expect(chipsOf(el)[0].classList.contains('refchip-quiet')).toBe(false)
})

test("a contradicted citation's hover says it doesn't match, and what its place shows", async () => {
  const take = 'Of the 36 tickets, [[25|card:dddddd#closed/all]] closed.'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).endsWith('/heal')) return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    return json({ text: '', of: 'x', version: 'x', changes: [{ label: '25', ref: 'card:dddddd#closed/all', state: 'contradicted', how: 'contradicted', source: '26', why: 'the cited part shows 26' }] })
  })
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={take} />
    </ChipContext.Provider>,
  )
  await settle()
  await settle()
  await hoverChip(chipsOf(el)[0])
  expect(document.body.textContent).toContain("Doesn't match")
  expect(document.body.textContent).toContain('the cited part shows 26')
  expect(document.body.textContent).not.toContain('Unable to verify')
})
