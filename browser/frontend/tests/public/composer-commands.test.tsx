// @vitest-environment jsdom
// The list of commands in the chat's composer (src/chat/Composer.tsx), as Claude Code lists its own: a "/" at the start
// of the text lists the commands the composer handles (src/chat/commands.ts COMMANDS, the list its send reads them
// from), one row each, its name and its description (/thimble-fix's is the one the terminal's command is registered
// with, plugin/fix/command.mjs), which wraps to two lines at most. The list follows what is typed; ↑ and ↓ move in it;
// Enter, Tab or a click puts the command in the text with a space after it, ready for its words, but Enter on a command
// typed in full sends it at once, as without the list; Esc closes it, and so does a text that is no longer a "/" and
// part of a name, or the focus leaving the text.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { FIX_DESCRIPTION } from '../../../../plugin/fix/command.mjs'
import { Composer } from '../../src/chat/Composer.tsx'
import { COMMANDS, commandIn, commandsFor, FIX_COMMAND, type ChatCommand } from '../../src/chat/commands.ts'
import { fixWords } from '../../src/chat/fix.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

// made-up commands, for a list of more than one
const MADE_UP: readonly ChatCommand[] = [
  { name: '/thimble-fix', about: 'make a change to thimble' },
  { name: '/thimble-tour', about: 'take the tour again' },
  { name: '/fold', about: 'fold the tree' },
]

const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!

async function setup(commands?: readonly ChatCommand[]) {
  const onSend = vi.fn()
  const el = await mount(<Composer onSend={onSend} sending={false} commands={commands} />)
  const box = el.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => box.focus())
  /** the text as if typed */
  const type = async (text: string) =>
    act(async () => {
      setValue.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
  /** a key pressed in the text; the event, to see whether the list took it */
  const key = async (k: string, more: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more })
    await act(async () => void box.dispatchEvent(e))
    return e
  }
  const list = () => el.querySelector<HTMLElement>('[role="listbox"]')
  const options = () => [...el.querySelectorAll<HTMLElement>('[role="option"]')]
  const names = () => options().map((o) => o.querySelector('.chat-command-name')?.textContent)
  const active = () => options().find((o) => o.getAttribute('aria-selected') === 'true')?.querySelector('.chat-command-name')?.textContent
  return { el, box, onSend, type, key, list, options, names, active }
}

describe('the list a "/" opens', () => {
  test('a "/" at the start lists the commands the composer handles, each with its description; /thimble-fix\'s is the terminal command\'s', async () => {
    const c = await setup()
    expect(c.list()).toBeNull()
    await c.type('/')
    expect(c.names()).toEqual(COMMANDS.map((x) => x.name))
    const fix = c.options().find((o) => o.querySelector('.chat-command-name')?.textContent === FIX_COMMAND)!
    expect(fix.querySelector('.chat-command-about')?.textContent).toBe(FIX_DESCRIPTION)
    // the first row is the active one, which the text names for a screen reader
    expect(c.active()).toBe(COMMANDS[0].name)
    expect(c.box.getAttribute('aria-controls')).toBe(c.list()!.id)
    expect(c.box.getAttribute('aria-activedescendant')).toBe(c.options()[0].id)
    // the list sits in the composer's sheet, before its text
    expect(c.el.querySelector('form.chat-composer > .chat-commands')).toBe(c.list())
  })

  test('it opens only on a "/" at the start of the text, and not once the name has a space after it', async () => {
    const c = await setup()
    for (const text of ['', 'a', 'a /', ' /', '\n/', 'what does /thimble-fix do?', '/thimble-fix ', '/thimble-fix the legend is cut']) {
      await c.type(text)
      expect(c.list(), JSON.stringify(text)).toBeNull()
      expect(c.box.getAttribute('aria-activedescendant')).toBeNull()
    }
    await c.type('/')
    expect(c.list()).not.toBeNull()
  })

  test('it follows what is typed: the commands whose name holds it, the name typed in full first, then the ones it starts; none closes it', async () => {
    const c = await setup()
    await c.type('/thi')
    expect(c.names()).toEqual([FIX_COMMAND])
    await c.type('/FIX')
    expect(c.names()).toEqual([FIX_COMMAND])
    await c.type('/thx')
    expect(c.list()).toBeNull()
    const m = await setup(MADE_UP)
    await m.type('/')
    expect(m.names()).toEqual(['/thimble-fix', '/thimble-tour', '/fold'])
    await m.type('/thimble-t')
    expect(m.names()).toEqual(['/thimble-tour'])
    await m.type('/f')
    expect(m.names()).toEqual(['/fold', '/thimble-fix'])
    expect(m.active()).toBe('/fold')
    // a name typed in full comes first, before the longer names it starts
    const n = await setup([{ name: '/fold-all', about: 'fold every thread' }, ...MADE_UP])
    await n.type('/fold')
    expect(n.names()).toEqual(['/fold', '/fold-all'])
  })

  test('↑ and ↓ move through the rows and round from one end to the other; the keys move no caret', async () => {
    const c = await setup(MADE_UP)
    await c.type('/')
    expect(c.active()).toBe('/thimble-fix')
    expect((await c.key('ArrowDown')).defaultPrevented).toBe(true)
    expect(c.active()).toBe('/thimble-tour')
    expect(c.box.getAttribute('aria-activedescendant')).toBe(c.options()[1].id)
    await c.key('ArrowDown')
    await c.key('ArrowDown')
    expect(c.active()).toBe('/thimble-fix')
    expect((await c.key('ArrowUp')).defaultPrevented).toBe(true)
    expect(c.active()).toBe('/fold')
    // typing starts again at the first row
    await c.type('/t')
    expect(c.active()).toBe('/thimble-fix')
  })

  test('Enter puts the active command in the text with a space after it, the caret at its end, and sends nothing', async () => {
    const c = await setup()
    await c.type('/thi')
    expect((await c.key('Enter')).defaultPrevented).toBe(true)
    expect(c.box.value).toBe(`${FIX_COMMAND} `)
    expect(c.box.selectionStart).toBe(c.box.value.length)
    expect(document.activeElement).toBe(c.box)
    expect(c.list()).toBeNull()
    expect(c.onSend).not.toHaveBeenCalled()
    // the list is closed, so the next Enter sends the command, alone here
    await c.key('Enter')
    expect(c.onSend).toHaveBeenCalledWith(FIX_COMMAND)
  })

  test('Enter on a command typed in full sends it at once, as without the list; Tab completes it', async () => {
    const c = await setup()
    await c.type(FIX_COMMAND)
    expect(c.names()).toEqual([FIX_COMMAND])
    expect((await c.key('Tab')).defaultPrevented).toBe(true)
    expect(c.box.value).toBe(`${FIX_COMMAND} `)
    expect(c.onSend).not.toHaveBeenCalled()
    await c.type(FIX_COMMAND)
    await c.key('Enter')
    expect(c.onSend).toHaveBeenCalledTimes(1)
    expect(c.onSend).toHaveBeenCalledWith(FIX_COMMAND)
    expect(c.box.value).toBe('')
    expect(c.list()).toBeNull()
    // a name in other letters is no command the composer reads (commandIn), so Enter completes it
    await c.type('/THIMBLE-FIX')
    await c.key('Enter')
    expect(c.box.value).toBe(`${FIX_COMMAND} `)
    expect(c.onSend).toHaveBeenCalledTimes(1)
    // the arrows moved from the name typed in full to another: Enter picks that one
    const m = await setup([{ name: '/fold-all', about: 'fold every thread' }, ...MADE_UP])
    await m.type('/fold')
    await m.key('ArrowDown')
    expect(m.active()).toBe('/fold-all')
    await m.key('Enter')
    expect(m.box.value).toBe('/fold-all ')
    expect(m.onSend).not.toHaveBeenCalled()
  })

  test('Enter picks the row the arrows moved to', async () => {
    const c = await setup(MADE_UP)
    await c.type('/')
    await c.key('ArrowUp')
    await c.key('Enter')
    expect(c.box.value).toBe('/fold ')
    expect(c.onSend).not.toHaveBeenCalled()
  })

  test('Tab picks as Enter does, so the focus stays in the text; Shift+Enter is left to the text', async () => {
    const c = await setup()
    await c.type('/th')
    expect((await c.key('Enter', { shiftKey: true })).defaultPrevented).toBe(false)
    expect((await c.key('Tab')).defaultPrevented).toBe(true)
    expect(c.box.value).toBe(`${FIX_COMMAND} `)
    expect(c.list()).toBeNull()
    expect(c.onSend).not.toHaveBeenCalled()
  })

  test('Esc closes the list, keeps the text and goes no further; typing opens it again', async () => {
    const c = await setup()
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    try {
      await c.type('/thi')
      expect((await c.key('Escape')).defaultPrevented).toBe(true)
      expect(c.list()).toBeNull()
      expect(c.box.value).toBe('/thi')
      expect(outside).not.toHaveBeenCalled()
      // with the list closed, the keys are the text's again
      expect((await c.key('Tab')).defaultPrevented).toBe(false)
      await c.key('Escape')
      expect(outside).toHaveBeenCalledTimes(2)
      await c.type('/thim')
      expect(c.names()).toEqual([FIX_COMMAND])
    } finally {
      document.removeEventListener('keydown', outside)
    }
  })

  test('a click on a row puts its command in the text, and the press keeps the focus there', async () => {
    const c = await setup(MADE_UP)
    await c.type('/thimble')
    const tour = c.options()[1]
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => void tour.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    await act(async () => tour.click())
    expect(c.box.value).toBe('/thimble-tour ')
    expect(document.activeElement).toBe(c.box)
    expect(c.list()).toBeNull()
    expect(c.onSend).not.toHaveBeenCalled()
  })

  test('it closes when the text no longer starts with "/" and when the text loses the focus, which brings it back', async () => {
    const c = await setup()
    await c.type('/thi')
    expect(c.list()).not.toBeNull()
    await c.type('thi')
    expect(c.list()).toBeNull()
    await c.type('/thi')
    expect(c.list()).not.toBeNull()
    await act(async () => c.box.blur())
    expect(c.list()).toBeNull()
    await act(async () => c.box.focus())
    expect(c.names()).toEqual([FIX_COMMAND])
    // after a pick the text is the command and a space: no list
    await c.key('Tab')
    expect(c.list()).toBeNull()
  })
})

test("a row's description wraps to two lines at most, and its name stays on one line (styles/chat.css)", () => {
  const css = readFileSync(path.resolve(__dirname, '../../src/styles/chat.css'), 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }
  expect(rule('.chat-command-about')).toMatch(/-webkit-line-clamp: 2;/)
  expect(rule('.chat-command-about')).not.toMatch(/nowrap|ellipsis/)
  expect(rule('.chat-command')).not.toMatch(/nowrap/)
  expect(rule('.chat-command-name')).toMatch(/white-space: nowrap;/)
})

describe('the one list of commands (commands.ts)', () => {
  test("a message's command and its words come from the list, as the send reads /thimble-fix (fixWords)", () => {
    expect(commandIn('/thimble-fix make this card say rows')).toEqual({ name: FIX_COMMAND, words: 'make this card say rows' })
    expect(commandIn('  /thimble-fix\ntwo lines ')).toEqual({ name: FIX_COMMAND, words: 'two lines' })
    expect(commandIn('/thimble-fix')).toEqual({ name: FIX_COMMAND, words: '' })
    expect(commandIn('/thimble-fixes')).toBeNull()
    expect(commandIn('what does /thimble-fix do?')).toBeNull()
    // a command added to a list is read like the others; fixWords stays /thimble-fix's
    expect(commandIn('/fold the tree', MADE_UP)).toEqual({ name: '/fold', words: 'the tree' })
    expect(commandIn('/fold the tree')).toBeNull()
    expect(fixWords('/thimble-fix the legend is cut')).toBe('the legend is cut')
    expect(fixWords('/fold the tree')).toBeNull()
  })

  test('what a "/" can still become: part of a name, case aside, the name typed in full first, then the names it starts; nothing after a space', () => {
    expect(commandsFor('/', MADE_UP).map((c) => c.name)).toEqual(['/thimble-fix', '/thimble-tour', '/fold'])
    expect(commandsFor('/fi', MADE_UP).map((c) => c.name)).toEqual(['/thimble-fix'])
    expect(commandsFor('/F', MADE_UP).map((c) => c.name)).toEqual(['/fold', '/thimble-fix'])
    expect(commandsFor('/fold', [{ name: '/fold-all', about: '' }, ...MADE_UP]).map((c) => c.name)).toEqual(['/fold', '/fold-all'])
    for (const text of ['', 'f', ' /f', '/fold ', '/fold now', '/fq']) expect(commandsFor(text, MADE_UP), text).toEqual([])
  })

  test("/thimble-fix's description is the one the terminal's command is registered with, from the one file both read (plugin/fix/command.mjs)", () => {
    expect(COMMANDS.find((c) => c.name === FIX_COMMAND)?.about).toBe(FIX_DESCRIPTION)
    expect(FIX_DESCRIPTION).toBeTruthy()
  })
})
