// @vitest-environment jsdom
// Where a label's values come from, as the canvas's label card and the label's edit card say it (src/canvas/details.ts
// labelIdentity, src/files/LabelCard.tsx): the card's label line names the classifier in plain words, a rule over the
// data or a model's judgment, how many records it ran over and where, and the label it ran within; and the class
// switches are headed by what they do, paint values in Files, which changes nothing of the label.
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { classifierWords, labelIdentity } from '../../src/canvas/details.ts'
import { LabelCard, PAINT_TIP } from '../../src/files/LabelCard.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('a label card names a rule over the data apart from a model judgment, with what each ran over', () => {
  expect(classifierWords('code')).toBe('Code rule')
  expect(classifierWords('regex')).toBe('Regex rule')
  expect(classifierWords('prompt', 'Opus 5.5')).toBe('Opus 5.5 judgment (prompt)')
  expect(classifierWords('prompt')).toBe('Model judgment (prompt)')

  // a code rule over every record of its files
  const rule = labelIdentity({ kind: 'code', unit: 'record', glob: 'pool/*.jsonl', n_labeled: 76971, counts: {} })
  expect([rule.how, rule.where]).toEqual(['Code rule', 'over 76,971 records in pool/*.jsonl'])
  // a prompt label that ran only over the records the rule kept
  const judged = labelIdentity({ kind: 'prompt', unit: 'record', glob: 'pool/*.jsonl', n_labeled: 1126, counts: {}, within: { label: 'k1', value: 'kept' } }, 'Opus 5.5', 'kept by request-type rule')
  expect([judged.how, judged.where]).toEqual(['Opus 5.5 judgment (prompt)', 'over 1,126 records where ‘kept by request-type rule’ is ‘kept’, in pool/*.jsonl'])
  // a trial, and a label not run yet
  expect(labelIdentity({ kind: 'prompt', unit: 'record', glob: 'a.jsonl', n_labeled: 40, counts: {}, trial: true }).where).toBe('over a sample of 40 records in a.jsonl')
  expect(labelIdentity({ kind: 'regex', unit: 'record', glob: 'a.jsonl', counts: {} }).where).toBe('in a.jsonl')
  // a label over canvas cards
  expect(labelIdentity({ kind: 'prompt', unit: 'cell', n_labeled: 3, counts: {} }).where).toBe('over 3 cards on the canvas')
})

test('the class switches are headed "paint in Files", which says they color values and change nothing of the label', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))
  const labels = { all: [], on: [], focus: null, byId: new Map(), presence: new Map(), toggle: () => undefined, save: async () => undefined, remove: async () => undefined } as unknown as FilesLabels
  const el = await mount(<LabelCard ws="w" label={null} labels={labels} appliesTo={['a.jsonl']} onClose={() => undefined} onRun={() => undefined} />)
  await settle()
  expect(el.querySelector('.label-card-classes-head .label-card-hl')?.textContent).toBe('paint in Files')
  expect([...el.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label'))).toEqual(['Paint match in Files', 'Paint no match in Files'])
  expect(PAINT_TIP).toMatch(/colored .* Files and views/)
  expect(PAINT_TIP).toMatch(/does not change the label or its counts/)
})
