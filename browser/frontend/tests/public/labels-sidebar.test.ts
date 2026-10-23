// The Labels sidebar (src/shell/LabelsSidebar.tsx): it lists every label but a trial, says where each shows, and says
// what made each and what it applies as its definition.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { howMade, labelDefinition } from '../../src/files/labels'
import { labelSurface, listedLabels } from '../../src/shell/LabelsSidebar'
import type { Concept } from '../../src/lib/types'

const k = (id: string, rest: Partial<Concept> = {}) => ({ id, name: id, unit: 'line', kind: 'regex', spec: 'refund', description: '', ...rest }) as unknown as Concept

test('lists every label but a trial, and shows each where it labels', () => {
  const all = new Map([['a', k('a')], ['b', k('b', { trial: true })], ['c', k('c', { unit: 'cell' })]])
  expect(listedLabels(all).map((x) => x.id)).toEqual(['a', 'c'])
  expect(labelSurface(k('x'))).toBe('files')
  expect(labelSurface(k('x', { unit: 'cell' }))).toBe('cards')
  expect(labelSurface(k('x', { unit: 'span' }))).toBe('report')
})

test('says what made a label and shows its definition', () => {
  expect([howMade('regex'), howMade('code'), howMade('prompt')]).toEqual(['regex', 'code', 'read by Claude'])
  expect(labelDefinition(k('x'))).toBe('refund')
  expect(labelDefinition(k('x', { kind: 'prompt', description: 'Asks for money back.', spec: 'old' }))).toBe('Asks for money back.')
})

test("keeps the line breaks of a definition written as a list", () => {
  const css = readFileSync(path.resolve(__dirname, '../../src/styles/side.css'), 'utf8')
  const at = css.indexOf('\n.lside-question {')
  expect(css.slice(at, css.indexOf('}', at))).toMatch(/white-space: pre-line/)
})
