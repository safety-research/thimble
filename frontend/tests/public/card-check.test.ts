// The card check as a card shows it (src/lib/cardCheck.ts): a checked card whose record flags numbers its code types
// in, rather than computing them from the data, says so on its check mark, until a fix replaces the code. The records
// are invented, in the shape backend/app/checkstore.py writes. The canvas's search menu counts the checks running and
// words its automatic switch (src/canvas/CheckStatus.tsx). A finished check whose reading ran on the fallback model
// carries the record's note.
import { describe, expect, test } from 'vitest'
import { autoTip, runningChecks } from '../../src/canvas/CheckStatus.tsx'
import { checkOf, typedLine } from '../../src/lib/cardCheck.ts'

const record = (typed?: string[]) => ({
  id: 'chk1',
  status: 'ok',
  started: '2026-09-25T10:00:00Z',
  ended: '2026-09-25T10:00:20Z',
  stages: { render: { status: 'ok', ms: 900, ...(typed ? { typed } : {}) } },
})
const card = (check: object, extra: object = {}) => ({ kind: 'table', title: 'How often did each action work?', code: 'rows = [...]', takeaway: 'Most tries worked.', check, ...extra })

describe('numbers typed into a card', () => {
  test('a checked card with typed numbers carries them, and the hover names the first few', () => {
    const c = checkOf(card(record(['1204', '877', '36', '12', '9001'])))
    expect(c?.state).toBe('checked')
    expect(c?.typed).toEqual(['1204', '877', '36', '12', '9001'])
    expect(typedLine(c!)).toBe(`Its code types in 5 numbers the card shows (${(1204).toLocaleString()}, 877, 36, 12, …) rather than computing them from the data.`)
  })

  test('a card with none says nothing of it, nor does one whose code a fix replaced since', () => {
    const plain = checkOf(card(record()))
    expect(plain?.typed).toBeUndefined()
    expect(typedLine(plain!)).toBe('')
    const fixed = checkOf(
      card(
        { ...record(['1204', '877', '36']), status: 'fixed' },
        { code: 'df = load()', fixes: [{ id: 'f1', state: 'applied', fields: ['code'], before: { code: 'rows = [...]' }, after: { code: 'df = load()' }, ts: '2026-09-25T10:00:20Z', reason: 'typed counts' }] },
      ),
    )
    expect(fixed?.fix?.fields).toEqual(['code'])
    expect(fixed?.typed).toBeUndefined()
  })
})

describe('a reading that ran on the fallback model', () => {
  const note = "Downgrading Opus 5.5 to Opus 4.8"

  test("a finished check carries its record's note, whether it ended well or not", () => {
    expect(checkOf(card({ ...record(), note }))?.note).toBe(note)
    const failed = checkOf(card({ ...record(), status: 'error', reason: 'the model declined to read the card', note }))
    expect(failed?.state).toBe('failed')
    expect(failed?.why).toBe('the model declined to read the card')
    expect(failed?.note).toBe(note)
  })

  test("a running check's note is why it waits, never a fallback line", () => {
    const waiting = checkOf(card({ id: 'chk3', status: 'pending', phase: 'waiting', note: "Anthropic's API is overloaded", started: '2026-09-25T10:01:00Z', stages: {} }))
    expect(waiting?.why).toBe("Anthropic's API is overloaded")
    expect(waiting?.note).toBeUndefined()
    expect(checkOf(card(record()))?.note).toBeUndefined()
  })
})

describe("the card check's part of the canvas's search menu", () => {
  test('counts the cards a check is running on', () => {
    const running = { id: 'chk2', status: 'pending', started: '2026-09-25T10:01:00Z', stages: {} }
    expect(runningChecks([card(running), card(running), card(record()), card({})])).toBe(2)
    expect(runningChecks([])).toBe(0)
  })
  test("the switch's tooltip says what the check does, what off means, and why it cannot run", () => {
    expect(autoTip(true, '')).toMatch(/revised in place/)
    expect(autoTip(false, '')).toMatch(/^Off: a card is checked when you click/)
    expect(autoTip(true, 'no Chromium')).toBe('No card can be drawn here, so no check can finish: no Chromium')
  })
})
