// @vitest-environment jsdom
// A file's Timeline (src/files/views/timeline.tsx) tells its page which labels mark the file's records, as a view's
// pane does (E9): Color by opens on a label that is on only when it gives one of the file's records a value it
// highlights, else on the file's own key (bug hunt G8: it opened on the newest label, over another file, as
// `match 0 · Not marked 23`).
import { afterEach, expect, test, vi } from 'vitest'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { ViewProps } from '../../src/files/views/common.tsx'
import type { Concept } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

let props: { marking?: ReadonlySet<string>; first?: ReadonlySet<string> } | null = null
vi.mock('../../src/files/ViewerFrame', () => ({
  ViewerFrame: (p: { marking?: ReadonlySet<string>; first?: ReadonlySet<string> }) => {
    props = p
    return <div className="stub-frame" />
  },
}))

const { default: timeline } = await import('../../src/files/views/timeline.tsx')

afterEach(() => {
  unmountAll()
  props = null
})

const label = (id: string, name: string): Concept =>
  ({ id, name, unit: 'record', kind: 'code', glob: '*', marks: 'record', labels: ['match', 'no match'], shown: true, classes: [{ name: 'match', color: 1, highlight: true }, { name: 'no match', color: 0, highlight: false }] }) as unknown as Concept

test("Color by may open only on a label that marks the file's records; a label over another file is not one", async () => {
  const host = label('k1', 'host line')
  const step = label('k2', 'tool step')
  const quiet = label('k3', 'quiet one')
  const labels = {
    all: [host, step, quiet],
    on: [host, step, quiet],
    byId: new Map([host, step, quiet].map((k) => [k.id, k])),
    // host line marks only the transcripts; tool step marks this file's records; quiet one only its unhighlighted value
    presence: new Map([
      ['k1', { 'S1/transcript.md': { match: 12 } }],
      ['k2', { 'S1/return/events.jsonl': { match: 4 } }],
      ['k3', { 'S1/return/events.jsonl': { 'no match': 30 } }],
    ]),
  } as unknown as FilesLabels
  const Timeline = timeline.component
  const viewProps = { workspace: 'w', path: 'S1/return/events.jsonl', labels } as unknown as ViewProps
  await mount(<Timeline {...viewProps} />)
  expect(props).not.toBeNull()
  expect([...(props!.marking ?? [])]).toEqual(['k2'])
  expect([...(props!.first ?? [])].sort()).toEqual(['k2', 'k3'])
})
