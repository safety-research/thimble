// @vitest-environment jsdom
// A record's label gutter in the reader (src/files/views/common.tsx RecordCard, LaneGutter, LaneHead): a column per
// label that is on, in the order they were turned on, filled with the record's class colour of that label, a file
// label's with the file's; the head's marks (a square, the label glyph for a multi-class label) name them; the focused label's texts are filled and the others'
// underlined. The records and labels are invented.
import { afterEach, describe, expect, test } from 'vitest'
import { laneTags } from '../../src/files/labels.ts'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import { BlockEl, LaneHead, RecordCard } from '../../src/files/views/common.tsx'
import type { Concept, LabelRow } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const PATH = 'wiki/changelog.jsonl'
const C = (name: string, color: number) => ({ name, color, highlight: color > 0 })
const label = (id: string, name: string, classes: ReturnType<typeof C>[], marks: 'record' | 'span' | 'file'): Concept =>
  ({ id, name, unit: marks === 'file' ? 'agent' : 'record', marks, labels: classes.map((c) => c.name), classes, shown: true }) as unknown as Concept
const save = label('k1', 'kind of save', [C('question post', 2), C('notice page', 3), C('other', 0)], 'record')
const time = label('k2', 'time reference', [C('task clock', 1), C('container UTC', 3), C('none', 0)], 'span')
const round = label('k3', 'names a round', [C('names a round', 4), C('no match', 0)], 'span')
const wiki = label('k4', 'wiki kind', [C('talk', 6), C('other', 0)], 'file')
const row = (value: string, spans?: string[]): LabelRow => ({ ref: `${PATH}#L7`, label: value, confidence: null, source: null, spans })
const rows = new Map([[`${PATH}#L7`, new Map([['k1', row('other')], ['k2', row('task clock', ['task 07:41'])], ['k3', row('names a round', ['R5'])]])]])
const lanes = [time, save, round, wiki]
const ctx: ReaderLabels = { path: PATH, on: [time, save, round], lanes, focus: 'k2', fileOf: (id) => (id === 'k4' ? { talk: 12 } : undefined), rows, want: () => {} }

afterEach(unmountAll)

describe("a record's label gutter", () => {
  test("a column per label in the order they were turned on: the record's class, empty for a class not highlighted, a file label's value", async () => {
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <RecordCard path={PATH} line={7} target={null} hit={false} header="SectorAgent · 21:43">
          <BlockEl block={{ kind: 'text', text: 'R5 due at task 07:41' }} path={PATH} line={7} index={0} target={null} hit={false} />
        </RecordCard>
      </ReaderLabelsContext.Provider>,
    )
    const card = el.querySelector<HTMLElement>('.reader-card')!
    expect(card.classList.contains('has-gutter')).toBe(true)
    const cells = [...card.querySelectorAll<HTMLElement>('.reader-gutter-cell')]
    expect(cells.map((c) => [c.title, c.style.background])).toEqual([
      ['time reference: task clock', 'var(--label-1)'],
      ['kind of save', ''],
      ['names a round: names a round', 'var(--label-4)'],
      ['wiki kind: talk', 'var(--label-6)'],
    ])
    const spans = [...card.querySelectorAll<HTMLElement>('.reader-span')].map((s) => [s.textContent, s.classList.contains('is-under')])
    expect(spans).toEqual([
      ['R5', true],
      ['task 07:41', false],
    ])
  })

  test("with no label on a record has no gutter; the head holds each label's mark, a multi-class label's in no colour and numbered among them", async () => {
    const el = await mount(
      <ReaderLabelsContext.Provider value={{ ...ctx, on: [], lanes: [] }}>
        <RecordCard path={PATH} line={7} target={null} hit={false} header="h" />
      </ReaderLabelsContext.Provider>,
    )
    expect(el.querySelector('.reader-gutter')).toBeNull()
    expect(el.querySelector('.reader-card')!.classList.contains('has-gutter')).toBe(false)
    const head = await mount(<LaneHead tags={laneTags(lanes)} />)
    const tags = [...head.querySelectorAll<HTMLElement>('.reader-lanehead-tag')]
    expect(tags.map((t) => t.textContent)).toEqual(['1', '2', '', ''])
    const marks = tags.map((t) => t.querySelector<HTMLElement | SVGElement>('.files-label-tag, .files-label-box')!)
    expect(marks.map((m) => [m.classList.contains('files-label-tag') ? 'glyph' : 'square', m.classList.contains('on'), m.style.getPropertyValue('--c')])).toEqual([
      ['glyph', true, ''],
      ['glyph', true, ''],
      ['square', true, 'var(--label-4)'],
      ['square', true, 'var(--label-6)'],
    ])
  })
})
