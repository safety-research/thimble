// A made-up built view of the size a builder reaches on a large wiki (tens of thousands of changes on thousands of
// lanes, rows.json in parts): changes of pages by labels on a lane per label and page, grouped by label, a strip over
// the lanes, and a table of the revisions. The header counts revisions and deletions; the changes also hold bundles,
// which the header does not count.
import type { Row, ViewData, ViewSpec } from '../hooks/viewspec'

export function largeView(changes = 40000, lanes = 4000): { spec: ViewSpec; data: ViewData } {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const t0 = Date.parse('2026-05-24T06:00:00Z')
  const laneRows: Row[] = []
  for (let i = 0; i < lanes; i++) {
    const label = `AgentLabel${String(Math.floor(i / 10)).padStart(3, '0')}`
    const page = `wiki/${['Main', 'Sandbox', 'StateSequence', 'HealthSequenceCollab'][i % 4]}Page${i}Mar08Live`
    laneRows.push({ key: `${label}|${page}`, ref: `revisions.jsonl#L${i + 1}`, title: `${label} on ${page}`, label, name: page.slice(5), revs: 1 + (i % 7) })
  }
  const rows: Row[] = []
  for (let i = 0; i < changes; i++) {
    const lane = laneRows[Math.floor(rand() * lanes)]!
    const kind = i % 9 === 0 ? 'deletion' : i % 3 === 0 ? 'bundle' : 'revision'
    rows.push({
      key: `c${i}`,
      ref: `revisions.jsonl#L${i + 1}`,
      title: `rev ${i} by ${String(lane.label)} · ${String(lane.name)}`,
      time: new Date(t0 + Math.floor(rand() * 50 * 86400) * 1000).toISOString(),
      kind,
      lane: String(lane.key),
      by: String(lane.label),
      page: `wiki/${String(lane.name)}`,
      summary: ['*', 'Real edit', 'adding public data references and links', 'ref2', 'Relay test'][i % 5]!,
      body: `= ${String(lane.name)} =\n${'text of the revision '.repeat(8)}`,
    })
  }
  const spec: ViewSpec = {
    version: 1,
    name: 'Agent Wiki Pages',
    slug: 'agent-wiki-pages',
    description: 'Which label wrote which page, and when.',
    scope: ['revisions.jsonl'],
    collections: [
      {
        name: 'changes',
        one: 'a revision, a deletion, or a bundle of other labels’ revisions on a lane',
        key: 'key',
        title: 'title',
        fields: [
          { name: 'key', type: 'text' },
          { name: 'ref', type: 'ref' },
          { name: 'title', type: 'text' },
          { name: 'time', type: 'time' },
          { name: 'kind', type: 'category' },
          { name: 'lane', type: 'text', link: 'lanes' },
          { name: 'by', type: 'text' },
          { name: 'page', type: 'text' },
          { name: 'summary', type: 'text' },
          { name: 'body', type: 'text' },
        ],
        detail: { fields: ['page', 'by', 'lane', 'time', 'kind'], text: 'body' },
      },
      {
        name: 'lanes',
        one: 'a label and a page it saved',
        key: 'key',
        title: 'title',
        fields: [
          { name: 'key', type: 'text' },
          { name: 'ref', type: 'ref' },
          { name: 'title', type: 'text' },
          { name: 'label', type: 'category' },
          { name: 'name', type: 'text' },
          { name: 'revs', type: 'number' },
        ],
        detail: { fields: ['label', 'name', 'revs'] },
      },
    ],
    stats: [
      { label: 'lanes', collection: 'lanes', agg: 'count' },
      { label: 'revisions', collection: 'changes', agg: 'count', where: { field: 'kind', is: 'revision' } },
      { label: 'deletions', collection: 'changes', agg: 'count', where: { field: 'kind', is: 'deletion' } },
    ],
    tabs: [
      {
        name: 'Labels',
        collection: 'changes',
        overview: { kind: 'histogram', time: 'time', color: 'kind' },
        zoom: 'a click on the strip narrows the lanes to that stretch of time',
        filter: { fields: ['kind'], search: ['title', 'summary', 'body'] },
        body: [{ kind: 'lanes', lane: 'lane', time: 'time', color: 'kind', lanes: { collection: 'lanes', label: 'name', group: 'label', meta: ['revs'] } }],
      },
      {
        name: 'Revisions',
        collection: 'changes',
        where: { field: 'kind', is: ['revision', 'deletion'] },
        overview: { kind: 'histogram', time: 'time', color: 'kind' },
        zoom: 'a click on the strip narrows the list to that stretch of time',
        filter: { fields: ['kind'], search: ['title', 'summary', 'body'] },
        body: [{ kind: 'table', columns: [{ field: 'time' }, { field: 'by' }, { field: 'page' }, { field: 'summary' }], sort: { field: 'time' } }],
      },
    ],
  }
  return { spec, data: { collections: { changes: rows, lanes: laneRows }, files: 1 } }
}
