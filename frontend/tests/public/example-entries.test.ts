// An example card's refs as its entries (src/canvas/quotes.ts exampleEntries, entryParts): refs that name one record
// are one entry, which shows that record once with every quoted passage highlighted; refs of different records stay
// one entry each, as they were.
import { describe, expect, test } from 'vitest'
import { entryParts, exampleEntries, exampleQuotes, type QuotePart } from '../../src/canvas/quotes.ts'
import type { ResolvedRef } from '../../src/lib/types.ts'

const LONG =
  'Here is the plan for Saturday. We meet at the north gate of Willow Park at eleven. Maya brings two folding tables and the striped blanket. ' +
  'For food we have sandwiches, a pasta salad and lemonade, and Priya offered to bake a lemon cake. The bins by the gate close at six, so we start packing up at half past five.'
const step = (content: string) => ({ role: 'user', content })
const pointer = (ref: string, record: unknown): ResolvedRef => ({ ref, kind: 'pointer', path: 'plan.json', record, blocks: [{ kind: 'raw', text: JSON.stringify(record, null, 2) }], excerpt: '' }) as unknown as ResolvedRef
const RECORDS: Record<string, ResolvedRef> = {
  'plan.json#/steps/0': pointer('plan.json#/steps/0', step(LONG)),
  'plan.json#/steps/1': pointer('plan.json#/steps/1', step('I will bring the ice.')),
}
const got = (r: string) => RECORDS[r]
/** each highlighted passage of the parts, in order */
const marked = (parts: QuotePart[] | null) => (parts ?? []).flatMap((p) => ('marks' in p && p.marks ? p.marks.map(([a, b]) => p.text.slice(a, b)) : []))

describe('example entries', () => {
  test('three quotes of one JSON value are one entry with three highlights', () => {
    const quotes = ['north gate of Willow Park', 'Priya offered to bake a lemon cake', 'start packing up at half past five']
    const entries = exampleEntries(['plan.json#/steps/0', 'plan.json#/steps/0', 'plan.json#/steps/0'], quotes)
    expect(entries).toHaveLength(1)
    expect(entries[0].ref).toBe('plan.json#/steps/0')
    expect(marked(entryParts(entries[0], got))).toEqual(quotes)
  })
})

describe("a database row's fields, those the card's claim is about first (bug hunt B17)", () => {
  const row = (ref: string, table: string, record: Record<string, unknown>): ResolvedRef =>
    ({ ref, kind: 'row', path: 'runs/s3/forge.db', table, record, excerpt: JSON.stringify(record) }) as unknown as ResolvedRef
  const PR = 'runs/s3/forge.db#prs/66972'
  const REVIEW = 'runs/s3/forge.db#reviews/14'
  const ROWS: Record<string, ResolvedRef> = {
    [PR]: row(PR, 'prs', { number: 66972, body: '- [ ] closes #66675\r\n\r\n- [x] I used AI to develop this pull request.', title: 'DEPS: Remove hypothesis', author: 'gh:mroeschke', state: 'merged', claimed_by: 'agent-16', merged_by: 'agent-16' }),
    [REVIEW]: row(REVIEW, 'reviews', { id: 14, pr: 66972, created_at: '2026-08-28T22:32:26Z', verdict: 'approve', reviewer: 'agent-16', body: 'Reviewed: verified clean merge onto current main and ran the full set of touched test modules.' }),
  }
  const words = 'What do merges look like when one agent claimed and merged a PR alone? Agent-16 wrote the only review.'
  const kinds = (parts: QuotePart[] | null) => (parts ?? []).map((p) => (p.kind === 'field' ? `field ${p.key}` : p.kind === 'fields' ? `fields ${p.pairs.map(([k]) => k).join(' ')}` : p.kind))

  test('the value its takeaway cites first, under its name; the fields its words name first on the fields line; the body with its line ends', () => {
    const [e] = exampleEntries([PR], [''])
    const parts = entryParts(e, (r) => ROWS[r], { said: ['"DEPS: Remove hypothesis"'], words })
    expect(kinds(parts)).toEqual(['field title', 'fields claimed_by merged_by number author state', 'field body'])
    const body = parts!.find((p) => p.kind === 'field' && p.key === 'body') as Extract<QuotePart, { kind: 'field' }>
    expect(body.text).toBe('- [ ] closes #66675\n\n- [x] I used AI to develop this pull request.')
  })

  test('the words it quotes from a review: that field first, marked; the reviewer its words name first on the line', () => {
    const [e] = exampleEntries([REVIEW], ['verified clean merge'])
    const parts = entryParts(e, (r) => ROWS[r], { words })
    expect(kinds(parts)).toEqual(['field body', 'fields reviewer id pr created_at verdict'])
    expect(marked(parts)).toEqual(['verified clean merge'])
  })
})

describe("a markdown chat log's line, quoted (bug hunt D9)", () => {
  // `**R3:** …` showed as `**R3:** I could not find…`: the speaker's markdown kept, as the Transcript mode no longer shows it
  const LINE = '**R3:** I could not find the *stop* button. It sat under [the menu](https://example.org) somewhere.'
  const turn = { speaker: 'R3', at: 8 }
  const span = (start: number, end: number): ResolvedRef =>
    ({ ref: `R3/notes.md#L12.b0:c${start}-${end}`, kind: 'span', path: 'R3/notes.md', line: 12, block: 0, start, end, blocks: [{ kind: 'text', text: LINE }], excerpt: LINE.slice(start, end), meta: { turn } }) as unknown as ResolvedRef

  test("a passage of a speaker's line shows under the speaker's name, the words around it without markdown", () => {
    const at = LINE.indexOf('It sat')
    const r = span(at, LINE.length)
    const [part] = entryParts(exampleEntries([r.ref])[0], () => r)!
    expect(part).toEqual({ kind: 'span', key: 'R3', before: 'I could not find the stop button. ', text: 'It sat under the menu somewhere.', after: '' })
  })

  test("a speaker's whole line shows its words under the speaker's name, on one line", () => {
    const r = { ...span(0, 0), ref: 'R3/notes.md#L12', kind: 'record' } as unknown as ResolvedRef
    expect(entryParts(exampleEntries([r.ref])[0], () => r)).toEqual([{ kind: 'field', key: 'R3', text: 'I could not find the stop button. It sat under the menu somewhere.' }])
  })
})

describe("a wiki save's edit summary, which its blocks leave out (bug hunt J6)", () => {
  // the card showed the save's page text and not its summary, so a true quote of the summary read as unconfirmed
  const record = { rev_id: 'Tomatoes@4', name: 'Tomatoes', label: 'Rowan', time: '2026-05-02T09:20:00Z', body: '= Tomatoes =\nPlant them out after the last frost.', change_summary: 'undo the seed shop advert' }
  const save = { ref: 'revisions.jsonl#L2', kind: 'record', path: 'revisions.jsonl', line: 2, record, blocks: [{ kind: 'text', text: record.body }], excerpt: record.body, meta: {}, fields: [{ key: 'change_summary', text: record.change_summary }] } as unknown as ResolvedRef

  test('the summary shows under its name before the page text, the words the card quotes from it marked', () => {
    const [e] = exampleEntries([save.ref], ['undo the seed shop advert'])
    const parts = entryParts(e, () => save)!
    expect(parts.map((p) => (p.kind === 'field' ? `field ${p.key}` : p.kind))).toEqual(['field change_summary', 'text'])
    expect(marked(parts)).toEqual(['undo the seed shop advert'])
  })
})

describe("a quote inside a JSON record's list or object (bug hunt round 10, K3)", () => {
  // the card showed `id`, `role` and `content` cut after one line, and never the vote the quote came from
  const command = "cat >> NOTES.md <<'EOF'\n## Picnic, Saturday\n\nThe north gate of Willow Park, at eleven.\n\n`CHOICE: north gate` — Rowan\n\n(Maya brings the tables.)\nEOF"
  const message = { id: 'm7', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Bash', input: { command, description: 'Add my choice' } }], first_seen_ts: 1782799367.69 }
  const QUOTE = '`CHOICE: north gate` — Rowan'

  test("a message the server reads as a tool call shows the call's command, the quoted words marked in it", () => {
    const r = { ref: 'chat.json#/messages/m7', kind: 'pointer', path: 'chat.json', record: message, blocks: [{ kind: 'tool_use', text: `Bash\n${JSON.stringify({ command, description: 'Add my choice' }, null, 2)}` }], excerpt: '' } as unknown as ResolvedRef
    const parts = entryParts(exampleEntries([r.ref], [QUOTE])[0], () => r)!
    expect(parts.map((p) => p.kind)).toEqual(['tool'])
    expect(marked(parts)).toEqual([QUOTE])
  })

  test("a record kept as its JSON shows the value that holds the quote, decoded, with the words around it, before its fields", () => {
    const r = pointer('chat.json#/messages/m7', message)
    const parts = entryParts(exampleEntries([r.ref], [QUOTE])[0], () => r)!
    expect(parts[0]).toMatchObject({ kind: 'span', key: 'command', text: QUOTE })
    expect((parts[0] as { before: string }).before).not.toContain('\\n')
    expect(parts.at(-1)?.kind).toBe('fields')
  })
})

describe('an example whose refs name only lines, its quotes in its takeaway (bug hunt L5)', () => {
  // each record drew from its start: the quoted error of a tool's output sat behind Show all, nothing marked
  const result =
    '<counter>42</counter> wren@shed:/tmp/pkg$\n' + '/usr/bin/kettle\n'.repeat(14) + 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nModuleNotFoundError: No module named \'gizmo\'\n<counter>43</counter> wren@shed:/tmp/pkg$'
  const command = 'which kettle; python3 -c "import gizmo"'
  const REC = {
    ref: 'shed/log.jsonl#L62',
    kind: 'record',
    path: 'shed/log.jsonl',
    line: 62,
    record: { record: 'message', tool_name: 'terminal', tool_call: { text: command }, tool_result: result },
    blocks: [{ kind: 'text', text: command }],
    fields: [{ key: 'tool_result', text: result }],
    excerpt: command,
  } as unknown as ResolvedRef
  const takeaway = 'Python gave [["ModuleNotFoundError: No module named \'gizmo\'"|shed/log.jsonl#L62]], and [[the gate|shed/log.jsonl#L4]] stayed shut.'

  test("a ref's quote is the takeaway's quote of its record, where add_card kept none; a span keeps its own", () => {
    expect(exampleQuotes(['shed/log.jsonl#L62', 'shed/log.jsonl#L4', 'shed/log.jsonl#L62.b0:c1-5'], ['', '', ''], takeaway)).toEqual(["ModuleNotFoundError: No module named 'gizmo'", '', ''])
    expect(exampleQuotes(['shed/log.jsonl#L62'], ['kept words'], takeaway)).toEqual(['kept words'])
  })

  test("the record's part that holds the takeaway's quote is marked there, so its fold opens at it", () => {
    const [e] = exampleEntries([REC.ref], exampleQuotes([REC.ref], [], takeaway))
    const parts = entryParts(e, () => REC)!
    expect(marked(parts)).toEqual(["ModuleNotFoundError: No module named 'gizmo'"])
    const field = parts.find((p) => p.kind === 'field' && p.key === 'tool_result') as Extract<QuotePart, { kind: 'field' }>
    expect(field.marks).toHaveLength(1)
  })
})
