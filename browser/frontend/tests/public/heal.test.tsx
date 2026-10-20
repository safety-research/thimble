// @vitest-environment jsdom
// A card's takeaway, in the canvas's `[[value|ref]]` form, goes through the healing pass as a reply does (lib/heal): the
// page sends it as Markdown links, each citation of a card shows a spinner while the check runs, then a re-pointed one
// opens its new place and a contradicted one carries a red ×.
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
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
