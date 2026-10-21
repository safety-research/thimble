// @vitest-environment jsdom
// Escape in the Checks sidebar: from a check's detail it goes back to the list, then it closes the sidebar. A field with
// words typed in it, and a key something over the page already handled (the pointer box), keep their Escape.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { setLenses, type Lens } from '../../src/lib/marks.ts'
import { LensSidebar } from '../../src/shell/LensSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const lens: Lens = {
  id: 'jargon',
  name: 'Jargon',
  color: 'teal',
  builtin: false,
  on: true,
  scope: { chat: true, cards: false, report: true },
  question: 'Which words would a new reader not know?',
  leaves: 'a note',
  instructions: null,
  found: { chat: 2, cards: 0, report: 0 },
}

const esc = (target: EventTarget = window, prevented = false) =>
  act(async () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    if (prevented) e.preventDefault()
    target.dispatchEvent(e)
  })

test('Escape goes back from a check to the list, then closes the Checks sidebar', async () => {
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
  setLenses('w-test', [lens])
  const onClose = vi.fn()
  const el = await mount(<LensSidebar ws="w-test" tab="checks" onClose={onClose} />)
  await settle()
  const heading = () => el.querySelector('.lside-heading')?.textContent ?? null

  // a key the pointer box handled first is not the sidebar's
  await esc(window, true)
  expect(onClose).not.toHaveBeenCalled()

  // a check's detail open: Escape goes back to the list
  const row = el.querySelector<HTMLElement>('.lside-row[data-lens=jargon] .lside-name')!
  await act(async () => row.click())
  expect(el.querySelector('.lside-back')).not.toBeNull()
  await esc(document.body)
  expect(el.querySelector('.lside-back')).toBeNull()
  expect(heading()).toBe('Checks')
  expect(onClose).not.toHaveBeenCalled()

  // words typed in a field keep their Escape
  const field = document.createElement('textarea')
  field.value = 'Which numbers lack a source?'
  el.querySelector('.lside')!.appendChild(field)
  await esc(field)
  expect(onClose).not.toHaveBeenCalled()

  // at the list, Escape closes the sidebar
  await esc(document.body)
  expect(onClose).toHaveBeenCalledTimes(1)
})
