// A made-up built view of wiki pages, laid out as the builds the reviews sent back were (long page names, a few short
// columns, a column of tags, a long text column, a detail with a long related section before another): pages with
// their wiki, revision and label counts, first and last write, notes and writers; their revisions and their labels.
import type { Row, ViewData, ViewSpec } from '../hooks/viewspec'

const WORDS = ['Data', 'State', 'Sequence', 'Collab', 'Grocery', 'Live', 'Rounds', 'County', 'Gateway', 'Health', 'Bridge', 'Test', 'Relay', 'Signal', 'Fast', 'Mirror']

export function wikiView(pages = 300): { spec: ViewSpec; data: ViewData } {
  let seed = 11
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
  const day = (d: number) => new Date(Date.parse('2026-05-24T00:00:00Z') + d * 86400000).toISOString()
  const P: Row[] = []
  const R: Row[] = []
  const W: Row[] = []
  for (let i = 0; i < pages; i++) {
    // names of one word, 12 to 34 letters, as a wiki's are
    let name = `Agent${pick(WORDS)}`
    while (name.length < 12 + (i % 23)) name += pick(WORDS)
    name = `${name.slice(0, 30)}${i}`
    const revs = i === 0 ? 2327 : i === 1 ? 1013 : 1 + Math.floor(rand() * 60)
    const labels = Math.min(revs, i === 0 ? 342 : 1 + Math.floor(rand() * 12))
    const first = Math.floor(rand() * 30)
    const notes = i % 5 === 0 ? ['no name', 'existed before'] : i % 3 === 0 ? ['existed before'] : []
    const id = `w/${name}`
    P.push({ id, ref: `pages.jsonl#L${i + 1}`, name, wiki: i % 7 === 0 ? 'probier' : 'dse', revs, labels, first: day(first), last: day(first + (i % 9)), week: `${day(first - (first % 7)).slice(5, 10)} to ${day(first - (first % 7) + 6).slice(5, 10)}`, notes, by: `Writer${i % 13} ${revs} · Helper${i % 5} 2 · Other${i % 3} 1`, bytes: i === 0 ? 13403 : 200 + i })
    for (let k = 0; k < labels; k++) W.push({ id: `${id}|${k}`, page: id, label: `Writer${k}Name`, revisions: labels - k, ref: `pages.jsonl#L${i + 1}` })
    for (let k = 0; k < Math.min(revs, 12); k++) R.push({ id: `${id}@${k + 1}`, page: id, seq: k + 1 + (i === 0 ? 1000 : 0), label: `Writer${k}Name`, bytes: k === 0 && i === 0 ? 13403 : 900 + k * 37, ref: `revisions.jsonl#L${R.length + 1}` })
  }
  const spec = {
    version: 1,
    name: 'Wiki Pages',
    slug: 'wiki-pages',
    description: 'Every wiki page, which labels wrote it and how often.',
    scope: ['pages.jsonl', 'revisions.jsonl'],
    collections: [
      {
        name: 'pages',
        one: 'one wiki page',
        key: 'id',
        title: 'name',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'ref', type: 'ref' },
          { name: 'name', type: 'text', label: 'page' },
          { name: 'wiki', type: 'category' },
          { name: 'revs', type: 'number' },
          { name: 'labels', type: 'number', label: 'named labels' },
          { name: 'first', type: 'time' },
          { name: 'last', type: 'time' },
          { name: 'week', type: 'category', label: 'week first stored', derived: 'computed', from: 'first', how: 'the week it falls in' },
          { name: 'notes', type: 'list', derived: 'computed', from: 'its revisions', how: 'what is unusual about it' },
          { name: 'by', type: 'text', label: 'written by' },
          { name: 'bytes', type: 'number', label: 'body bytes' },
        ],
        detail: {
          meta: ['wiki', 'week'],
          fields: ['first', 'last', 'bytes'],
          related: [
            { title: 'Labels', collection: 'writers', via: 'page', show: { kind: 'table', columns: [{ field: 'label' }, { field: 'revisions' }], sort: { field: 'revisions', desc: true } } },
            { title: 'Revisions', collection: 'revisions', via: 'page', show: { kind: 'table', columns: [{ field: 'seq' }, { field: 'label' }, { field: 'bytes' }] } },
          ],
        },
      },
      {
        name: 'revisions',
        one: 'one stored revision',
        key: 'id',
        title: 'id',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'ref', type: 'ref' },
          { name: 'page', type: 'text', link: 'pages' },
          { name: 'seq', type: 'number' },
          { name: 'label', type: 'text' },
          { name: 'bytes', type: 'number', label: 'body bytes' },
        ],
      },
      {
        name: 'writers',
        one: 'one label on one page',
        key: 'id',
        title: 'label',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'ref', type: 'ref' },
          { name: 'page', type: 'text', link: 'pages' },
          { name: 'label', type: 'text' },
          { name: 'revisions', type: 'number' },
        ],
      },
    ],
    stats: [
      { label: 'pages', collection: 'pages', agg: 'count' },
      { label: 'wikis', collection: 'pages', agg: 'distinct', field: 'wiki' },
    ],
    tabs: [
      {
        name: 'Pages',
        collection: 'pages',
        overview: { kind: 'bars', field: 'week', color: 'wiki' },
        zoom: 'a click on a week keeps its pages',
        filter: { fields: ['wiki', 'notes'], search: ['name'] },
        body: [{ kind: 'table', columns: [{ field: 'name' }, { field: 'wiki' }, { field: 'revs' }, { field: 'labels' }, { field: 'first' }, { field: 'last' }, { field: 'notes', show: 'chips' }], sort: { field: 'revs', desc: true } }],
      },
    ],
    labels: true,
  } as unknown as ViewSpec
  return { spec, data: { collections: { pages: P, revisions: R, writers: W }, problems: [], hidden: [], unplaced: [], files: 2, labels: [] } }
}
