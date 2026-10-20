// The watching hook (hooks/kernel.ts): what it keeps of a Read, a Grep and a Bash call, and that it never changes a
// call's result. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { grepHits, readRange } from '../hooks/kernel'

test('readRange reads the first and last line a Read result shows', () => {
  expect(readRange('     3\t{"a": 1}\n     4\t{"a": 2}\n')).toEqual({ from: 3, to: 4 })
  expect(readRange('12→one\n13→two')).toEqual({ from: 12, to: 13 })
  expect(readRange('a picture')).toBe(null)
})

test('grepHits reads files and lines from each output mode', () => {
  expect(grepHits('Found 2 files\n/d/a.jsonl\n/d/b.md\n').files).toEqual(['/d/a.jsonl', '/d/b.md'])
  const content = grepHits('/d/a.jsonl:12:{"x": "PRECISION ALERT"}\n/d/a.jsonl-13-context\n/d/b.md:4:hi')
  expect(content.files).toEqual(['/d/a.jsonl', '/d/b.md'])
  expect(content.lines).toEqual({ '/d/a.jsonl': [12, 13], '/d/b.md': [4] })
  expect(grepHits('/d/a.jsonl:7').files).toEqual(['/d/a.jsonl'])
})

test('a Read, a Grep and a Bash call are kept under the session; the results reach the model unchanged', async ($, on) => {
  const files: Record<string, string> = {}
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  mock.env(on, { THIMBLE_HOME: '/th', HOME: '/home/t' })
  const env: Record<string, string | undefined> = {}
  on('env.set', (_$, e) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/data' }))
  on('tool.call', (_$, e) => {
    if (String(e.tool) === 'Read') return { result: '     3\tone\n     4\ttwo\n' }
    if (String(e.tool) === 'Grep') return { result: '/data/a.jsonl:9:hit' }
    return { result: 'one\ntwo\nthree\n' }
  })
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: true } as never)
  const read = await $.tool.call({ tool: 'Read', file_path: '/data/a.jsonl', offset: 3, limit: 2 } as never)
  expect(read.result).toBe('     3\tone\n     4\ttwo\n')
  await $.tool.call({ tool: 'Grep', pattern: 'hit', path: '/data', output_mode: 'content', '-n': true } as never)
  await $.tool.call({ tool: 'Bash', command: 'head -3 events.jsonl' } as never)
  const kept = Object.entries(files).find(([p]) => p.startsWith('/th/lean/seen/'))
  expect(kept).toBeDefined()
  const rows = kept![1].trim().split('\n').map(l => JSON.parse(l))
  expect(rows.map(r => r.tool)).toEqual(['Read', 'Grep', 'Bash'])
  expect(rows[0]).toMatchObject({ file: '/data/a.jsonl', from: 3, to: 4 })
  expect(rows[1]).toMatchObject({ path: '/data', mode: 'content', files: ['/data/a.jsonl'], lines: { '/data/a.jsonl': [9] } })
  // the lines the command printed, so coverage counts a file it printed as read for no more lines than reached Claude
  expect(rows[2]).toMatchObject({ command: 'head -3 events.jsonl', out_lines: 3 })
  expect(String(rows[0].cwd)).toBe('/data')
  expect(kept![0]).toBe('/th/lean/seen/s-1.jsonl')
  expect(env.THIMBLE_SESSION).toBe('s-1')
})
