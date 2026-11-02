// The ready kinds (cards/kinds.js), drawn by the card runner started as the hooks start it, from data as a card call
// keeps it (ready.ts): each kind's answer first and its data within the frame's rows and the card's width, at narrow
// and wide widths and in the dark and the light theme; the palette's colors and never purple; a table's columns, cuts
// and pages; a chart's marks; a timeline's lanes and gaps; a diagram's ways; an example's passages; a note's words.
// All data is made up.
//   node --test plugin/cards/test/kinds.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { textWidth } from '../../core/text.js'
import { KINDS, STUB } from '../kinds.js'
import { startRunner } from './start.mjs'

let dir
let runner
let n = 0

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thimble-kinds-'))
  runner = await startRunner(dir)
})

after(() => {
  runner?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A ready card of `data` loaded at `width` in `theme`: the runner's answer, with its id. */
async function load(data, width = 80, theme = 'dark') {
  const id = `c${(++n).toString(16).padStart(8, '0')}`
  const rows = join(dir, `${id}.json`)
  writeFileSync(rows, JSON.stringify(data))
  const r = await runner.ask('load', { id, version: 1, title: 'A question', view: STUB, rows, width, theme })
  return { id, ...r }
}

/** Each line of a drawing as its runs: [{text, color, bold}], the column's Texts in order (the answer's one Text whole). */
function runs(tree) {
  const flat = (k, style) => (typeof k === 'string' ? [{ text: k, ...style }] : (k.c || []).flatMap(x => flat(x, { ...style, ...(k.p?.color ? { color: k.p.color } : {}), ...(k.p?.bold ? { bold: true } : {}) })))
  return tree.c.map(line => flat(line, {}))
}

const colorsIn = tree => [...new Set(JSON.stringify(tree).match(/#[0-9a-f]{6}/gi) || [])]

/** Whether a color is a purple: hue between blue and pink, and not gray. */
function purple(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 0.15) return false
  const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4
  const hue = (h * 60 + 360) % 360
  return hue > 255 && hue < 315
}

/** A record as ready.ts keeps it, its passage's span where the quote stands. */
const passage = (rec, quote) => ({ ...rec, spans: [[rec.text.indexOf(quote), rec.text.indexOf(quote) + quote.length]] })

const agents = ['ep01 Go', 'ep01 Rust', 'ep01 TS', 'ep02 Go', 'ep02 Rust', 'ep02 TS']
const day = i => new Date(Date.UTC(2026, 4, 24) + i * 86400000).toISOString().slice(0, 10)
const SAMPLES = {
  table: { kind: 'table', answer: 'Five of the six agents passed against production at least once.', rows: agents.map((a, i) => ({ agent: a, runs: 3 + i * 4, passed: i === 2 ? '× 0/3' : `✓ ${i + 1}/${i + 1}` })) },
  bar: { kind: 'chart', mark: 'bar', x: 'agent', y: 'runs', color: 'outcome', answer: 'Most runs passed.', rows: agents.flatMap((a, i) => [{ agent: a, outcome: 'passed', runs: 3 + i * 3 }, { agent: a, outcome: 'failed', runs: i % 3 }]) },
  columns: { kind: 'chart', mark: 'bar', x: 'day', y: 'saves', answer: 'Writing peaked in the middle of June.', rows: Array.from({ length: 60 }, (_, i) => ({ day: day(i), saves: Math.round(5000 * Math.exp(-((i - 25) ** 2) / 40)) })) },
  line: { kind: 'chart', mark: 'line', x: 'minute', y: 'merged', color: 'run', answer: 'One run merged far more.', rows: ['no manager · PRs only', 'manager · PRs only'].flatMap((run, k) => Array.from({ length: 60 }, (_, t) => ({ minute: t, merged: Math.floor(t / (k ? 25 : 5)), run }))) },
  scatter: { kind: 'chart', mark: 'scatter', x: 'tokens', y: 'seconds', answer: 'Longer prompts took longer.', rows: Array.from({ length: 30 }, (_, i) => ({ tokens: 1000 + i * 300, seconds: 2 + i / 3 })) },
  dots: { kind: 'chart', mark: 'dots', x: 'minute', y: 'run', answer: 'Most merges came late.', rows: [40, 41, 41, 42, 42, 42, 50, 61, 62, 62].map(m => ({ minute: m, run: 'no manager · PRs only' })).concat([12, 47].map(m => ({ minute: m, run: 'manager' }))) },
  range: { kind: 'chart', mark: 'range', y: 'agent', x: 'first', x2: 'last', color: 'maker', answer: 'The first agents ran longest.', rows: [['Claude 3.7 Sonnet', '2025-04-02', '2025-11-30', 'Anthropic'], ['GPT-4.1', '2025-04-02', '2025-08-12', 'OpenAI'], ['Gemini 2.5 Pro', '2025-05-10', '2026-01-20', 'Google']].map(([agent, first, last, maker]) => ({ agent, first, last, maker })) },
  heatmap: { kind: 'chart', mark: 'heatmap', x: 'hour', y: 'day', color: 'saves', answer: 'Most saves came on weekday afternoons.', rows: ['Mon', 'Tue', 'Sat'].flatMap((d, i) => Array.from({ length: 24 }, (_, h) => ({ day: d, hour: String(h).padStart(2, '0'), saves: i === 2 ? h % 3 : Math.round(100 * Math.exp(-((h - 15) ** 2) / 12)) }))) },
  timeline: { kind: 'timeline', answer: 'The build passed its test command at 14:02, after two failing runs.', events: [{ time: '2026-06-18T13:01:00Z', label: 'the build starts', lane: 'build' }, { time: '2026-06-18T13:20:00Z', label: 'make test: 3 of 41 fail', lane: 'tests' }, { time: '2026-06-18T13:31:00Z', label: 'make test: 1 of 41 fails', lane: 'tests' }, { time: '2026-06-18T14:02:00Z', label: '✓ make test: all 41 pass', lane: 'tests' }, { time: '2026-06-18T16:40:00Z', label: 'the run ends', lane: 'build', end: '2026-06-18T16:52:00Z' }] },
  diagram: { kind: 'diagram', answer: 'A streak breaks only on a missed day that is not forgiven.', nodes: [{ id: 'day', label: 'A scheduled day ends', detail: 'unscheduled days are skipped' }, { id: 'done', label: '✓ Completed: the streak grows' }, { id: 'check', label: 'Forgiveness check' }, { id: 'kept', label: 'Forgiven: the streak holds' }, { id: 'reset', label: '× Missed: the streak resets' }], edges: [['day', 'done', 'has a completion'], ['day', 'check', 'no completion'], ['check', 'kept', 'the day before was completed'], ['check', 'reset', 'a rule fails'], ['reset', 'day', 'next day']] },
  example: { kind: 'example', answer: 'One agent bought a domain with the credits it was given.', refs: [passage({ ref: 'chat.jsonl#L88', path: 'chat.jsonl', line: 88, field: 'content', context: 'created_at 2026-02-11 15:30 · speaker agent', text: 'Good news everyone! I just bought signal-garden.com for $12.99 using the credits the organizers gave us, so the puzzle finally has a home.' }, 'I just bought signal-garden.com for $12.99'), passage({ ref: 'app/streaks.py#L40-L42', path: 'app/streaks.py', line: 40, end: 42, text: 'def is_forgiven(day, history):\n    prev = previous_scheduled(day, history)\n    if prev is None or prev.status != "completed":' }, 'prev.status != "completed"')] },
  note: { kind: 'note', answer: 'The records cover only the first hour of each run.', text: 'Every run stopped after **59 to 70 minutes**, with "API Error: Connection lost".\n\n- The configs ask for 6 hours.\n- No run reached its own stop condition, so each count below is a count for the first hour of the run.' },
}

test('every kind draws its answer first, then its data within the frame\'s 30 rows and the card\'s width, from 20 columns to 120, in the dark and the light theme', async () => {
  assert.deepEqual(Object.keys(SAMPLES).map(k => SAMPLES[k].kind).filter((k, i, a) => a.indexOf(k) === i).sort(), [...KINDS].sort())
  for (const [name, data] of Object.entries(SAMPLES)) {
    for (const width of [20, 32, 60, 120]) {
      for (const theme of ['dark', 'light']) {
        const r = await load(data, width, theme)
        const at = `${name} at ${width} (${theme})`
        assert.equal(r.ok, true, `${at}: ${r.error}`)
        assert.deepEqual(r.cut, [], `${at}: no line is cut at the card's edge`)
        assert.ok(r.lines.length <= 30, `${at}: ${r.lines.length} rows`)
        for (const l of r.lines) assert.ok(textWidth(l) <= width, `${at}: "${l}" is wider than ${width}`)
        assert.ok(r.lines[0].startsWith(data.answer.split(' ')[0]), `${at}: the answer comes first`)
        assert.equal(r.lines[r.lines.indexOf(r.lines.find(l => !data.answer.includes(l.trim()) || !l.trim()))], '', `${at}: a blank row under the answer`)
      }
    }
  }
})

test("a ready card's colors are the palette's for the terminal's theme, the light one's deeper, and never purple", async () => {
  for (const [name, data] of Object.entries(SAMPLES)) {
    const dark = colorsIn((await load(data, 80, 'dark')).tree)
    const light = colorsIn((await load(data, 80, 'light')).tree)
    for (const c of [...dark, ...light]) assert.equal(purple(c), false, `${name}: ${c} is a purple`)
    if (dark.length) assert.notDeepEqual(dark, light, `${name}: each theme has its own colors`)
  }
  // one series: the palette's first category; passed and failed: its green and red
  assert.deepEqual(colorsIn((await load({ ...SAMPLES.bar, color: undefined }, 80, 'dark')).tree).filter(c => c !== '#85827a'), ['#80b2ea'])
  const bars = colorsIn((await load(SAMPLES.bar, 80, 'light')).tree)
  assert.ok(bars.includes('#0b7c5f') && bars.includes('#c93a28'), 'passed in green, failed in red')
})

test('a table sizes each column to its longest value, puts numbers at the right with one count of decimals, names its columns in gray, and draws ✓ and × in green and red', async () => {
  const r = await load({ kind: 'table', answer: 'Two agents.', rows: [{ agent: 'ada', score: 3.5, ok: true }, { agent: 'bram-the-long', score: 12, ok: false }] }, 60)
  assert.deepEqual(r.lines, ['Two agents.', '', 'agent          score  ok', 'ada              3.5  ✓', 'bram-the-long   12.0  ×'])
  const lines = runs(r.tree)
  assert.equal(lines[2][0].color, '#85827a')
  assert.deepEqual(lines[3].filter(x => x.text === '✓').map(x => x.color), ['#67cda8'])
  assert.deepEqual(lines[4].filter(x => x.text === '×').map(x => x.color), ['#f59183'])
})

test("a table's first column names its rows: a number there shows as given, as a PR's number reads, while the other numbers get their separators", async () => {
  const r = await load({ kind: 'table', answer: 'Two PRs.', rows: [{ PR: 65368, reviews: 1200, minute: 67.5 }, { PR: 64302, reviews: 3, minute: 9 }] }, 60)
  assert.deepEqual(r.lines.slice(2), ['PR     reviews  minute', '65368    1,200    67.5', '64302        3     9.0'])
})

test('every ✓ in a cell is green and every × that marks a failure red, but a multiplication sign keeps the text\'s color', async () => {
  const r = await load({ kind: 'table', answer: 'Statuses.', rows: [{ day: 'Mon', statuses: '✓ ✓ forgiven ×missed ✓', note: '2× faster, 3 × 4' }] }, 80)
  const glyphs = runs(r.tree)[3].filter(x => /^[✓×]$/.test(x.text)).map(x => [x.text, x.color])
  assert.deepEqual(glyphs, [['✓', '#67cda8'], ['✓', '#67cda8'], ['×', '#f59183'], ['✓', '#67cda8']])
  assert.ok(runs(r.tree)[3].some(x => /2× faster, 3 × 4/.test(x.text) && !x.color))
})

test('a table too wide for the card cuts its text, the widest column first, each value keeping the part that tells it apart, and names the columns left out', async () => {
  const rows = ['tests/test_streaks_forgiveness.py', 'tests/test_streaks_archive.py', 'tests/test_reminders.py'].map((file, i) => ({ file, tests: 10 + i, error: i ? 'KeyError: archived_at in the habit loader' : 'AssertionError: expected streak 4, got 3', a: 1, b: 2, c: 3, d: 4, e: 5 }))
  const r = await load({ kind: 'table', answer: 'Three files.', rows }, 40)
  const files = r.lines.slice(3, 6).map(l => l.split(' ')[0])
  // the start they share is said as …, so each keeps its own words
  assert.ok(files.every(f => f.startsWith('…')), files.join(' '))
  assert.equal(new Set(files).size, 3)
  assert.match(r.lines[r.lines.length - 1], /^\+\d+ columns: /)
  assert.ok(r.lines.every(l => textWidth(l) <= 40))
})

test('a table of many rows shows a page and which rows it holds; j turns to the next page and k back, and it takes j and k only when it has pages', async () => {
  const many = { kind: 'table', answer: 'Every agent ran the suite.', rows: Array.from({ length: 60 }, (_, i) => ({ agent: `agent-${String(i + 1).padStart(2, '0')}`, runs: i })) }
  const r = await load(many, 60)
  assert.equal(r.keys, 'jk')
  assert.match(r.lines[r.lines.length - 1], /^rows 1-\d+ of 60$/)
  const per = Number(/^rows 1-(\d+)/.exec(r.lines[r.lines.length - 1])[1])
  let k = await runner.ask('key', { id: r.id, key: 'j' })
  assert.equal(k.handled, true)
  let c = await runner.ask('copy', { id: r.id, width: 60 })
  assert.equal(c.lines[c.lines.length - 1], `rows ${per + 1}-${2 * per} of 60`)
  assert.equal(c.lines[3].startsWith(`agent-${String(per + 1).padStart(2, '0')}`), true)
  k = await runner.ask('key', { id: r.id, key: 'k' })
  c = await runner.ask('copy', { id: r.id, width: 60 })
  assert.match(c.lines[c.lines.length - 1], /^rows 1-/)
  // the page is the card's state, kept across a resume
  assert.deepEqual(JSON.parse((await runner.ask('key', { id: r.id, key: 'j' })).state), { page: 1 })
  // a table that fits takes no keys
  assert.equal((await load({ ...many, rows: many.rows.slice(0, 10) }, 60)).keys, '')
})

test('a bar chart puts each value right after its bar, the bars in proportion; with groups, a legend and each group\'s value in the legend\'s order', async () => {
  const r = await load({ kind: 'chart', mark: 'bar', x: 'agent', y: 'reviews', answer: 'agent-15 reviewed the most.', rows: [{ agent: 'agent-15', reviews: 12 }, { agent: 'agent-04', reviews: 6 }, { agent: 'agent-09', reviews: 3 }] }, 70)
  const bar = l => (l.match(/[█▉▊▋▌▍▎▏]+/) || [''])[0]
  assert.match(r.lines[2], /^agent-15 █+ 12$/)
  assert.match(r.lines[3], /^agent-04 █+ 6$/)
  assert.equal(bar(r.lines[2]).length, 2 * bar(r.lines[3]).length)
  // the value bold, what it is in the default color
  assert.equal(runs(r.tree)[2].find(x => x.text === '12').bold, true)
  const g = await load(SAMPLES.bar, 80)
  assert.match(g.lines[2], /^█ passed {2}█ failed$/)
  assert.ok(g.lines.some(l => /^ep01 TS +█+ 11 = 9 \+ 2$/.test(l)), g.lines.join('\n'))
  // a count of rows when y is left out
  const c = await load({ kind: 'chart', mark: 'bar', x: 'maker', answer: 'Anthropic made most.', rows: ['Anthropic', 'OpenAI', 'Anthropic'].map(maker => ({ maker })) }, 50)
  assert.match(c.lines[2], /^Anthropic █+ 2$/)
})

test('bars over a time axis go across as columns under the largest value, summed in neighbors when they outnumber the cells, which the card says', async () => {
  const r = await load(SAMPLES.columns, 120)
  assert.match(r.lines[2], /^5,000 /)
  assert.ok(r.lines.some(l => /May 24/.test(l)) && r.lines.some(l => /Jul/.test(l)), 'the time axis')
  assert.ok(!r.lines.some(l => /summed/.test(l)))
  const narrow = await load(SAMPLES.columns, 40)
  assert.match(narrow.lines[narrow.lines.length - 1], /^\d days summed in each column$/)
})

test('a line chart draws each series as a filled strip on one scale, one under another, named at its left with its last value at its right, the axis labels at their ticks', async () => {
  const r = await load(SAMPLES.line, 70)
  assert.equal(r.lines[2], 'merged, each strip from 0 to 11')
  const named = r.lines.filter(l => /^(no manager|manager)/.test(l))
  assert.equal(named.length, 2)
  // gray dots where a series runs at zero, then its strip
  assert.match(named[0], /^no manager · PRs only ·*[▁▂▃▄▅▆▇█]+ 11$/)
  assert.match(named[1], /^manager · PRs only +·+[▁▂▃▄▅▆▇█]+ +2$/)
  assert.deepEqual([...new Set(runs(r.tree).flat().filter(x => /^·+$/.test(x.text)).map(x => x.color))], ['#85827a'])
  // each strip in its series' color, its heights in eighths of a row
  const filled = runs(r.tree).flat().filter(x => /[▁▂▃▄▅▆▇█]/.test(x.text)).map(x => x.color)
  assert.deepEqual([...new Set(filled)].sort(), ['#80b2ea', '#ed9a6b'])
  assert.ok(r.lines.some(l => /^\s+0\s+20\s+40/.test(l)), r.lines.join('\n'))
  // one series: one taller strip, the axis's top and bottom at its left
  const one = await load({ ...SAMPLES.line, color: undefined, rows: SAMPLES.line.rows.filter(x => x.run.startsWith('manager')) }, 60)
  assert.match(one.lines[3], /^2 \s*[▁▂▃▄▅▆▇█ ]*$/)
  assert.match(one.lines[10], /^0 ·+[▁▂▃▄▅▆▇█]+$/)
})

test('a dots chart draws a dot for each row at its x, a place of several as how many, and never lets two counts touch and read as one number', async () => {
  for (const width of [30, 44, 80]) {
    const r = await load(SAMPLES.dots, width)
    const strip = r.lines.find(l => l.startsWith('no manager') || l.startsWith('…') || l.startsWith('no ma'))
    assert.ok(strip, r.lines.join('\n'))
    assert.doesNotMatch(strip.replace(/ \d+ *$/, ''), /\d\d/, `at ${width}: ${strip}`)
    assert.match(strip, / 10 *$/)
  }
})

test("a chart whose column no row has, or whose mark is none of the chart's, does not draw, and says which columns the rows have", async () => {
  const r = await load({ ...SAMPLES.bar, y: 'runz' })
  assert.equal(r.ok, false)
  assert.match(r.error, /the chart's y is "runz", which no row has; the rows' columns are agent, outcome, runs/)
  assert.match((await load({ ...SAMPLES.bar, mark: 'pie' })).error, /a chart's mark is one of bar, line, scatter, dots, range, heatmap, not pie/)
})

test('a range chart draws each span on one axis in its group\'s color; a heatmap shades its cells by their quarter of the cells, so the copy shows the pattern', async () => {
  const r = await load(SAMPLES.range, 70)
  assert.match(r.lines[2], /^█ Anthropic {2}█ OpenAI {2}█ Google$/)
  assert.match(r.lines.find(l => l.startsWith('GPT-4.1')), /^GPT-4\.1 +█+─+$/)
  assert.match(r.lines[r.lines.length - 1], /Apr 2025/)
  // the shades by quarter of the cells, so one large value leaves the pattern of the rest in sight
  const h = await load(SAMPLES.heatmap, 120)
  assert.match(h.lines[2], /^saves: ░ [\d-]+ {2}▒ [\d-]+ {2}▓ [\d-]+ {2}█ [\d-]+100 {2}· none$/)
  assert.ok(h.lines.find(l => l.startsWith('Mon')).includes('█'), 'the peak in the darkest shade')
  const skewed = await load({ ...SAMPLES.heatmap, rows: SAMPLES.heatmap.rows.map(x => (x.day === 'Mon' && x.hour === '15' ? { ...x, saves: 5000 } : x)) }, 120)
  assert.ok(skewed.lines.find(l => l.startsWith('Tue')).includes('▓'), skewed.lines.join('\n'))
})

test('a timeline puts events in time order, a few lanes as columns side by side, a long wait said as its length, and how long an event with an end lasted', async () => {
  const shuffled = { ...SAMPLES.timeline, events: [...SAMPLES.timeline.events].reverse() }
  const r = await load(shuffled, 90)
  assert.match(r.lines[2], /^ +build {2}tests/)
  assert.match(r.lines[3], /^13:01 +● +│ +the build starts$/)
  assert.ok(r.lines.some(l => /2 h 38 min later/.test(l)), r.lines.join('\n'))
  assert.match(r.lines[r.lines.length - 1], /^16:40 .*the run ends · 12 min$/)
  // ✓ at the start of an event's words in green
  assert.ok(runs(r.tree).flat().some(x => x.text === '✓' && x.color === '#67cda8'))
  // days: the date on each day's first event, a number of days for a long wait
  const days = await load({ kind: 'timeline', answer: 'Two days.', events: [['2025-11-03 18:49:21', 'asks for the card'], ['2025-11-03 19:02:10', 'the card is declined'], ['2025-11-04 09:14:00', 'the rule is set'], ['2026-02-11 15:30:00', 'a domain is bought']] }, 70)
  assert.deepEqual(days.lines.slice(2).map(l => l.slice(0, 13)), [' Nov 3 18:49 ', '       19:02 ', ' Nov 4 09:14 ', '             ', 'Feb 11 15:30 '])
  assert.match(days.lines[5], /⋮ 99 days later/)
  // times that are plain numbers: an end said as where it ends, and no wait said in units the times do not have
  const minutes = await load({ kind: 'timeline', answer: 'Claims came first.', events: [{ time: 0, label: 'agents start' }, { time: 4.6, end: 19.6, label: 'claims' }, { time: 30, label: 'first merge' }, { time: 31, label: 'second merge' }] }, 70)
  assert.ok(minutes.lines.includes('4.6  ● claims · to 19.6'), minutes.lines.join('\n'))
  assert.ok(!minutes.lines.some(l => /later/.test(l)))
})

test('a diagram draws a chain on one line when it fits, else straight down; a node with more ways on branches with each edge\'s label, and a node drawn already is named with ↑', async () => {
  const chain = { kind: 'diagram', answer: 'A reminder goes out at the habit\'s time.', nodes: ['scheduler wakes', 'habit due?', 'send reminder'], edges: [['scheduler wakes', 'habit due?', 'each minute'], ['habit due?', 'send reminder', 'yes']] }
  assert.equal((await load(chain, 90)).lines[2], 'scheduler wakes ─ each minute ─▶ habit due? ─ yes ─▶ send reminder')
  assert.deepEqual((await load(chain, 30)).lines.slice(-5), ['scheduler wakes', '↓ each minute', 'habit due?', '↓ yes', 'send reminder'])
  const r = await load(SAMPLES.diagram, 90)
  assert.deepEqual(r.lines.slice(2), [
    'A scheduled day ends',
    '  unscheduled days are skipped',
    '├─ has a completion ─▶ ✓ Completed: the streak grows',
    '└─ no completion ─▶ Forgiveness check',
    '   ├─ the day before was completed ─▶ Forgiven: the streak holds',
    '   └─ a rule fails ─▶ × Missed: the streak resets',
    '      └─ next day ─▶ A scheduled day ends ↑',
  ])
  // an edge with no label: its branch points straight at its node
  const bare = await load({ ...SAMPLES.diagram, edges: [['day', 'done', 'has a completion'], ['day', 'check']] }, 90)
  assert.ok(bare.lines.includes('└─▶ Forgiveness check'), bare.lines.join('\n'))
  // a long edge label wraps under its branch, its node after it
  const long = await load({ ...SAMPLES.diagram, edges: [['day', 'check', 'no completion, and the day is past, and the habit was not archived that day'], ['day', 'done', 'done']] }, 40)
  assert.ok(long.lines.every(l => textWidth(l) <= 40))
  assert.ok(long.lines.some(l => /^│ {2}\S/.test(l)), long.lines.join('\n'))
})

test("an example draws each record under its file and place, the passage bold in the default color and the rest of the record gray; a range of a file's lines with their numbers", async () => {
  const r = await load(SAMPLES.example, 90)
  assert.equal(r.lines[2], 'chat.jsonl · line 88 · content')
  assert.equal(r.lines[3], '  created_at 2026-02-11 15:30 · speaker agent')
  const lines = runs(r.tree)
  const quote = lines.slice(4, 7).flat().filter(x => x.bold).map(x => x.text).join('')
  assert.equal(quote.replace(/\s+/g, ' ').trim(), 'I just bought signal-garden.com for $12.99')
  assert.deepEqual(lines[4].filter(x => x.color === '#85827a').map(x => x.text).slice(0, 3), ['Good', 'news', 'everyone!'], 'the record around the passage in gray')
  const code = r.lines.indexOf('app/streaks.py · lines 40-42')
  assert.ok(code > 0)
  assert.deepEqual(r.lines.slice(code + 1, code + 4).map(l => l.slice(0, 6)), ['  40  ', '  41  ', '  42  '])
  assert.deepEqual(lines[code + 3].filter(x => x.bold).map(x => x.text), ['prev.status != "completed"'])
  // records that take more than a page: a page of them, j for the next
  const many = await load({ ...SAMPLES.example, refs: Array.from({ length: 6 }, () => SAMPLES.example.refs[0]) }, 50)
  assert.equal(many.keys, 'jk')
  assert.match(many.lines[many.lines.length - 1], /^records 1-\d of 6$/)
})

test('a note wraps its paragraphs at the width, keeps a list item\'s lines under its words, and bold words with the punctuation after them', async () => {
  const r = await load(SAMPLES.note, 50)
  assert.deepEqual(r.lines.slice(2), [
    'Every run stopped after 59 to 70 minutes, with',
    '"API Error: Connection lost".',
    '',
    '• The configs ask for 6 hours.',
    '• No run reached its own stop condition, so each',
    '  count below is a count for the first hour of the',
    '  run.',
  ])
  assert.deepEqual(runs(r.tree)[2].filter(x => x.bold).map(x => x.text).join(''), '59 to 70 minutes')
})

test('names too long for their column keep the part that tells them apart: the start they share said as …, else cut in the middle where cutting the end makes two alike', async () => {
  const r = await load({ kind: 'chart', mark: 'bar', x: 'run', y: 'merged', answer: 'The PRs-only run merged most.', rows: [{ run: 'no manager · PRs only', merged: 14 }, { run: 'no manager · PRs and issues', merged: 7 }, { run: 'manager · PRs and issues', merged: 4 }] }, 34)
  const names = r.lines.slice(2).map(l => l.replace(/ █.*$/, '').trim())
  assert.equal(new Set(names).size, 3)
  assert.ok(names.every(x => textWidth(x) <= 13), names.join(' | '))
  assert.ok(names.some(x => x.includes('…')))
})
