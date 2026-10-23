// @vitest-environment jsdom
// What the chat shows before its log holds it (src/chat/useChat.ts withLive): the analyst's message at once, and the
// words of main's reply while Claude writes them (the stream's `chat-live` records, which go to the chat alone); the
// citations in a reply read inline (styles/marks.css, styles/refchip.css); and main's model is a menu at the composer's
// foot, Opus 5.5 by default (src/chat/ModelLine.tsx mainModel).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { logged, withLive, type LivePiece, type Sent } from '../../src/chat/useChat.ts'
import { Composer } from '../../src/chat/Composer.tsx'
import { MAIN_DEFAULT_MODEL, mainModel } from '../../src/chat/ModelLine.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const LOG: ChatRecord[] = [
  { type: 'user', text: 'earlier question', by: 'browser' },
  { type: 'text', delta: 'Earlier answer.' },
]

describe('withLive', () => {
  test("the analyst's message shows at once and goes once the log holds it", () => {
    const sent: Sent[] = [{ text: 'how many runs failed?', from: LOG.length, ts: '2026-10-22T10:00:00Z' }]
    const shown = withLive(LOG, sent, [])
    expect(shown.slice(-1)).toEqual([{ type: 'user', text: 'how many runs failed?', ts: '2026-10-22T10:00:00Z', by: 'browser' }])
    const after: ChatRecord[] = [...LOG, { type: 'user', text: 'how many runs failed?', by: 'browser' }]
    expect(logged(after, sent[0])).toBe(true)
    expect(withLive(after, sent, [])).toBe(after)
  })

  test('the same words asked again earlier in the log do not count as this message', () => {
    const sent: Sent[] = [{ text: 'earlier question', from: LOG.length, ts: '' }]
    expect(logged(LOG, sent[0])).toBe(false)
    expect(withLive(LOG, sent, []).length).toBe(LOG.length + 1)
  })

  test("a reply's words while Claude writes them are the reply's text row, after the analyst's line", () => {
    const records: ChatRecord[] = [...LOG, { type: 'user', text: 'q', by: 'browser' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, { type: 'tool_result', id: 't1', summary: 'ok' }]
    const live: LivePiece[] = [{ piece: 'main:4:1', text: 'Since [March 3](#), 41 of', end: false }]
    const rows = foldRecords(withLive(records, [], live))
    const last = rows[rows.length - 1]
    expect(last.kind).toBe('text')
    expect(last.kind === 'text' && last.text).toBe('Since [March 3](#), 41 of')
  })

  test('no words yet, or none left, leaves the log as it is', () => {
    expect(withLive(LOG, [], [{ piece: 'p', text: '  ', end: false }])).toBe(LOG)
    expect(withLive(LOG, [], [])).toBe(LOG)
  })
})

describe('the stream', () => {
  test('a chat-live record goes to the chat alone, never to every listener of the stream', () => {
    const live: unknown[] = []
    const all: unknown[] = []
    const off1 = bus.on('chatLive', (e) => live.push(e))
    const off2 = bus.on('wsEvent', (e) => all.push(e))
    dispatch({ type: 'chat-live', chat: 'main', piece: 'main:2:1', text: 'Since March' } as never)
    dispatch({ type: 'chat-live', chat: 'main', piece: 'main:2:1', end: true } as never)
    off1()
    off2()
    expect(live).toEqual([
      { chat: 'main', piece: 'main:2:1', text: 'Since March', end: false },
      { chat: 'main', piece: 'main:2:1', text: undefined, end: true },
    ])
    expect(all).toEqual([])
  })
})

describe('citations in a reply read inline', () => {
  const css = (f: string) => readFileSync(path.resolve(__dirname, '../../src/styles', f), 'utf8')
  const rule = (text: string, selector: string) => {
    const at = text.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return text.slice(at, text.indexOf('}', at))
  }

  test("a claim's mark is inline in the text's face, so it wraps with the sentence, not a small inline-block", () => {
    const r = rule(css('marks.css'), '.mark[data-mark-look]')
    expect(r).toMatch(/display: inline;/)
    expect(r).toMatch(/font: inherit;/)
    // the status marks' rule it overrides (components.css), which made each cited span an atomic box in a smaller face
    expect(rule(css('components.css'), '.mark')).toMatch(/display: inline-block;/)
  })

  test('a file pointed at in a reply is a small glyph in the line, with no box', () => {
    const r = rule(css('refchip.css'), '.chat-text .chip.refchip-icon')
    expect(r).toMatch(/border: 0;/)
    expect(r).toMatch(/background: none;/)
    expect(r).toMatch(/height: auto;/)
  })
})

describe("main's model", () => {
  test('is the menu\'s choice, else the settings\', else the one its replies came from, else Opus 5.5', () => {
    expect(MAIN_DEFAULT_MODEL).toBe('claude-opus-5-5')
    expect(mainModel(null)).toBe('claude-opus-5-5')
    expect(mainModel({ session: 's', cwd: '/', since: '', model: 'claude-sonnet-5' })).toBe('claude-sonnet-5')
    expect(mainModel({ session: 's', cwd: '/', since: '', model: 'claude-sonnet-5' }, 'claude-opus-5')).toBe('claude-opus-5')
    expect(mainModel({ session: 's', cwd: '/', since: '', model: 'claude-sonnet-5', model_choice: 'claude-fable-5-1' }, 'claude-opus-5')).toBe('claude-fable-5-1')
  })

  describe('at the composer', () => {
    beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
    afterEach(() => {
      unmountAll()
      vi.unstubAllGlobals()
    })

    test('is a menu of the models, and a pick goes to onModel', async () => {
      const picked: string[] = []
      const el = await mount(<Composer model="claude-opus-5-5" models={['claude-opus-5-5', 'claude-sonnet-5']} onModel={(m) => picked.push(m)} effort="high" onEffort={() => undefined} fast={false} onFast={() => undefined} onSend={() => undefined} sending={false} />)
      await settle()
      const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model for main and its threads"]')
      expect(trigger?.textContent).toContain('Opus 5.5')
      await act(async () => trigger!.click())
      await settle()
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]')].find((n) => n.textContent?.includes('Sonnet 5'))
      expect(item).toBeTruthy()
      await act(async () => item!.click())
      await settle()
      expect(picked).toEqual(['claude-sonnet-5'])
    })
  })
})
