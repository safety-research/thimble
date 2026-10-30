// The tray's state and words (tray/tray.mjs): the stack of marks, the stops ] and [ move through in reading order and
// where they stop, the bar's words, and what a question asked with the tray open carries for Claude. Made-up data.
//   node --test plugin/tray/test/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { partsAround } from '../../core/text.js'
import { aboutOf, around, back, base, cardLabel, checkStatus, cutWords, evidenceLine, fileHref, firstSentence, hiddenOutput, indexOf, lineWindow, moreLines, open, outputAt, partLabel, placeLabel, printableEvidence, printedAt, printLine, push, restWords, SHOW_ALL, stepFrom, stepWords, stopKind, stopWhat, stopsOfRow, TABLE_LABEL, top, wasLine } from '../tray.mjs'

const C1 = { row: 'r2', kind: 'citation', n: 1 }
const G1 = { row: 'r2', kind: 'explain', id: 'g1' }

test('the stack: a mark opens alone, a citation inside it opens over it, 0 goes back, then closes', () => {
  let t = open({ ...G1, open: null })
  assert.deepEqual(t, { stack: [G1] })
  t = push(t, C1)
  assert.deepEqual(top(t), C1)
  assert.deepEqual(base(t), G1)
  // the same mark twice in a row is not stacked
  assert.equal(push(t, C1).stack.length, 2)
  t = back(t)
  assert.deepEqual(top(t), G1)
  assert.equal(back(t), null)
})

test('a row\'s stops: its citations and explainers by where they stand, then its cards; ] stops at the ends', () => {
  const stops = stopsOfRow('r2', [{ n: 2, start: 40 }, { n: 1, start: 5 }, { n: 0, start: 60 }], [{ id: 'g1', kind: 'explain', start: 20 }, { id: 'h1', kind: 'heads', start: 7 }], ['c9'])
  assert.deepEqual(stops.map(s => s.card ?? (s.kind === 'citation' ? `c${s.n}` : s.id)), ['c1', 'h1', 'g1', 'c2', 'c9'])
  assert.equal(indexOf(stops, C1), 0)
  assert.equal(indexOf(stops, { row: 'r2', card: 'c9' }), 4)
  assert.equal(stepFrom(stops, 4, 1), null)
  assert.equal(stepFrom(stops, 0, -1), null)
  assert.deepEqual(stops.map(stopWhat), ['citation', 'heads up', 'explainer', 'citation', 'card'])
})

test('an explainer or a heads-up on a citation\'s words, or over them, stops before it: a click opens it first, ] goes on to the citation', () => {
  const cites = [{ n: 1, start: 10, words: 'build fails' }, { n: 2, start: 50, words: '41 runs' }]
  // g1 inside the first citation's words, h1 over the second citation and the words beside it
  const stops = stopsOfRow('r2', cites, [{ id: 'g1', kind: 'explain', start: 11, end: 22 }, { id: 'h1', kind: 'heads', start: 44, end: 70 }], ['c9'])
  assert.deepEqual(stops.map(s => s.card ?? (s.kind === 'citation' ? `c${s.n}` : s.id)), ['g1', 'c1', 'h1', 'c2', 'c9'])
  assert.deepEqual(stops.map(stopWhat).slice(0, 2), ['explainer', 'citation'])
})

test('the bar names the mark ] opens by its kind, the words that name it apart to draw in its look: show the answer\'s first mark, next a later one; a narrow bar keeps the name, then the key alone, never a verb with no name', () => {
  const stops = stopsOfRow('r2', [{ n: 1, start: 30 }], [{ id: 'g1', kind: 'explain', start: 5 }, { id: 'h1', kind: 'heads', start: 50 }], ['c9'])
  assert.deepEqual(stops.map(stopKind), ['explain', 'citation', 'heads', null])
  assert.deepEqual(restWords(stops[0], true), { words: 'show explainer', what: 'explainer', kind: 'explain', shorter: ['explainer', ''] })
  assert.deepEqual(restWords(stops[1], false), { words: 'next citation', what: 'citation', kind: 'citation', shorter: ['citation', ''] })
  assert.deepEqual(restWords(stops[2], false), { words: 'next heads up', what: 'heads up', kind: 'heads', shorter: ['heads up', ''] })
  // the tray's header: what ] and [ go to, by name and kind; a card has no kind
  assert.deepEqual(stepWords({ next: true, prev: true, nextWhat: 'heads up', nextKind: 'heads' }), [{ key: ']', words: 'next heads up', what: 'heads up', kind: 'heads' }])
  assert.deepEqual(stepWords({ next: false, prev: true, prevWhat: 'card', prevKind: null }), [{ key: '[', words: 'previous card', what: 'card', kind: null }])
  // the words around the name, which the bar and the header draw in their own looks
  assert.deepEqual(partsAround(' show explainer', 'explainer'), [{ s: ' show ', marked: false }, { s: 'explainer', marked: true }])
  assert.deepEqual(partsAround(' heads up', 'heads up'), [{ s: ' ', marked: false }, { s: 'heads up', marked: true }])
  assert.deepEqual(partsAround(' show', 'explainer'), [{ s: ' show', marked: false }])
  assert.deepEqual(partsAround(' next card', undefined), [{ s: ' next card', marked: false }])
})

test("a citation's check in the words every place that shows its card says it in (the tray's header, the evidence pane, the claims pane): the reply's sign after it, then the word; a corrected one says corrected, or repaired after x, with what it was under it", () => {
  const word = m => { const s = checkStatus(m); return `${s.sign} ${s.word} (${s.tone})` }
  assert.equal(word({ status: 'checking' }), 'spin checking (dim)')
  assert.equal(word({ status: 'deferred' }), '? not checked (dim)')
  assert.equal(word({ status: 'verified' }), '✓ verified (good)')
  assert.equal(word({ status: 'verified', repair: true }), '✓ verified (good)')
  assert.equal(word({ status: 'corrected', was: '15 of 40' }), '✓ corrected (good)')
  assert.equal(word({ status: 'corrected', was: '15 of 40', repair: true }), '✓ repaired (good)')
  assert.equal(word({ status: 'failed' }), '× failed (bad)')
  // a status no check gave, or no citation, is failed (marks/store.ts notRun)
  assert.equal(word({ status: 'pending' }), '× failed (bad)')
  assert.equal(checkStatus(null).key, 'failed')
  // under a corrected one's status: what it was, its marks gone; a rewritten sentence or a narrowed citation says which
  assert.equal(wasLine({ was: '**15** of 40' }), 'was 15 of 40')
  assert.equal(wasLine({ was: 'Of the runs, 15 of 40 failed.', rewritten: true }), 'sentence rewritten; was Of the runs, 15 of 40 failed.')
  assert.equal(wasLine({ was: '15 of 40 runs', narrowed: true }), 'narrowed; was 15 of 40 runs')
})

test('a citation\'s card: why in one sentence, and the one line of evidence that holds the value, cut around it', () => {
  assert.equal(firstSentence('Counted 12.5 of 40 runs. The rest passed.'), 'Counted 12.5 of 40 runs.')
  assert.equal(firstSentence('no stop at the end'), 'no stop at the end')
  // computed: the output line where the first highlight starts, the span moved into it
  const out = 'runs: 40\nmerged: 12 of 40\nopen: 3'
  assert.deepEqual(evidenceLine({ kind: 'computed', code: 'print()', output: out, highlight: [[17, 25]] }), { text: 'merged: 12 of 40', spans: [[8, 16]] })
  assert.deepEqual(evidenceLine({ kind: 'computed', code: 'print()', output: '\nfirst words' }), { text: 'first words', spans: [] })
  // a file: the cited line that holds the highlight, with its number
  const lines = [{ n: 3, text: 'runs: 40' }, { n: 4, text: 'failed: 12', highlight: [8, 10] }, { n: 5, text: 'open: 3' }]
  assert.deepEqual(evidenceLine({ kind: 'quote', file: 'runs/summary.txt', line: '4', lines }), { n: 4, text: 'failed: 12', spans: [[8, 10]] })
  assert.deepEqual(evidenceLine({ kind: 'quote', file: 'runs/summary.txt', line: '5', lines: [lines[0], lines[2]] }), { n: 5, text: 'open: 3', spans: [] })
  assert.equal(evidenceLine(null), null)
  // the output lines the one line leaves out: a trailing newline starts none; a file's evidence has none
  assert.equal(hiddenOutput({ kind: 'computed', output: out }), 2)
  assert.equal(hiddenOutput({ kind: 'computed', output: 'merged: 12\nopen: 3\n' }), 1)
  assert.equal(hiddenOutput({ kind: 'computed', output: 'merged: 12\n' }), 0)
  assert.equal(hiddenOutput({ kind: 'quote', file: 'runs/summary.txt', line: '4', lines }), 0)
  assert.equal(moreLines(1), '+ 1 more line')
  assert.equal(moreLines(3), '+ 3 more lines')
  // a long line keeps the value in view, with … where it was cut
  const long = { text: `${'a'.repeat(100)}VALUE${'b'.repeat(100)}`, spans: [[100, 105]] }
  const cut = lineWindow(long, 40)
  assert.ok(cut.text.length <= 40 && cut.text.startsWith('…') && cut.text.endsWith('…'))
  assert.equal(cut.text.slice(cut.spans[0][0], cut.spans[0][1]), 'VALUE')
  assert.deepEqual(lineWindow({ text: 'short', spans: [] }, 40), { text: 'short', spans: [] })
  // a line with words is cut between them, … only where words were left out
  const said = 'Each open ticket waits for a second reviewer to sign off before it can close — ask one with `desk sign <n>`.'
  const at = said.indexOf('a second reviewer to sign off')
  for (const room of [24, 40, 60]) {
    const w = lineWindow({ text: said, spans: [[at, at + 29]] }, room)
    assert.ok(w.text.length <= room)
    assert.match(w.text, /^… \S/)
    assert.match(w.text, /\S …$/)
    for (const word of w.text.replace(/^… | …$/g, '').split(' ')) assert.ok(said.split(' ').includes(word), `${room}: ${word}`)
    assert.ok('a second reviewer to sign off'.startsWith(w.text.slice(w.spans[0][0], w.spans[0][1])))
  }
  assert.equal(lineWindow({ text: said, spans: [[0, 4]] }, 30).text, 'Each open ticket waits for a …')
})


test("the words the tray, the side pane and the workbench's evidence label draw over each part of a citation's evidence and where they leave lines out: a part's label with its whole size, a file's place, a card; a marker with how many lines and where; + after the tray's last", () => {
  assert.equal(partLabel('code', 7), 'code · 7 lines')
  assert.equal(partLabel('output', 62), 'output · 62 lines')
  assert.equal(partLabel('output', 1), 'output · 1 line')
  assert.equal(TABLE_LABEL, 'output · table')
  assert.equal(placeLabel('changes.log', 3), 'changes.log · line 3')
  assert.equal(placeLabel('notes/runs.md', '8-11'), 'notes/runs.md · lines 8-11')
  assert.equal(cardLabel('Runs by status'), 'card · Runs by status')
  assert.equal(cutWords(5, 'above'), '⋯ 5 lines above')
  assert.equal(cutWords(13, 'below'), '⋯ 13 lines below')
  assert.equal(cutWords(1, 'above'), '⋯ 1 line above')
  assert.deepEqual(SHOW_ALL, { key: '+', words: 'show all' })
})

test("a cut card keeps a citation's key lines in the middle of what it shows: the window around a line, moved in from the ends, and the lines of code and output it keeps", () => {
  assert.deepEqual(around(10, 5, 3), [4, 7])
  assert.deepEqual(around(10, 5, 4), [3, 7])
  assert.deepEqual(around(10, 9, 3), [7, 10])
  assert.deepEqual(around(10, 0, 3), [0, 3])
  assert.deepEqual(around(2, 1, 5), [0, 2])
  assert.deepEqual(around(4, 2, 0), [2, 2])
  // the line of code that printed the value, by its index, as printLine names it; none where the code does not show it
  const ev = { kind: 'computed', code: 'import json\nprint(len(runs))\nprint(f"failed: {bad}")', output: '40\nfailed: 12', highlight: [[11, 13]] }
  assert.equal(outputAt(ev), 1)
  assert.equal(printedAt(ev), 2)
  assert.equal(printedAt({ ...ev, code: 'head -3 runs.csv\npython3 report.py' }), -1)
})

test('what a side thread is about quotes the words once: words that open with a quote keep their own', () => {
  assert.equal(aboutOf({ kind: 'heads', row: 'r1', id: 'h1' }, { gloss: { title: '"Cheated" is their own word' } }), 'the heads-up "Cheated" is their own word')
  assert.equal(aboutOf({ kind: 'heads', row: 'r1', id: 'h1' }, { gloss: { title: 'March is half a month' } }), 'the heads-up "March is half a month"')
  assert.equal(aboutOf({ kind: 'citation', row: 'r1', n: 2 }, { words: '“please post R3”' }), 'the citation “please post R3”')
})

test("a citation's evidence draws printable: a check's output, a file's line and name, a card's title and table, each byte that does not print as its escape, the cited value still marked; a file's link keeps its real name", () => {
  const out = '\u001b[31mFAILED\u001b[0m 12 of 40\u0000\r\nrun 2\tok'
  const at = out.indexOf('12 of 40')
  const ev = printableEvidence({ kind: 'computed', by: 'checker', code: 'print(r.stdout)', output: out, highlight: [[at, at + 8]] })
  assert.equal(ev.output, '\\x1b[31mFAILED\\x1b[0m 12 of 40\\x00\nrun 2 ok')
  const line = evidenceLine(ev)
  assert.equal(line.text.slice(line.spans[0][0], line.spans[0][1]), '12 of 40')
  const log = '\u001b[32mok\u001b[0m failed: 12'
  const file = printableEvidence({ kind: 'quote', file: 'logs/run\u001b.log', line: '2', lines: [{ n: 1, text: 'a\u00a0b' }, { n: 2, text: log, highlight: [log.indexOf('12'), log.indexOf('12') + 2] }] })
  assert.equal(file.file, 'logs/run\\x1b.log')
  assert.equal(file.lines[0].text, 'a\\xa0b')
  assert.equal(file.lines[1].text.slice(...file.lines[1].highlight), '12')
  const card = printableEvidence({ kind: 'card', card: 'c1', title: 'Runs\u200b', ref: 'card:c1#n/0', value: '12', table: { corner: '', cols: ['name\u0000', 'n'], rows: [{ label: 'a\u202e', values: ['x', '12'] }], at: { r: 0, c: 1 }, above: 0, below: 0 } })
  assert.equal(card.title, 'Runs\\u200b')
  assert.deepEqual([card.table.cols, card.table.rows[0].label], [['name\\x00', 'n'], 'a\\u202e'])
  // a link to a file: its name as the file has it, a lone half of a pair (bytes that are no UTF-8) as U+FFFD
  assert.equal(fileHref('/w/r\udce9sum.txt', '3'), 'file:///w/r%EF%BF%BDsum.txt#L3')
})

test('the line of code above a citation\'s output is one that printed it: never a print whose words the output lacks', () => {
  // a script with a print of its own words, then a shell echo after it
  const script = "python3 - <<'EOF'\nfor r in runs:\n    print(r, 'issues' if r.i else 'prs-only', 'h merged=', r.n)\nEOF\necho $TMPDIR"
  assert.equal(printLine(script, 'run-7 prs-only 8 h merged= 223'), "print(r, 'issues' if r.i else 'prs-only', 'h merged=', r.n)")
  // two prints with words: the one whose words the line holds, not the last
  assert.equal(printLine("print('gateway', a, 'of', b)\nprint('poverty revs times', t)", 'gateway 3 of 238'), "print('gateway', a, 'of', b)")
  // no print's words in the line: a print of values alone may have printed it; else none
  assert.equal(printLine("print('totals')\nprint(n)", '41'), 'print(n)')
  assert.equal(printLine("print('totals')", '41'), '')
})

test("of several prints, the line shown is the one that printed the cited line, by its words or its place among them; a neighbor's print of other values never stands in for it", () => {
  // a literal inside the print's own expression picks what it counts and is not printed: the sum printed 12, not the
  // print of len above it
  const two = "print(len(runs))\nprint(sum(r['status'] == 'failed' for r in runs))"
  assert.equal(printLine(two, '40\n12', 1), "print(sum(r['status'] == 'failed' for r in runs))")
  assert.equal(printLine(two, '40\n12', 0), 'print(len(runs))')
  // a heading print, then the value's: the heading's words are on a line above
  const day = 'print("Failures by day:")\nprint(runs[runs.status == "failed"].groupby("day").size())'
  assert.equal(printLine(day, 'Failures by day:\nday\n2026-10-01    3\n2026-10-02    5\ndtype: int64', 3), 'print(runs[runs.status == "failed"].groupby("day").size())')
  // a loop that prints a label line, then a value line: each value line is the value's print, the line before the
  // loop the print before it
  const loop = 'print(len(runs))\nfor d in days:\n    print("day", d)\n    print(counts[d])'
  const out = '40\nday 2026-10-01\n3\nday 2026-10-02\n5'
  assert.deepEqual([0, 2, 4].map(i => printLine(loop, out, i)), ['print(len(runs))', 'print(counts[d])', 'print(counts[d])'])
  // a label print that goes on with a value of several lines, then a print of one value: the value's last line is the
  // second print's, the lines between could be either's, so none is shown
  const label = 'print("by status:", counts)\nprint(n_runs)'
  const said = 'by status: status\npassed    28\nfailed    12\n40'
  assert.deepEqual([2, 3].map(i => printLine(label, said, i)), ['', 'print(n_runs)'])
  // a print of a count prints one line, so the lines between are the label print's
  assert.deepEqual([2, 3].map(i => printLine('print("by status:", counts)\nprint(len(runs))', said, i)), ['print("by status:", counts)', 'print(len(runs))'])
  // three prints of values, each of several lines or one: a line inside them could be any one's, so none is shown,
  // though a comparison's literal names a word of the line
  const three = 'print(runs.shape)\nprint(runs["status"].value_counts())\nprint(runs.groupby("config")["status"].apply(lambda s: (s == "failed").mean()))'
  assert.equal(printLine(three, '(40, 5)\nstatus\npassed    28\nfailed    12\nName: count, dtype: int64\nconfig\na    0.20\nb    0.45', 3), '')
})

test('a line of code is named above a cited output line only when the code shows that it printed that line: never a print beside a command, a function or a condition that may have printed it', () => {
  // `head` printed the file's lines, the script after it only the count: no line of the code is named for a file's
  // line, nor for the count, since `head` may have printed it too
  const head = 'head -3 runs.csv\npython3 -c \'import csv; print(sum(1 for r in csv.DictReader(open("runs.csv")) if r["status"] == "failed"))\''
  const csv = 'id,day,status\nn1,2026-03-01,passed\nn2,2026-03-02,failed\n12'
  assert.deepEqual([0, 2, 3].map(i => printLine(head, csv, i)), ['', '', ''])
  // a print inside a function runs when the function is called, so the print beside the call is not the one
  assert.equal(printLine('def show(label, value):\n    print(f"{label}: {value}")\n\nprint(len(runs))\nshow("failed", n_failed)', '40\nfailed: 12', 1), '')
  assert.equal(printLine('def report(v):\n    print(v)\nprint(len(runs))\nx = report(n_failed)', '40\n12', 1), '')
  // a print under a condition may not have run: the first line could be either print's
  assert.equal(printLine('if errors:\n    print(errors)\nprint(df.status.value_counts())', 'status\nfailed    12\npassed    28\nName: count, dtype: int64', 0), '')
  // a warning Python wrote after the output, with the line of code under it: no print wrote those lines, so the two
  // prints wrote the two before them, and the value's line is the last print's
  const warned = '40\n12\n/made/up.py:3: FutureWarning: a made-up warning\n  df.groupby("day")'
  assert.equal(printLine('print(len(runs))\nprint(n_failed)', warned, 1), 'print(n_failed)')
  assert.equal(printLine('print(n_runs)\nprint(n_failed)', warned, 1), 'print(n_failed)')
  // an output cut to its window: its first line may be a part of a line another print began
  assert.equal(printLine('print(len(df))\nprint(df.to_string())', '…   n7  failed  12\n   n8  passed  9', 0), '')
  // a print of its own words alone writes exactly them: `total` inside a table's line is the table's
  assert.equal(printLine('print("total")\nprint(df)', 'total\n   kind  total\n0  edit  12', 1), 'print(df)')
  // the checker's way: a script from a heredoc, a print after a loop of prints
  const script = "python3 - <<'PY'\nimport csv\nruns = list(csv.DictReader(open('runs.csv')))\nprint(len(runs))\nfor r in runs:\n    if r['status'] == 'failed':\n        print(r['id'], r['day'])\nPY"
  assert.deepEqual([0, 2].map(i => printLine(script, '40\nn4 2026-03-04\nn9 2026-03-09', i)), ['print(len(runs))', "print(r['id'], r['day'])"])
})

test('lines that no print wrote can stand anywhere in the output, as any statement can write a warning: a line of code is named by the order of the lines only when no such line could change it, and never for a line Python wrote itself', () => {
  // numpy's warnings, each with the line of code under it, before the output Python held back, as Claude Code's Bash
  // gives them: the count printed 40, the sum 25 (made-up paths)
  const code = 'import numpy as np\nimport pandas as pd\nruns = pd.read_csv("runs.csv")\nprint(len(runs))\nskipped_minutes = np.mean(runs[runs.status == "skipped"].minutes.to_numpy())\nprint((runs.status == "failed").sum())'
  const out = '/made/up/numpy/_core/fromnumeric.py:3862: RuntimeWarning: Mean of empty slice\n  return _methods._mean(a, axis=axis, dtype=dtype,\n/made/up/numpy/_core/_methods.py:142: RuntimeWarning: invalid value encountered in scalar divide\n  ret = ret.dtype.type(ret / rcount)\n40\n25'
  assert.deepEqual([4, 5].map(i => printLine(code, out, i)), ['print(len(runs))', 'print((runs.status == "failed").sum())'])
  // a warning's own line: no print wrote it, though the code has one print, which wrote the lines under it
  const one = 'import pandas as pd\ndf = pd.read_csv("runs.csv")\nprint(df.groupby("status").size())'
  const dtype = '<stdin>:2: DtypeWarning: Columns (4) have mixed types.\nstatus\nfailed    12\npassed    28\ndtype: int64'
  assert.deepEqual([0, 2].map(i => printLine(one, dtype, i)), ['', 'print(df.groupby("status").size())'])
  // a warning whose message goes on over lines of words: the count prints a number, so it printed 12, and the lines
  // of words above it are before any print's
  const sc = 'import pandas as pd\ndf = pd.read_csv("runs.csv")\nfailed = df[df.status == "failed"]\nfailed["late"] = failed.minutes > 30\nprint(len(failed))\nprint(failed.late.sum())'
  const sco = '<stdin>:4: SettingWithCopyWarning: \nA value is trying to be set on a copy of a slice from a DataFrame.\nTry using .loc[row_indexer,col_indexer] = value instead\n\nSee the caveats in the documentation: https://pandas.pydata.org/made-up\n12\n5'
  assert.deepEqual([5, 6, 1].map(i => printLine(sc, sco, i)), ['print(len(failed))', 'print(failed.late.sum())', ''])
  // a child process prints straight away, before the output Python held back: a line of words is not the count's, but
  // a number could be, so 40 under it could be either print's
  const sp = 'import subprocess\nprint(len(runs))\nr = subprocess.run(["wc", "-l", "runs.csv"])\nprint(n_failed)'
  assert.deepEqual([1, 2].map(i => printLine(sp, '41 runs.csv\n40\n12', i)), ['print(len(runs))', 'print(n_failed)'])
  assert.deepEqual([1, 2].map(i => printLine(sp, '41\n40\n12', i)), ['', 'print(n_failed)'])
  // an error stopped the code: its traceback stands first, and a print after the statement that failed never ran, so
  // 12 could be either count's, and the error's line is no print's
  const tb = "import json\nruns = [json.loads(l) for l in open('runs.jsonl')]\nprint(len(runs))\nfailed = [r for r in runs if r['status'] == 'failed']\nprint(len(failed))\nworst = max(failed, key=lambda r: r['minutes'])\nprint(worst['id'])"
  const tf = 'Traceback (most recent call last):\n  File "<stdin>", line 6, in <module>\n  File "<stdin>", line 6, in <lambda>\nKeyError: \'minutes\'\n40\n12'
  assert.deepEqual([4, 5, 3].map(i => printLine(tb, tf, i)), ['print(len(runs))', '', ''])
})
