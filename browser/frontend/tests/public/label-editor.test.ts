// The label editor's Run (src/files/LabelCard.tsx, src/files/labels.ts): a press of Re-run right after typing in the
// definition lands on the button, and a label described with no files chosen applies to every file.
import { describe, expect, test } from 'vitest'
import { bodyClamped } from '../../src/files/LabelCard'
import { draftBody } from '../../src/files/labels'
import type { LabelDraft } from '../../src/lib/types'

describe('the label editor', () => {
  test('keeps the definition open while a draft changes the label, so the card does not shrink under Re-run', () => {
    // typed, then the press on Re-run takes the focus: the body must not clamp and move the button
    expect(bodyClamped(true, false, true)).toBe(false)
    expect(bodyClamped(true, true, false)).toBe(false)
    expect(bodyClamped(true, false, false)).toBe(true)
    expect(bodyClamped(false, false, false)).toBe(false)
  })

  test('gives a label described with no files every file, which its card can narrow', () => {
    const d = { name: 'asks', over: 'files', marks: 'span', glob: '', kind: 'prompt', text: 'Asks a question.', values: ['yes', 'no'] } as unknown as LabelDraft
    expect(draftBody(d, 1).glob).toBe('*')
    expect(draftBody({ ...d, glob: 'runs/*.jsonl' }, 1).glob).toBe('runs/*.jsonl')
  })
})
