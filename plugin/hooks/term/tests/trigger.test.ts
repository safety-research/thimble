// The data rule that turns thimble on (SPEC-v2 3.3) and its coverage twin (3.9), over the one case list
// (data-file-cases.ts, which the backend's coverage.is_data reads too): code trees, never-folders and never-names, the
// size rule, json/sqlite/db never by size, a realpath outside the folder; and the files a Bash command reads (readers,
// searches, never an output argument, no fact for ls/find/fd). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { candidatePaths, isDataFile, isDataRead, relInside } from '../activate'
import { bashReads, shellWords } from '../tracker'
import { CASES } from './data-file-cases'

const ROOT = '/corpus/wiki'

test('the trigger table: each case turns thimble on, and counts as data, as the case list says', () => {
  for (const [path, codeTree, size, activates, counts] of CASES) {
    expect(isDataRead(ROOT, `${ROOT}/${path}`, size, codeTree), `isDataRead ${path} (code tree ${codeTree}, ${size} bytes)`).toBe(activates)
    expect(isDataFile(ROOT, path, codeTree), `isDataFile ${path} (code tree ${codeTree})`).toBe(counts)
  }
})

test("a file whose realpath is outside the session folder, or under thimble's home or Claude Code's config folder, never counts", () => {
  expect(isDataRead(ROOT, '/elsewhere/events.jsonl', 10, false)).toBe(false)
  expect(isDataRead(ROOT, '/corpus/wiki-other/events.jsonl', 10, false)).toBe(false)
  expect(isDataRead(ROOT, `${ROOT}/../x/events.jsonl`, 10, false)).toBe(false)
  expect(isDataFile(ROOT, '/elsewhere/events.jsonl', false)).toBe(false)
  expect(relInside(ROOT, `${ROOT}/a/b.csv`)).toBe('a/b.csv')
  expect(relInside(ROOT, 'a/b.csv')).toBe('a/b.csv')
  expect(relInside(ROOT, '../b.csv')).toBe(null)
  // a session folder that holds thimble's home (or Claude Code's) keeps their files out
  expect(isDataRead('/home/a', '/home/a/.thimble/config.json', 10, false, ['/home/a/.thimble'])).toBe(false)
  expect(isDataRead('/home/a/work', '/home/a/work/cc/history.jsonl', 10, false, ['/home/a/work/cc'])).toBe(false)
  expect(isDataRead('/home/a/work', '/home/a/work/runs.jsonl', 10, false, ['/home/a/work/cc'])).toBe(true)
})

test("a Bash command's readers name the files it reads, never an output argument; ls, find and fd read none", () => {
  const paths = (c: string) => bashReads(c).map(r => r.path)
  expect(paths('cat events.jsonl')).toEqual(['events.jsonl'])
  expect(paths('head -n 20 data/a.csv | wc -l')).toEqual(['data/a.csv'])
  expect(paths('jq .id events.jsonl > out.json')).toEqual(['events.jsonl'])
  expect(paths('cat a.csv >> b.csv')).toEqual(['a.csv'])
  expect(paths('cat a.csv | tee copy.csv')).toEqual(['a.csv'])
  // words that are no file (a verb, an option's value) are named too: the stat of each drops them
  expect(paths('mlr --icsv --ojson cat in.csv --output out.json')).toContain('in.csv')
  expect(paths('mlr --icsv --ojson cat in.csv --output out.json')).not.toContain('out.json')
  expect(paths('csvcut -n in.csv -o out.csv')).toEqual(['in.csv'])
  expect(paths('python3 count.py runs/r.jsonl --out=report.json')).toEqual(['count.py', 'runs/r.jsonl'])
  expect(paths('ls -la data')).toEqual([])
  expect(paths('find . -name "*.jsonl"')).toEqual([])
  expect(paths('fd jsonl')).toEqual([])
  expect(paths('cat data/*.jsonl')).toEqual([])
  expect(paths('FOO=1 sudo cat /x/a.csv')).toEqual(['/x/a.csv'])
  expect(paths("grep -c 'merged' board.jsonl")).toEqual(['board.jsonl'])
  expect(paths("rg -n 'x' agents/")).toEqual(['agents/'])
  expect(paths("sqlite3 forge.db 'select count(*) from prs'")).toEqual(['forge.db'])
  // a program's code that names a data file
  expect(paths(`python3 -c "import pandas as pd; pd.read_csv('prs.csv')"`)).toContain('prs.csv')
  expect(paths(`python3 - <<'EOF'\nimport json\nrows = open('events.jsonl').read()\nEOF`)).toContain('events.jsonl')
  expect(shellWords('a "b c" \'d e\' f\\ g | h; i && j')).toEqual([['a', 'b c', 'd e', 'f g'], ['h'], ['i'], ['j']])
})

test('candidates: a Read names its file; a Bash command its readers; no other call names one', () => {
  expect(candidatePaths('Read', { file_path: '/corpus/wiki/events.jsonl' })).toEqual(['/corpus/wiki/events.jsonl'])
  expect(candidatePaths('Bash', { command: 'cat a.csv b.csv > c.csv' })).toEqual(['a.csv', 'b.csv'])
  expect(candidatePaths('Bash', { command: 'ls' })).toEqual([])
  expect(candidatePaths('Grep', { pattern: 'x', path: '.' })).toEqual([])
  expect(candidatePaths('Edit', { file_path: '/corpus/wiki/events.jsonl' })).toEqual([])
})

test('how each reader reads: cat whole, head the first lines, sed -n a range, jq whole only for `.`, wc and grep search, a recursive search over a folder', () => {
  expect(bashReads('cat a.csv')[0]).toMatchObject({ how: 'whole' })
  expect(bashReads('head a.csv')[0]).toMatchObject({ how: 'part', lines: [1, 10] })
  expect(bashReads('head -n 5 a.csv')[0]).toMatchObject({ how: 'part', lines: [1, 5] })
  expect(bashReads('head -20 a.csv')[0]).toMatchObject({ how: 'part', lines: [1, 20] })
  expect(bashReads('tail -n 5 a.csv')[0]).toMatchObject({ how: 'part' })
  expect(bashReads('tail -n 5 a.csv')[0]!.lines).toBeUndefined()
  expect(bashReads("sed -n '10,20p' a.csv")[0]).toMatchObject({ how: 'part', lines: [10, 20] })
  expect(bashReads("sed -n '7p' a.csv")[0]).toMatchObject({ how: 'part', lines: [7, 7] })
  expect(bashReads("sed 's/a/b/' a.csv")[0]).toMatchObject({ how: 'whole' })
  expect(bashReads("sed -i 's/a/b/' a.csv")).toEqual([])
  expect(bashReads('less a.csv')[0]).toMatchObject({ how: 'whole' })
  // jq prints the whole file only with the bare filter `.`; any other filter searches it
  expect(bashReads('jq . a.json')[0]).toMatchObject({ how: 'whole' })
  expect(bashReads("jq -c ' . ' a.json")[0]).toMatchObject({ path: 'a.json', how: 'whole' })
  expect(bashReads('jq --arg k v . a.json').map(r => [r.path, r.how])).toEqual([['a.json', 'whole']])
  expect(bashReads('jq .id a.json')[0]).toMatchObject({ path: 'a.json', how: 'searched' })
  expect(bashReads("jq -r '.[] | .name' a.json b.json").map(r => [r.path, r.how])).toEqual([['a.json', 'searched'], ['b.json', 'searched']])
  expect(bashReads('jq -s length a.jsonl')[0]).toMatchObject({ how: 'searched' })
  expect(bashReads('jq -f q.jq a.json').map(r => [r.path, r.how])).toEqual([['a.json', 'searched']])
  expect(bashReads('wc -l a.csv')[0]).toMatchObject({ how: 'searched' })
  expect(bashReads('awk -F, \'{print $1}\' a.csv')[0]).toMatchObject({ how: 'searched' })
  expect(bashReads('grep -c x a.csv')[0]).toMatchObject({ how: 'searched' })
  expect(bashReads('grep -rn x agents/')[0]).toMatchObject({ how: 'searched', path: 'agents/', recursive: true })
  expect(bashReads('grep -R x')[0]).toMatchObject({ path: '.', recursive: true })
  expect(bashReads('rg x')[0]).toMatchObject({ path: '.', recursive: true })
  expect(bashReads('rg --files')).toEqual([])
  expect(bashReads('grep -e x -e y a.csv b.csv').map(r => r.path)).toEqual(['a.csv', 'b.csv'])
  expect(bashReads('duckdb -c "select count(*) from \'t.parquet\'"').map(r => r.path)).toContain('t.parquet')
})
