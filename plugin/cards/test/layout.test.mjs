// The card layout (cards/layout.js): the gallery's views, drawn by the runner, lay out as Claude Code's terminal drew
// them (test/golden/, captured from a real session at GOLDEN_WIDTH), and the text rules on their own. All rows are made up.
//   node --test plugin/cards/test/layout.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { layoutLines, textWidth, wrapText } from '../layout.js'
import { GALLERY, GOLDEN_WIDTH } from './gallery.mjs'

const HERE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
let dir
let child
let sock

const ask = (op, body) => new Promise((resolve, reject) => {
  const q = http.request({ socketPath: sock, path: `/${op}`, method: 'POST' }, res => {
    let t = ''
    res.on('data', d => { t += d })
    res.on('end', () => resolve(JSON.parse(t)))
  })
  q.on('error', reject)
  q.end(JSON.stringify(body))
})

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thimble-layout-'))
  sock = join(dir, 'r.sock')
  child = spawn('node', ['--permission', `--allow-fs-read=${HERE}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, join(HERE, 'runner.mjs'), sock], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await ask('ping', {})).ok) return } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('the runner did not start')
})

after(() => {
  child?.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('each gallery view lays out as the terminal drew it', async () => {
  assert.ok(GALLERY.length >= 15)
  for (const [i, g] of GALLERY.entries()) {
    writeFileSync(join(dir, `${i}.json`), JSON.stringify(g.rows))
    const r = await ask('load', { id: `c${String(i).padStart(8, '0')}`, version: 1, title: g.title, view: g.view, rows: join(dir, `${i}.json`), width: GOLDEN_WIDTH })
    assert.equal(r.ok, true, `${g.name}: ${r.error}`)
    const golden = readFileSync(fileURLToPath(new URL(`./golden/${g.name}.txt`, import.meta.url)), 'utf8').replace(/\n$/, '').split('\n')
    const lines = r.lines.slice()
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    assert.deepEqual(lines, golden, g.name)
  }
})

test('text wraps at words, keeps a word whole where it fits, and cuts one longer than the width', () => {
  assert.deepEqual(wrapText('the quick brown fox', 9), ['the quick', 'brown fox'])
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('one two', 3), ['one', 'two'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-end'), ['path/to/a…'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-start'), ['…ile.jsonl'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-middle'), ['path/…sonl'])
})

test('wide characters take two cells, and a line past the width is cut and named', () => {
  assert.equal(textWidth('名前 ok'), 7)
  const box = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Box', p: { width: 30, flexShrink: 0 }, c: [{ t: 'Text', p: {}, c: ['x'] }] }, { t: 'Text', p: {}, c: ['fits'] }] }
  const r = layoutLines(box, 20)
  assert.deepEqual(r.lines, ['x', 'fits'])
  const wide = layoutLines({ t: 'Box', p: {}, c: [{ t: 'Box', p: { width: 25, flexShrink: 0, borderStyle: 'single' }, c: [] }] }, 20)
  assert.deepEqual(wide.cut, [1, 2])
  assert.equal(wide.lines[0], '┌' + '─'.repeat(19))
})
