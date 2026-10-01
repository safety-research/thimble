import { expect, test } from 'vitest'
import { pdfPageMarks } from '../../src/files/Reader'
import type { Concept, LabelsForPath } from '../../src/lib/types'

const label = (id: string, name: string, labels: string[], extra: Partial<Concept> = {}) => ({ id, name, labels, unit: 'record', ...extra }) as unknown as Concept

test('a label over records lists the pages of the PDF its highlighted value marks, and a verdict wins', () => {
  const refunds = label('k1', 'Refund pages', ['refund', 'other'])
  const tone = label('k2', 'Tone', ['calm', 'angry', 'neutral'])
  const whole = label('k3', 'Whole file', ['yes', 'no'], { marks: 'file' } as unknown as Partial<Concept>)
  const rows: LabelsForPath[] = [
    { concept_id: 'k1', name: 'Refund pages', labels: ['refund', 'other'], unit: 'record', rows: [
      { ref: 'docs/report.pdf#p7', label: 'refund', confidence: 1, source: 'regex' },
      { ref: 'docs/report.pdf#p2', label: 'refund', confidence: 1, source: 'regex' },
      { ref: 'docs/report.pdf#p3', label: 'other', confidence: 1, source: 'regex' },
      { ref: 'docs/report.pdf#p4', label: 'other', confidence: 1, source: 'regex', analyst: 'refund' },
    ] } as unknown as LabelsForPath,
    { concept_id: 'k2', name: 'Tone', labels: ['calm', 'angry', 'neutral'], unit: 'record', rows: [
      { ref: 'docs/report.pdf#p5', label: 'angry', confidence: 1, source: 'model' },
    ] } as unknown as LabelsForPath,
  ]
  const got = pdfPageMarks([refunds, tone, whole], rows, 'docs/report.pdf')
  expect(got.map((m) => [m.name, m.pages])).toEqual([['Refund pages', [2, 4, 7]], ['Tone · angry', [5]]])
})
