// What Claude's tool calls read of the data files (SPEC-v2 3.9): a Read by its result's type, Bash readers and searches
// (none for ls/find/fd, one folder fact for a recursive grep), with the facts on standard input, never the command; a
// refused or failed call gives none; one `act coverage` per turn that has facts. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { CLI, CWD, SID, aTurn, call, corpus, reads, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
type Fact = { path: string; how: string; lines?: number[]; pages?: number[]; total?: number; folder?: boolean; by: string }
const factsOf = (payload: Record<string, unknown> | undefined) => ((payload?.facts ?? []) as Fact[]).map(({ path, how, lines, pages, total, folder, by }) => ({ path, how, ...(lines ? { lines } : {}), ...(pages ? { pages } : {}), ...(total !== undefined ? { total } : {}), ...(folder ? { folder } : {}), by }))

test("a Read's facts by its result: whole, part with its lines, truncated, a PDF whole, a PDF's pages, a binary file searched, an unchanged file none", SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl', 'big.jsonl', 'huge.jsonl', 'paper.pdf', 'scan.pdf', 'forge.db', 'again.jsonl', 'logo.png'])
  reads(w, path => {
    const name = path.split('/').pop()!
    if (name === 'events.jsonl') return { type: 'text', file: { filePath: path, content: 'x', numLines: 40, startLine: 1, totalLines: 40 } }
    if (name === 'big.jsonl') return { type: 'text', file: { filePath: path, content: 'x', numLines: 100, startLine: 201, totalLines: 5000 } }
    if (name === 'huge.jsonl') return { type: 'text', file: { filePath: path, content: 'x', numLines: 2000, startLine: 1, totalLines: 2000, truncatedByTokenCap: true } }
    if (name === 'paper.pdf') return { type: 'pdf', file: { filePath: path, base64: '', originalSize: 10 } }
    if (name === 'scan.pdf') return { type: 'parts', file: { filePath: path, originalSize: 10, count: 5, outputDir: '/tmp/x' }, firstPage: 3, totalPages: 40 }
    if (name === 'again.jsonl') return { type: 'file_unchanged', file: { filePath: path } }
    return { type: 'text', file: { filePath: path, content: '\u0000', numLines: 1, startLine: 1, totalLines: 1 } }
  })
  await startSession($, w)
  await aTurn($, w, 'r1', 'Here is what the files hold.', async () => {
    for (const f of ['events.jsonl', 'big.jsonl', 'huge.jsonl', 'paper.pdf', 'scan.pdf', 'forge.db', 'again.jsonl']) await call($, 'Read', { file_path: `${CWD}/${f}` })
  })
  expect(w.coverage.length).toBe(1)
  expect(factsOf(w.coverage[0])).toEqual([
    { path: 'events.jsonl', how: 'whole', by: 'Read' },
    { path: 'big.jsonl', how: 'part', lines: [201, 300], total: 5000, by: 'Read' },
    { path: 'huge.jsonl', how: 'part', lines: [1, 2000], total: 2000, by: 'Read' },
    { path: 'paper.pdf', how: 'whole', by: 'Read' },
    { path: 'scan.pdf', how: 'part', pages: [3, 7], total: 40, by: 'Read' },
    { path: 'forge.db', how: 'searched', by: 'Read' },
  ])
  expect(w.coverage[0]!.session).toBe(SID)
  expect(w.coverage[0]!.turn).toBe('r1')
})

test("Bash readers and searches give facts; ls, find and fd none; a recursive grep over a folder one folder fact; facts go on stdin, never the command", SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl', 'board.jsonl', 'prs.csv', 'notes.md'])
  w.dirs.add(`${CWD}/agents`)
  reads(w)
  await startSession($, w)
  await aTurn($, w, 'r2', 'Counted.', async () => {
    await call($, 'Bash', { command: 'cat events.jsonl | head -n 3' })
    await call($, 'Bash', { command: 'head -n 5 board.jsonl' })
    await call($, 'Bash', { command: "sed -n '10,20p' prs.csv > /tmp/out.csv" })
    await call($, 'Bash', { command: 'wc -l board.jsonl' })
    await call($, 'Bash', { command: 'ls -la; find . -name "*.jsonl"; fd md' })
    await call($, 'Bash', { command: "grep -rn 'merged' agents/" })
  })
  expect(factsOf(w.coverage[0])).toEqual([
    { path: 'events.jsonl', how: 'whole', by: 'Bash' },
    { path: 'board.jsonl', how: 'part', lines: [1, 5], by: 'Bash' },
    { path: 'prs.csv', how: 'part', lines: [10, 20], by: 'Bash' },
    { path: 'board.jsonl', how: 'searched', by: 'Bash' },
    { path: 'agents', how: 'searched', folder: true, by: 'search' },
  ])
  const run = w.calls.find(c => c[1] === 'act' && c[2] === 'coverage')!
  expect(run).toEqual([CLI, 'act', 'coverage', '--cwd', CWD, '--stdin'])
  expect(JSON.stringify(w.coverage)).not.toContain('merged')
})

test('a refused or failed call gives no fact; a turn without facts sends none; one act coverage per turn that has some', SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl', 'prs.csv', 'secret.csv'])
  reads(w)
  await startSession($, w)
  w.toolAnswer = e =>
    e.file_path === `${CWD}/events.jsonl` ? { isError: true, result: 'boom', text: 'boom' } : e.file_path === `${CWD}/secret.csv` ? { deny: 'not that one' } : { result: { type: 'text', file: { numLines: 1, startLine: 1, totalLines: 1 } }, text: 'ok' }
  await aTurn($, w, 'r4', 'It failed.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
    await call($, 'Read', { file_path: `${CWD}/secret.csv` })
  })
  expect(w.coverage.length).toBe(0)
  await aTurn($, w, 'r5', 'Nothing read.')
  expect(w.coverage.length).toBe(0)
  await aTurn($, w, 'r6', 'Read twice.', async () => {
    await call($, 'Read', { file_path: `${CWD}/prs.csv` })
    await call($, 'Read', { file_path: `${CWD}/prs.csv` })
  })
  expect(w.coverage.length).toBe(1)
  expect(factsOf(w.coverage[0]).length).toBe(2)
})
