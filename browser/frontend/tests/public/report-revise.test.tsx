// @vitest-environment jsdom
// Write on the report's toolbar (src/report/WriteAction.tsx): one field for instructions or feedback, and the button,
// Write before Claude has written in the report and Revise after. Enter or the button sends the instructions, an empty
// field asks for the report as it stands, and a sent field empties. While Claude writes, the button reads Writing and the
// field takes nothing; Stop beside it stops Claude's turn in main, with the call the chat's Stop makes.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api'
import { bus } from '../../src/lib/bus'
import { StopWriter, WRITE_PLACEHOLDER, WriteAction } from '../../src/report/WriteAction.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const type = async (el: HTMLElement, text: string) => {
  const field = el.querySelector<HTMLInputElement>('input.wu-write-field')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return field
}

describe("the report's Write", () => {
  test('the instructions go out with the button, and the field empties once they did', async () => {
    const onWrite = vi.fn(async () => true)
    const el = await mount(<WriteAction name="Report" written={false} busy={false} onWrite={onWrite} />)
    const field = await type(el, 'Write this up for my team, keep my order, two pages')
    expect(field.placeholder).toBe(WRITE_PLACEHOLDER)
    const b = el.querySelector<HTMLButtonElement>('button.btn-primary')!
    expect(b.textContent).toBe('Write')
    await act(async () => b.click())
    await settle()
    expect(onWrite).toHaveBeenCalledWith('Write this up for my team, keep my order, two pages')
    expect(el.querySelector<HTMLInputElement>('input.wu-write-field')!.value).toBe('')
  })

  test('Enter sends feedback on a written report, whose button reads Revise; a send that failed keeps the words', async () => {
    const onWrite = vi.fn(async () => false)
    const el = await mount(<WriteAction name="Report" written busy={false} onWrite={onWrite} />)
    expect(el.querySelector('button.btn-primary')!.textContent).toBe('Revise')
    const field = await type(el, 'shorter, lead with the number')
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    expect(onWrite).toHaveBeenCalledWith('shorter, lead with the number')
    expect(field.value).toBe('shorter, lead with the number')
  })

  test('while Claude writes the button reads Writing and the field takes nothing', async () => {
    const onWrite = vi.fn(async () => true)
    const el = await mount(<WriteAction name="Report" written busy onWrite={onWrite} />)
    expect(el.querySelector('button.btn-primary')!.textContent).toBe('Writing')
    expect(el.querySelector<HTMLInputElement>('input.wu-write-field')!.disabled).toBe(true)
  })
})

describe('Stop beside Writing', () => {
  test("interrupts main's turn, as the chat's Stop does, and stays busy while it ends", async () => {
    const interrupt = vi.spyOn(api, 'interrupt').mockResolvedValue({ stopped: true })
    const el = await mount(<StopWriter ws="w-stop" />)
    const b = el.querySelector<HTMLButtonElement>('button.wu-stop')!
    expect(b.textContent).toBe('Stop')
    await act(async () => b.click())
    await settle()
    expect(interrupt).toHaveBeenCalledWith('w-stop', 'main')
    expect(b.disabled).toBe(true)
  })

  test('a Stop that failed says why and can be pressed again', async () => {
    vi.spyOn(api, 'interrupt').mockRejectedValue(new Error('the server is gone'))
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    const el = await mount(<StopWriter ws="w-stop" />)
    const b = el.querySelector<HTMLButtonElement>('button.wu-stop')!
    await act(async () => b.click())
    await settle()
    off()
    expect(toasts.join(' ')).toContain('the server is gone')
    expect(b.disabled).toBe(false)
  })
})
