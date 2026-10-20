// The line under a finished reply (src/chat/usage.tsx): the turn's model and token use from its `done` record, which
// foldRecords puts on the turn's last text row.
import { describe, expect, test } from 'vitest'
import { foldRecords, type TextRow } from '../../src/chat/model'
import { tokens, usageLine, usageTip } from '../../src/chat/usage'
import type { ChatRecord } from '../../src/lib/types'

const usage = { input_tokens: 1200, output_tokens: 2812, cache_read_input_tokens: 102_400, cache_creation_input_tokens: 2900, requests: 3 }

describe('the usage line', () => {
  test('counts in a few characters', () => {
    expect([tokens(940), tokens(2812), tokens(10_000), tokens(102_400), tokens(1_250_000)]).toEqual(['940', '2.8k', '10k', '102k', '1.3M'])
  })

  test('names the model, the new input, the cached input and the output', () => {
    expect(usageLine({ ...usage, model: 'claude-opus-5-5' })).toBe('Opus 5.5 · 4.1k in · 102k cached · 2.8k out')
    expect(usageLine({ ...usage, cache_read_input_tokens: 0 })).toBe('4.1k in · 2.8k out')
    expect(usageTip({ ...usage, model: 'claude-opus-5-5' })).toContain('3 requests to Claude')
  })

  test("goes on the turn's last text row, not on an earlier turn's", () => {
    const recs: ChatRecord[] = [
      { type: 'user', text: 'first' },
      { type: 'text', delta: 'One.' },
      { type: 'done', usage, model: 'claude-opus-5-5' },
      { type: 'user', text: 'second' },
      { type: 'text', delta: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_result', id: 't1', summary: 'ok' },
      { type: 'text', delta: 'Two.' },
      { type: 'done', usage: { ...usage, output_tokens: 10 }, model: 'claude-opus-5-5' },
    ] as ChatRecord[]
    const texts = foldRecords(recs).filter((r): r is TextRow => r.kind === 'text')
    expect(texts.map((t) => [t.text, t.usage?.output_tokens ?? null])).toEqual([['One.', 2812], ['Looking.', null], ['Two.', 10]])
  })
})
