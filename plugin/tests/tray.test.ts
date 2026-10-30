// The cite and explain tray (tray/): ] at an empty prompt opens it on the acting answer's first citation, which draws in
// focus; its card shows the check and the evidence, its keys show in the bar; a press on a citation opens it too; a
// question typed with it open carries nothing of it and closes the tray; 0 closes it. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { accent, themeLast } from '../core/theme'
import { rowsAt, treeRows } from '../core/trail.mjs'
import { markColors } from '../explain/place.mjs'
import { citeTint } from '../marks/view'
import { evidenceOpener } from '../tray/tray'
import { test } from './kit'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  all(n.children, out)
  return out
}
/** An element's children, beside its props or in them. */
function kidsOf(n: Any): Any[] {
  const c = n?.children ?? n?.props?.children
  return Array.isArray(c) ? c : c == null ? [] : [c]
}

// these tests read the citations Claude wrote, as the auto modes draw them
const CITES = { options: { citations: 'auto cite + verify' } }

const TEXT = 'Of the runs, [12 of 40](#) failed on the p95 check.'
const view = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: view, props: { text, isFirstOfReply: true } }) as never
const above = (maxRows = 20) => ({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }, viewport: view }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

/** The band above the prompt as Claude Code's AbovePromptSite runs it (2.1.312): a hook's tree of at most `maxRows` rows
 *  shows whole and takes no wheel; a taller one shows in a window of maxRows − 1 rows from its offset, over Claude Code's
 *  own row that counts the rows above and below the window, and only over such a band does the person's wheel raise
 *  ui.scroll (the offset it asks for clamped to the tree, the window's rows and the tree's); a move the hooks pass on to
 *  Claude Code (`scrolls`, what reached the test's own ui.scroll) moves the window. `cols`: the band's columns. */
function claudeBand($: Any, scrolls: Any[], maxRows: number, cols = 100) {
  let offset = 0
  const request = () => {
    const a = above(maxRows) as Any
    return { ...a, props: { ...a.props, bodyColumns: cols, scroll: { offset, bodyRows: maxRows - 1 } }, viewport: { ...a.viewport, columns: cols } } as never
  }
  const draw = async () => {
    const tree = await $.ui.render(request())
    const rows = treeRows(tree, cols)
    const cut = rows > maxRows
    const windowRows = cut ? maxRows - 1 : rows
    const maxOffset = rows - windowRows
    offset = Math.min(offset, maxOffset)
    // the rows of the tree the element `key` stands on, and whether the window shows all of them
    const at = (k: string) => { const hit = rowsAt(tree, cols, (n: Any) => n.props?.key === k)[0]; return hit ? { row: hit.row, rows: treeRows(hit.el, cols) } : null }
    const shows = (k: string) => { const a = at(k); return !!a && a.row >= offset && a.row + a.rows <= offset + windowRows }
    const top = all(tree).find(n => n.props?.key === 'tray-window-in')?.props?.top
    return { tree, text: textOf(tree), rows, cut, windowRows, offset, maxOffset, at, shows, top: typeof top === 'number' ? -top : 0, hasWindow: all(tree).some(n => n.props?.key === 'tray-window-in') }
  }
  /** One wheel move of `by` rows over the band, as Claude Code makes it: false when the band takes no wheel. */
  const wheel = async (by: number) => {
    const d = await draw()
    if (!d.cut) return false
    const n = scrolls.length
    await $.ui.scroll({ component: 'AbovePrompt', requestId: 'above', offset: Math.max(0, Math.min(d.maxOffset, d.offset + by)), by, bodyRows: d.windowRows, contentRows: d.rows, origin: { kind: 'person' } } as never)
    const moved = scrolls.slice(n).filter((e: Any) => e?.component === 'AbovePrompt').at(-1)
    if (moved) offset = Math.max(0, Math.min(d.maxOffset, Number(moved.offset) || 0))
    return true
  }
  return { draw, wheel }
}

/** A resumed session with one answer, TEXT (or `more.text`), whose citation the check left as `item` (or whose
 *  citations, a list of items); `more`: the turn's cards, the message's parts and kept files to add (a card's meta.json
 *  under cards/<id>/). */
async function resumed($: Any, on: Any, item: Any, session = 's-tray', more: { cards?: Any[]; parts?: Any; kept?: Record<string, string>; text?: string; env?: Record<string, string>; scrolls?: Any[]; panes?: () => Any[]; deny?: string } = {}): Promise<{ submitted: Any[]; clock: Any; spawns: Any[] }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...(more.env ?? {}) })
  const clock = mock.clock(on, { now: 0 })
  const submitted: Any[] = []
  const spawns: Any[] = []
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: Array.isArray(item) ? item : [item] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: more.cards ?? [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: more.text ?? TEXT, at: 1, ...(more.parts ? { parts: more.parts } : {}) }] }),
    ...(more.kept ?? {}),
  }
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: keptOf(e.path) ? kept[keptOf(e.path)!] : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: [...new Set(Object.keys(kept).filter(k => String(e.path).endsWith(`/${k.split('/')[0]}`)).map(k => k.split('/').slice(0, 3).join('/')))].map(k => ({ name: k.split('/')[1], kind: k.split('/').length > 2 ? 'dir' : 'file' })) }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('config.list', () => ({ value: [] }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', (_$: unknown, e: Any) => { more.scrolls?.push(e); return { value: undefined } })
  on('ui.panes', () => ({ value: more.panes?.() ?? [] }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // `deny`: Claude Code refuses each spawn, saying why
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return (more.deny ? { deny: more.deny } : { model: 'claude-made-up', agentId: `agent-repair-${spawns.length}` }) as never })
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => { submitted.push(e); return { text: e.text } })
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  return { submitted, clock, spawns }
}


// the check verified the citation, with a quote of the file it read: the reply's marks as a resumed session finds them
const QUOTED = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40', reason: 'Line 4 says 12 failed. It counts every run.',
  evidence: { kind: 'quote', file: 'runs/summary.txt', line: '4', lines: [{ n: 3, text: 'runs: 40' }, { n: 4, text: 'failed: 12', highlight: [8, 10] }, { n: 5, text: 'passed: 28' }] },
}

test('] opens the tray on a citation with its evidence; a question asked with it open carries nothing of it; 0 closes it', CITES, async ($, on) => {
  const { submitted, clock } = await resumed($, on, QUOTED)
  // a resumed session: the answer and its checked citation are read back
  // ]: the tray above the bar, on the citation, its keys in its header
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('12 of 40')
  // the header's right: the status, then its keys as the bar draws keys (no kind word); verified says no reason; then
  // the file's place, dim, and the one line that holds the value, after a rule
  expect(band).toContain('✓ verified  a ask · 0 close')
  expect(band).not.toContain('· citation')
  expect(band).not.toContain('Line 4 says')
  expect(band).toContain('runs/summary.txt:4│failed: 12')
  expect(band).not.toContain('4 │')
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('passed: 28')
  // the value bold in the citations' look, the place dim
  const drawnBand = all(await $.ui.render(above()))
  expect(drawnBand.some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '12')).toBe(true)
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'runs/summary.txt:4')?.props).toMatchObject({ dimColor: true })
  // each key once: the bar under it keeps its own keys and names none of the tray's
  expect(band.match(/a ask/g)).toEqual(['a ask'])
  expect(band.match(/0 close/g)).toEqual(['0 close'])
  expect(band).toContain('s rewrite')
  // the citation draws in focus in the answer
  const drawn = await $.ui.render(answer('row-t1', TEXT))
  const cite = all(drawn).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  expect(all(cite).some(n => n.type === 'Text' && n.props?.backgroundColor === citeTint() && n.props?.bold === true && textOf(n) === '12 of 40')).toBe(true)

  // a question typed with the tray open is not about the citation: no scope goes with it (only that the person opened
  // it, core/engaged.ts), the tray closes, and the prompt shows nothing under it
  await $.prompt.submit({ text: 'why so many?', origin: { kind: 'composer' } } as never)
  const told = (submitted.at(-1).context ?? []).join('\n')
  expect(told).not.toContain('open in the tray')
  expect(told).toContain('They opened the citation "12 of 40"')
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  await $.turn.start({ text: 'why so many?', turnId: 't2' } as never)
  await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'why so many?' }] }, door: 'prompt', origin: { kind: 'composer' }, uuid: 'row-q2' } as never)
  const asked = textOf(await $.ui.render({ plugin: 'thimble', component: 'UserMessage', surface: 'terminal', requestId: 'row-q2', viewport: view, props: { text: 'why so many?', origin: { kind: 'composer' } } } as never))
  expect(asked).not.toContain('▸ about')
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: '', durationMs: 10, isAborted: false } as never)
  await clock.advance(100)

  // a press on the citation opens the tray on it; 0 closes it
  const ui = await $.ui.mount(answer('row-t1', TEXT))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('failed: 12')
  expect(band).not.toContain('a ask')
})

test('a corrected value computed by code: drawn in the reply as a verified one, with no sign; the header says corrected, the line under it what it was, then the line that printed it, its output and + expand; + opens in their place the panel a opens on it, as the side pane draws it, the input of its side thread at its bottom; 0 back, and - too, go back to the one line', CITES, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  const { clock } = await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'corrected', shown: '11 of 40', was: '12 of 40', reason: 'The output says 11. One run was retried.',
    evidence: { kind: 'computed', by: 'checker', code: 'import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)', output: 'runs: 40\nfailed: 11\npassed: 29', highlight: [[17, 19]] },
  }, 's-tray-2')
  // the corrected words draw as a settled citation: underlined, the purple tint on hover, and no sign after them. What
  // they were shows in the tray alone
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  const corrected = drawn.find(n => n.type === 'Text' && textOf(n) === '11 of 40')
  expect(corrected?.props).toMatchObject({ underline: true })
  expect(corrected?.props?.backgroundColor).toBeUndefined()
  expect(corrected?.hover ?? corrected?.props?.hover).toMatchObject({ backgroundColor: citeTint() })
  expect(textOf(drawn)).toContain('11 of 40 failed')
  expect(textOf(drawn)).not.toContain('*')
  expect(textOf(drawn)).not.toContain('12 of 40')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawnBand = all(await $.ui.render(above()))
  let band = textOf(drawnBand)
  // the header's status says corrected, in a checked one's color, what it was under it (no reason), the code line that
  // printed the value, its output line
  expect(band).toContain('✓ corrected  a ask · 0 close')
  expect(band).not.toContain('verified')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === ' corrected')?.props).toMatchObject({ color: 'success' })
  expect(band).toContain('closewas 12 of 40')
  expect(band).not.toContain('corrected; was')
  expect(band).not.toContain('The output says 11')
  expect(band).toContain('print(f"failed: {bad}")│failed: 11')
  // + expand at the end of the ruled block, dim
  expect(band).toContain('│failed: 11│+ expand')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === '+ expand')?.props?.dimColor).toBe(true)
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('print("runs:", n)')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'print(f"failed: {bad}")')?.props?.color).toBe('permission')
  expect(drawnBand.some(n => n.type === 'Code')).toBe(false)
  expect(drawnBand.some(n => n.type === 'Input')).toBe(false)
  // (keys apart, so they are not a word typed)
  await clock.advance(2000)
  // +: the panel a opens on the citation, in place of the one line: what it was, the check's reason, the sentence, the
  // output around the value (the value in the citations' look) and the code; the header keeps the status and the words,
  // and says 0 back
  expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
  const open = all(await $.ui.render(above()))
  band = textOf(open)
  expect(band).toContain('✓ corrected  a ask · 0 back')
  const panel = ['was 12 of 40', 'The output says 11. One run was retried.', 'Output of the code the check ran', 'runs: 40failed: 11passed: 29', 'The code']
  for (const words of panel) expect(band).toContain(words)
  expect(open.find(n => n.type === 'Code')?.props?.source).toBe('import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)')
  expect(open.some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '11')).toBe(true)
  expect(band).not.toContain('+ expand')
  expect(band).not.toContain('collapse')
  // at its bottom, the input of the side thread about the citation, the one a opens
  const input = open.find(n => n.type === 'Input')
  expect(input?.props?.placeholder).toBe('Ask about the citation "11 of 40"…')
  // the panel a opens: the side pane on the citation's evidence, with that thread under it, holds the same
  expect(await $.prompt.edit(key('1'))).toEqual({ text: '', cursor: 0 })
  const pane = all(await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'citation 1', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never))
  for (const words of panel) expect(textOf(pane)).toContain(words)
  expect(pane.find(n => n.type === 'Input')?.props?.placeholder).toBe(input.props.placeholder)
  // back in the tray: + again, then 0 goes back to the one line, and so does -
  await clock.advance(2000)
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  for (const back of ['0', '-']) {
    expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    expect(textOf(await $.ui.render(above()))).toContain('Output of the code the check ran')
    expect(await $.prompt.edit(key(back))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    band = textOf(await $.ui.render(above()))
    expect(band).not.toContain('runs: 40')
    expect(band).toContain('│failed: 11│+ expand')
    expect(band).toContain('a ask · 0 close')
  }
})

test("a value computed by code shows, above its output line, the line that printed it: not the print of another value beside it, though a literal of its own print is a word of the line", CITES, async ($, on) => {
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
    evidence: { kind: 'computed', by: 'checker', code: 'import json\nruns = [json.loads(l) for l in open("runs.jsonl")]\nprint(len(runs))\nprint(sum(r["status"] == "failed" for r in runs))', output: '40\n12', highlight: [[3, 5]] },
  }, 's-tray-said')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('print(sum(r["status"] == "failed" for r in runs))│12')
  expect(band).not.toContain('print(len(runs))')
})

test("a value computed by code beside a command that printed other lines shows no line of code above it: `head` may have printed the cited line, so the script's print after it is not named", CITES, async ($, on) => {
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
    evidence: { kind: 'computed', by: 'main', code: 'head -3 runs.csv\npython3 -c \'import csv; print(sum(1 for r in csv.DictReader(open("runs.csv")) if r["status"] == "failed"))\'', output: 'id,day,status\nn1,2026-03-01,passed\nn2,2026-03-02,failed\n12', highlight: [[49, 55]] },
  }, 's-tray-head')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('n2,2026-03-02,failed')
  expect(band).not.toContain('python3 -c')
})

test("values computed by code whose output opens with Python's warnings, as Claude Code's Bash gives them (stderr first, the output Python held back after): each value shows the print that printed it, the count's above 40 and the sum's above 25", CITES, async ($, on) => {
  const output = '/made/up/numpy/_core/fromnumeric.py:3862: RuntimeWarning: Mean of empty slice\n  return _methods._mean(a, axis=axis, dtype=dtype,\n/made/up/numpy/_core/_methods.py:142: RuntimeWarning: invalid value encountered in scalar divide\n  ret = ret.dtype.type(ret / rcount)\n40\n25'
  const code = 'import numpy as np\nimport pandas as pd\nruns = pd.read_csv("runs.csv")\nprint(len(runs))\nskipped_minutes = np.mean(runs[runs.status == "skipped"].minutes.to_numpy())\nprint((runs.status == "failed").sum())'
  const text = 'The check counted [40 nightly runs](#) in runs.csv, and [25 of them failed](#).'
  const at = (v: string) => [[output.lastIndexOf(v), output.lastIndexOf(v) + 2]]
  await resumed($, on, [
    { n: 1, row: 'row-t1', words: '40 nightly runs', start: 18, end: 38, sentence: text, status: 'verified', shown: '40 nightly runs', evidence: { kind: 'computed', by: 'checker', code, output, highlight: at('40') } },
    { n: 2, row: 'row-t1', words: '25 of them failed', start: 56, end: 78, sentence: text, status: 'verified', shown: '25 of them failed', evidence: { kind: 'computed', by: 'checker', code, output, highlight: at('25') } },
  ], 's-tray-warned', { text })
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('print(len(runs))│40')
  expect(band).not.toContain('.sum())')
  await $.prompt.edit(key(']'))
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('print((runs.status == "failed").sum())│25')
  expect(band).not.toContain('print(len(runs))')
})

// a check's output that holds bytes a terminal acts on (a color code, a NUL), as a test run's colored output does
const RAW = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
  evidence: { kind: 'computed', by: 'checker', code: 'import subprocess\nprint(subprocess.run(["pytest", "-q"], capture_output=True, text=True).stdout)', output: '\u001b[31mFAILED\u001b[0m 12 of 40\u0000\r\n', highlight: [[16, 24]] },
}
/** The strings of a drawing that hold a character Claude Code refuses in a text (a control character). */
const refused = (n: Any) => all(n).flatMap(x => kidsOf(x)).filter(c => typeof c === 'string' && /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(c))

test('a check\'s output that holds bytes that do not print draws them as their escapes, in the tray collapsed and expanded, the value marked: the band keeps drawing', CITES, async ($, on) => {
  await resumed($, on, RAW, 's-tray-raw')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawn = await $.ui.render(above())
  expect(refused(drawn)).toEqual([])
  expect(textOf(drawn)).toContain('\\x1b[31mFAILED\\x1b[0m 12 of 40\\x00')
  expect(all(drawn).some(n => n.type === 'Text' && n.props?.bold === true && textOf(n) === '12 of 40')).toBe(true)
  // + shows all the code and output
  await $.prompt.edit(key('+'))
  drawn = await $.ui.render(above())
  expect(refused(drawn)).toEqual([])
  expect(textOf(drawn)).toContain('\\x1b[31mFAILED\\x1b[0m 12 of 40\\x00')
})

test('a file\'s line that holds bytes that do not print (a log\'s color codes) draws them as their escapes in the tray and in the side pane its place opens: both keep drawing', CITES, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  const line = '\u001b[32mok\u001b[0m failed: 12\u0007'
  await resumed($, on, { ...QUOTED, evidence: { kind: 'quote', file: 'logs/run.log', line: '4', lines: [{ n: 3, text: 'runs: 40' }, { n: 4, text: line, highlight: [line.indexOf('12'), line.indexOf('12') + 2] }, { n: 5, text: 'passed: 28' }] } }, 's-tray-raw-file')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const ui = await $.ui.mount(above())
  const band = await ui.drawn()
  expect(refused(band)).toEqual([])
  expect(textOf(band)).toContain('\\x1b[32mok\\x1b[0m failed: 12\\x07')
  await ui.press({ key: 'tray-file' })
  await ui.unmount()
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'citation 1', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  expect(refused(pane)).toEqual([])
  expect(textOf(pane)).toContain('\\x1b[32mok\\x1b[0m failed: 12\\x07')
  expect(all(pane).some(n => n.type === 'Text' && n.props?.bold === true && textOf(n) === '12')).toBe(true)
})

test("Claude's own words in a reply with a citation draw as Claude Code draws them, escaped nowhere: a no-break space, an emoji of parts joined by zero-width joiners, a Persian word's zero-width non-joiner, the tabs of a recipe and of a table in code blocks", CITES, async ($, on) => {
  const sentence = 'Of the 40 nightly runs, [12 of 40](#) failed 👩‍💻, a failure rate of 30 %.'
  const text = `${sentence}\n\nThe make target the runs call:\n\n\`\`\`make\ntest:\n\tpytest -q\n\tpython3 report.py\n\`\`\`\n\nColumns of runs.tsv:\n\n\`\`\`\nrun\tstatus\tminutes\nnightly-004\tfailed\t18.7\n\`\`\`\n\nIn Persian: می‌خواهم (one word).`
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 24, end: 37, sentence, status: 'verified', shown: '12 of 40',
    evidence: { kind: 'computed', by: 'checker', code: 'print(len(runs))\nprint(n_failed)', output: '40\n12', highlight: [[3, 5]] },
  }, 's-tray-own-words', { text })
  const drawn = await $.ui.render(answer('row-t1', text))
  // the citation draws, so these are thimble's drawing of the reply, not Claude Code's own
  expect(all(drawn).some(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))).toBe(true)
  const words = textOf(drawn)
  for (const own of [' failed 👩‍💻, a failure rate of 30 %.', 'test:\n\tpytest -q\n\tpython3 report.py', 'run\tstatus\tminutes\nnightly-004\tfailed\t18.7', 'می‌خواهم']) expect(words).toContain(own)
  expect(words).not.toMatch(/\\x|\\u/)
})

test('each key of the tray is a click too: + expand as +, 0 back and 0 close in its header as 0, and a click on the citation in the reply or in the tray\'s title closes it', CITES, async ($, on) => {
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
    evidence: { kind: 'computed', by: 'checker', code: 'print("runs:", n)\nprint(f"failed: {bad}")', output: 'runs: 40\nfailed: 12\npassed: 28', highlight: [[17, 19]] },
  }, 's-tray-clicks')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('✓ verified')
  expect(band).toContain('+ expand')
  expect(band).not.toContain('next prompt')
  // + expand: the panel a opens on the citation, as +; 0 back in its header: the one line again, as 0
  let tray = await $.ui.mount(above())
  await tray.press({ key: 'more-press' })
  await tray.unmount()
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('runs: 40failed: 12passed: 28')
  expect(band).toContain('a ask · 0 back')
  tray = await $.ui.mount(above())
  await tray.press({ key: 'tray-0' })
  await tray.unmount()
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('runs: 40')
  expect(band).toContain('+ expand')
  // a click on the citation's words in the tray's title closes it, as in the reply
  tray = await $.ui.mount(above())
  await tray.press({ key: 'tray-title' })
  await tray.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  // a click on the citation opens the tray; a second click on it closes it
  const cite = all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  let reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
  reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  // again open; `0 close` in its header closes it, its key bold in thimble's purple as the bar draws a key
  reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  const zero = all(await $.ui.render(above())).find(n => n.type === 'Button' && n.props?.key === 'tray-0')
  expect(textOf(zero)).toBe('0 close')
  const k = all(zero).find(n => n.type === 'Text' && textOf(n) === '0')
  expect(k?.props).toMatchObject({ bold: true })
  expect(typeof k?.props?.color).toBe('string')
  tray = await $.ui.mount(above())
  await tray.press({ key: 'tray-0' })
  await tray.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
})

test('a citation the check found false: × failed in the header, as any failed one, why in one dim sentence under it, x repair, then its evidence; x starts a check of it again in the background, no turn of main', CITES, async ($, on) => {
  const { submitted, clock, spawns } = await resumed($, on, { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed, but 3 were retried. The rest passed.' }, 's-tray-5')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed  a ask · 0 close')
  expect(band).not.toContain('wrong')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '×')?.props?.color).toBe('error')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === ' failed')?.props?.color).toBe('error')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === 'Line 4 counts 12 failed, but 3 were retried.')?.props).toMatchObject({ dimColor: true })
  expect(band).not.toContain('The rest passed')
  expect(band).toContain('failed: 12')
  // the citation stays underlined in the reply, red, with × after it
  const reply = all(await $.ui.render(answer('row-t1', TEXT)))
  expect(reply.find(n => n.type === 'Text' && textOf(n) === '12 of 40' && n.props?.color)?.props).toMatchObject({ color: 'error', underline: true })
  expect(reply.find(n => n.type === 'Text' && textOf(n) === ' ×')?.props?.color).toBe('error')
  // x repair: in the bar and in the card
  expect(band).toContain('x repair')
  expect(drawn.some(n => n.type === 'Button' && n.props?.label === 'repair this citation')).toBe(true)
  // x: a checker fork for this one citation, once the word window has passed; no turn of main
  await clock.advance(2000)
  expect(await $.prompt.edit(key('x'))).toEqual({ text: '', cursor: 0 })
  expect(spawns.length).toBe(0)
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  expect(spawns[0].description).toBe('checking a citation again (x)')
  expect(spawns[0].prompt).toContain('PROMPT checker')
  expect(spawns[0].prompt).toContain('The analyst pressed x to repair citation 1.')
  expect(spawns[0].prompt).toContain('The first check found it wrong: "Line 4 counts 12 failed, but 3 were retried. The rest passed."')
  expect(submitted.length).toBe(0)
  // (the test kit names no agent it starts, so the fork's run and end are marks.test.ts's)
})

const WRONG = { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed.' }

// a reply with two citations, each in its own words
const TWO = 'Of the runs, [12 of 40](#) failed on the [p95 check](#).'
const SECOND = { n: 2, row: 'row-t1', words: 'p95 check', start: 41, end: 55, sentence: TWO, shown: 'p95 check' }

test('a repair that corrected the citation says repaired in its header and what it was under it; one that still could not confirm it says not repaired and why, and offers x again', CITES, async ($, on) => {
  await resumed($, on, [
    { ...WRONG, sentence: TWO, status: 'corrected', repair: true, shown: '9 of 40', was: '12 of 40' },
    { ...SECOND, status: 'failed', failedBy: 'evidence', repair: true, reason: 'No file holds a count of failed runs.' },
  ], 's-tray-10', { text: TWO })
  await $.prompt.edit(key(']'))
  const card = textOf(await $.ui.render(above()))
  // ] stays on the bar while the tray is open; the header keeps the tray's own keys
  expect(card).toContain('✓ repaired  a ask · 0 close')
  expect(card).toContain('thimble  ] next citation')
  expect(card).toContain('closewas 12 of 40')
  expect(card).not.toContain('repaired; was')
  expect(card).not.toContain('x repair')
  await $.prompt.edit(key(']'))
  const again = textOf(await $.ui.render(above()))
  expect(again).toContain('not repaired: No file holds a count of failed runs.')
  expect(again).toContain('x repair')
})



test('a citation whose check did not run is failed: × in the reply, × failed in the card with the plain reason, and x starts its check; so is a check the session ended mid-way', CITES, async ($, on) => {
  // an earlier thimble kept the first as unchecked, with no evidence, and the second as checking when its session
  // ended: the resumed session finds both failed
  const { evidence: _e, ...words } = QUOTED
  const { clock, spawns, submitted } = await resumed($, on, [
    { ...words, sentence: TWO, status: 'unchecked', reason: 'the reply was interrupted before its citations were checked' },
    { ...SECOND, status: 'checking' },
  ], 's-tray-12', { text: TWO })
  const reply = all(await $.ui.render(answer('row-t1', TWO)))
  expect(reply.find(n => n.type === 'Text' && textOf(n) === '12 of 40' && n.props?.color)?.props).toMatchObject({ color: 'error', underline: true })
  expect(reply.find(n => n.type === 'Text' && textOf(n) === ' ×')?.props?.color).toBe('error')
  await $.prompt.edit(key(']'))
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed  a ask · 0 close')
  expect(band).toContain('thimble  ] next citation')
  expect(band).not.toContain('not checked')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === 'The check did not run.')?.props).toMatchObject({ dimColor: true })
  expect(band).not.toContain('gave no evidence')
  expect(band).toContain('x repair: start its check')
  expect(drawn.some(n => n.type === 'Button' && n.props?.label === 'check this citation')).toBe(true)
  // the one the session ended mid-way: failed, and x offered
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  const ended = textOf(await $.ui.render(above()))
  expect(ended).toContain('p95 check')
  expect(ended).toContain('× failed  a ask · 0 close')
  expect(ended).toContain('thimble  [ previous citation')
  expect(ended).toContain('The check did not run.')
  expect(ended).not.toContain('session ended')
  expect(ended).toContain('x repair')
  // x on the first starts its check
  await clock.advance(2000)
  await $.prompt.edit(key('['))
  await clock.advance(2000)
  await $.prompt.edit(key('x'))
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  expect(spawns[0].prompt).toContain('The analyst pressed x to check citation 1, whose first check did not run.')
  expect(spawns[0].prompt).not.toContain('right value')
  expect(submitted.length).toBe(0)
  // (the test kit names no agent it starts, so the check's run and end are marks.test.ts's)
})


// A click on the file's place in the tray opens the citation's evidence in the side pane, by a button or, where the
// terminal draws hyperlinks, by the link
for (const [how, env] of [['a button', {}], ['a file link', { FORCE_HYPERLINK: '1' }]] as const) {
  test(`a click on the file's place in the tray (${how}) opens the citation's evidence in the side pane`, CITES, async ($, on) => {
    const opens: Any[] = []
    on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: { isPlaced: true } } as never })
    on('ui.close', () => ({ value: undefined }))
    await resumed($, on, QUOTED, `s-tray-pane-${how}`, { env })
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    const ui = await $.ui.mount(above())
    const place = all(await ui.drawn()).find(n => n.props?.key === 'tray-file')
    expect(place?.type).toBe(how === 'a button' ? 'Button' : 'Markdown')
    await ui.press(place.type === 'Markdown' ? { key: 'tray-file', link: { href: place.props.pressableLinks[0] } } : { key: 'tray-file' })
    await ui.unmount()
    expect(opens).toEqual(['thimble'])
    expect(textOf(await $.ui.render(above()))).not.toContain("didn't open here")
  })
}
test("a corrected citation's evidence in the side pane says ✓ corrected and what it was, as its tray does", CITES, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  await resumed($, on, { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40' }, 's-tray-pane-corrected')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const ui = await $.ui.mount(above())
  await ui.press({ key: 'tray-file' })
  await ui.unmount()
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'citation 1', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  const words = textOf(pane)
  expect(words).toContain('✓ corrected  11 of 40')
  expect(words).not.toContain('verified')
  expect(words).toContain('was 12 of 40')
  expect(words).not.toContain('corrected; was')
  for (const t of ['✓', ' corrected']) expect(all(pane).find(n => n.type === 'Text' && textOf(n) === t)?.props).toMatchObject({ color: 'success', bold: true })
})

// Claude Code places a pane at any width only for an open made while the person's press runs; an open the handler
// leaves to run after it returns is unasked and waits undrawn below 144 columns (the tray's file place showed "did not
// open the side pane" at 118 columns). The test kit's press waits for such work too, so the handler is called here as
// Claude Code calls it: the open must be made by the time what it returns settles.
test("the tray's file place makes its pane open inside the press, before its handler settles", async () => {
  const opens: string[] = []
  const notices: string[] = []
  const later = <T>(v: T) => new Promise<T>(r => setTimeout(() => r(v), 1))
  const state = new Map<string, unknown>()
  const $: Any = {
    state: { get: (k: Any) => later({ value: state.get(k.key) ?? null }), set: (k: Any, v: unknown) => later(void state.set(k.key, v)) },
    ui: { open: (p: Any) => later((opens.push(p.id), { isPlaced: true })), panes: () => later([]), close: () => later(undefined), toast: (t: string) => later(void notices.push(t)) },
  }
  const pressed = evidenceOpener($, { row: 'row-t1', n: 1 })()
  expect(pressed).toBeInstanceOf(Promise)
  await pressed
  expect(opens).toEqual(['thimble'])
  expect(state.get('pane')).toMatchObject({ kind: 'evidence', args: { row: 'row-t1', n: 1 } })
})

// A press on the file's place opens the pane at any width; where Claude Code still places none (no surface here draws
// panes), the notice says so and sends the person to what shows the evidence: not to the reply's citation, whose press
// opens the tray they already have
test("the tray's file place where no pane can open: the notice does not send the person to the reply's citation", async () => {
  const state = new Map<string, unknown>()
  const $: Any = {
    state: { get: async (k: Any) => ({ value: state.get(k.key) ?? null }), set: async (k: Any, v: unknown) => void state.set(k.key, v) },
    ui: { open: async () => ({ isPlaced: false, reason: 'no attached surface places panes' }), panes: async () => [], close: async () => undefined },
  }
  await evidenceOpener($, { row: 'row-t1', n: 1 })()
  await new Promise(r => setTimeout(r, 1))
  const line = state.get('failLine') as Any
  expect(line?.kind).toBe('failed')
  expect(String(line?.text)).toContain("Claude Code did not open the citation's evidence here")
  expect(String(line?.text)).not.toContain('citation in the reply')
})

// Claude Code places a pane at any width only for the person's press or command, never for a key at the prompt (its
// prompt.edit is no person's input): below 144 columns a at the prompt cannot open the thread, so the bar names what
// opens it there, a click on `a ask` in the bar; that press opens it at any width
test('a on a card at a narrow terminal: the bar names the click on a ask, and that press opens the thread', CITES, async ($, on) => {
  const id = 'c0123456789ac'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_1', turn: 't1', agentId: null, anchorRow: null, keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_1: { version: 1 } }, at: 1 }
  const opens: Any[] = []
  let wide = false
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: wide ? { isPlaced: true } : { isPlaced: false, reason: 'unasked below 144 columns (118 now)' } } as never })
  on('ui.close', () => ({ value: undefined }))
  const { clock } = await resumed($, on, QUOTED, 's-tray-narrow', {
    cards: [{ id, toolUseId: 'toolu_made_up_1', seq: 1, after: 0 }],
    kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) },
  })
  // each key after the one before's word window
  for (const k of [']', '[', 'a']) {
    expect(await $.prompt.edit(key(k))).toEqual({ text: '', cursor: 0 })
    await clock.advance(1000)
  }
  expect(opens).toEqual(['thimble'])
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('a needs a wider terminal: widen the window to show the side pane, or click “a ask”.')
  expect(band).not.toContain('Hint:')
  expect(band).toContain('a ask')
  // the press on a ask in the bar: Claude Code places it
  wide = true
  const ui = await $.ui.mount(above())
  await ui.press({ key: 'bar-tray-a' })
  await ui.unmount()
  expect(opens).toEqual(['thimble', 'thimble'])
  // open now: the notice goes
  expect(textOf(await $.ui.render(above()))).not.toContain('Hint: click')
})

// a heads-up on the citation's words, with long bullets, and an explainer after it
const HEADS = {
  explain: {
    order: ['h1', 'g1'],
    items: {
      h1: { id: 'h1', kind: 'heads', term: '12 of 40', title: 'Retried runs count twice', bullets: [
        'Four of the runs were retried after a timeout, and the summary file counts each try as its own run, so the share of failures reads higher than the share of distinct runs.',
        'The check read the summary file only, so it cannot say which of the tries failed or whether a retry passed later on in the same sweep of runs.',
        'The runs that were not retried all finished inside their budget, so the timeout explains the retries but not the failures among the other runs.',
      ] },
      g1: { id: 'g1', term: 'p95', body: 'The time that 95 of 100 checks stay under.', here: 'The sweep [lists it per run](runs/summary.txt#L4), and [the config sets the limit](conf/limits.toml#L2-3).' },
    },
  },
}

test('a heads-up on a citation\'s words is one ] away; it shows whole, with no paging, no order to the reader and no line about the next prompt', CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-4', { parts: HEADS })
  // ]: the heads-up first, not the citation under it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('a ask · 0 close')
  expect(band).toContain('Retried runs count twice')
  expect(band).toContain('but not the failures among the other runs.')
  expect(band).not.toContain('? ask about this heads-up')
  expect(band).toContain('] next citation')
  for (const gone of ['m more', 'lines 1–', 'Your next prompt', 'leave it out', 'Claude can do this', 'o ask']) expect(band).not.toContain(gone)
  expect(all(await $.ui.render(above(40))).some(n => n.props?.key === 'tray-page' || n.props?.key === 'tray-window')).toBe(false)
  // ] goes on to the citation, then the explainer after it
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})

test('an open tray stays as it is while the person scrolls the transcript under it: the answer showing other rows of itself, or none, closes nothing; ] opens the next mark in its place, and 0 closes it', CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-scroll', { parts: HEADS })
  // the answer's row as the fullscreen transcript draws it, with the rows of it that its viewport shows
  const row = (onScreen: Any) => $.ui.render({ ...(answer('row-t1', TEXT) as Any), props: { text: TEXT, isFirstOfReply: true, onScreen } } as never)
  const band = async () => {
    await clock.advance(10)
    return textOf(await $.ui.render(above(40)))
  }
  await row({ first: 0, last: 3, of: 4 })
  // ]: the heads-up on the citation's words
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(await band()).toContain('Retried runs count twice')
  await row({ first: 0, last: 3, of: 4 })
  // the person scrolls the transcript back, under a band of the same rows, until the answer leaves the screen, and down
  // again: the heads-up stays open throughout, and the bar names ] on the citation after it
  for (const r of [{ first: 1, last: 3, of: 4 }, { first: 0, last: 2, of: 4 }, { first: 0, last: 0, of: 4 }, null, { first: 0, last: 3, of: 4 }]) {
    await row(r)
    const now = await band()
    expect(now).toContain('Retried runs count twice')
    expect(now).toContain('a ask · 0 close')
    expect(now).toContain('] next citation')
  }
  // ] opens the citation in its place, which a scroll leaves open too; 0 closes it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(await band()).toContain('failed: 12')
  await row(null)
  expect(await band()).toContain('failed: 12')
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(await band()).not.toContain('a ask · 0 ')
})

// a value code computed, the citation's evidence ten lines of output
const OUTPUT = ['runs: 40', ...Array.from({ length: 8 }, (_, i) => `run ${i + 1}: ok`), 'failed: 12'].join('\n')
const TALL = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
  evidence: { kind: 'computed', by: 'checker', code: 'print("runs:", n)\nfor i, r in enumerate(runs):\n    print(f"run {i + 1}: {r}")\nprint(f"failed: {bad}")', output: OUTPUT, highlight: [[OUTPUT.length - 2, OUTPUT.length]] },
}

/** The band as claudeBand draws it, and what it shows of the tray: whether the bar is the last row of Claude Code's
 *  window (the tray in the rows over it), how many rows stand under that window (which Claude Code's row counts), the
 *  rows of the tray's body window, the rows of its body above and under that window, and whether the last row of an
 *  element of the body (`pred`) shows in that window. The tray's body is laid out 93 columns wide in the band's 100. */
async function cutBand(band: { draw: () => Promise<Any> }): Promise<Any> {
  const d = await band.draw()
  const bar = d.at('bar')
  const win = all(d.tree).find(n => n.props?.key === 'tray-window')
  const body = all(d.tree).find(n => n.props?.key === 'tray-window-in')
  const rows = win ? Number(win.props.height) : 0
  const tall = body ? treeRows(body, 93) : 0
  const inView = (pred: (n: Any) => boolean) => !!body && rowsAt(body, 93, pred).some((h: Any) => { const last = h.row + treeRows(h.el, 93) - 1; return last >= d.top && last < d.top + rows })
  return { ...d, barLast: !!bar && bar.row + bar.rows === d.windowRows, under: d.rows - d.windowRows, win: rows, above: d.top, below: Math.max(0, tall - rows - d.top), inView }
}

test('a box taller than the band shows as much of its body as the rows Claude Code shows over the bar hold, from its top, its head and the bar in view, and nothing under it: no d or u, which are typed. Each row of the body under its window adds a blank row under the bar (two at least), out of that window, which Claude Code\'s row under it counts and for which it hands the band the wheel: the wheel moves the box\'s window a row a tick, to the body\'s end and back, and never the band. A band too short for a row of the body is cut by Claude Code, which scrolls it', CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const scrolls: Any[] = []
  const { clock } = await resumed($, on, QUOTED, 's-tray-cut', { parts: HEADS, scrolls })
  // the band's moves that reached Claude Code's own scroll of it
  const bandScrolls = () => scrolls.filter(e => e?.component === 'AbovePrompt').length
  // ]: the heads-up on the citation's words, three long bullets; in a band of forty rows it shows whole, as the band does
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  let d = await cutBand(claudeBand($, scrolls, 40))
  expect(d.cut).toBe(false)
  expect(d.hasWindow).toBe(false)
  // the session's start said the card sandbox cannot start here, a failure line that wraps above the bar: in a band of
  // twelve rows the box takes the rows over all of it, as many of its body's rows as they hold, from its top; the bar is
  // the last row of Claude Code's window, with the failure line over it and the box's head in view
  const band = claudeBand($, scrolls, 12)
  d = await cutBand(band)
  expect(d.cut).toBe(true)
  expect(d.hasWindow).toBe(true)
  expect(d.barLast).toBe(true)
  for (const k of ['tray-head', 'fail-line', 'bar']) expect(d.shows(k)).toBe(true)
  expect(d.offset).toBe(0)
  expect(d.above).toBe(0)
  expect(d.win).toBeGreaterThanOrEqual(2)
  // nothing under the box's body but its frame: no row of lines above or below, no d or u
  expect(all(d.tree).some(n => /^tray-(page|scroll|more)/.test(String(n.props?.key ?? '')))).toBe(false)
  expect(d.text).not.toMatch(/more lines?|lines? above|expand/)
  expect(await $.prompt.edit(key('d'))).toEqual({ text: 'd', cursor: 1 })
  expect(await $.prompt.edit(key('u'))).toEqual({ text: 'u', cursor: 1 })
  await clock.advance(2000)
  // under the bar, out of Claude Code's window, a blank row for each row of the body under the box's window
  expect(d.under).toBe(d.below)
  expect(d.below).toBeGreaterThan(2)
  const over = d.below
  // the wheel over the band: the box's window a row a tick, the band's own staying at its start; the rows under it one
  // fewer each tick, while there are more than two
  await band.wheel(1)
  let e = await cutBand(band)
  expect(e.above).toBe(1)
  expect(e.under).toBe(d.under - 1)
  expect(e.offset).toBe(0)
  // to the body's end: its last rows in view, the head and the bar too; on, nothing moves
  await band.wheel(100)
  e = await cutBand(band)
  expect(e.below).toBe(0)
  expect(e.above).toBe(over)
  expect(e.under).toBe(2)
  for (const k of ['tray-head', 'fail-line', 'bar']) expect(e.shows(k)).toBe(true)
  const end = e.above
  await band.wheel(3)
  expect((await cutBand(band)).above).toBe(end)
  // and back to its top
  await band.wheel(-100)
  e = await cutBand(band)
  expect(e.above).toBe(0)
  expect(e.offset).toBe(0)
  expect(bandScrolls()).toBe(0)
  // another mark starts at its top: ] the citation under the heads-up, [ back to the heads-up
  await band.wheel(2)
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await $.prompt.edit(key('['))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect((await cutBand(band)).above).toBe(0)
  // a band too short for a row of the box's body: the box shows whole, and Claude Code cuts the band, its window from
  // the band's start, and its wheel moves the band
  const short = claudeBand($, scrolls, 5)
  d = await cutBand(short)
  expect(d.cut).toBe(true)
  expect(d.hasWindow).toBe(false)
  expect(d.shows('tray-head')).toBe(true)
  await short.wheel(1)
  d = await cutBand(short)
  expect(d.offset).toBe(1)
  expect(bandScrolls()).toBe(1)
})

test('the panel + opens on a citation whose code and output are long keeps its head, its input and the bar in view in a band too short for it: the wheel moves its body, from what the check found to the code\'s last line. A question asked in its input asks the side thread about the citation, whose conversation shows at the panel\'s end', CITES, async ($, on) => {
  const scrolls: Any[] = []
  const { clock, spawns } = await resumed($, on, TALL, 's-tray-panel', { scrolls })
  await $.prompt.submit({ text: 'and the other runs?', origin: { kind: 'composer' } } as never)
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  const band = claudeBand($, scrolls, 12)
  const input = (t: Any) => all(t).find(n => n.type === 'Input')
  let d = await cutBand(band)
  expect(d.cut).toBe(true)
  expect(d.barLast).toBe(true)
  // from its top: the sentence, then the output of the check's code; the input under the body's window
  expect(d.inView((n: Any) => n.type === 'Text' && textOf(n) === 'Output of the code the check ran')).toBe(true)
  expect(d.inView((n: Any) => n.type === 'Code')).toBe(false)
  expect(input(d.tree)?.props?.placeholder).toBe('Ask about the citation "12 of 40"…')
  const field = String(input(d.tree).props.key)
  for (const k of ['tray-head', field, 'bar']) expect(d.shows(k)).toBe(true)
  expect(d.at(field)!.row).toBeGreaterThan(d.at('tray-window')!.row + d.win - 1)
  // the wheel to the body's end: the code's last line in view, over the input, the head and the bar still in view
  await band.wheel(100)
  d = await cutBand(band)
  expect(d.below).toBe(0)
  expect(d.inView((n: Any) => n.type === 'Code')).toBe(true)
  for (const k of ['tray-head', field, 'bar']) expect(d.shows(k)).toBe(true)
  expect(d.offset).toBe(0)
  await band.wheel(-100)
  // a question asked in the input: a fork answers it in the side thread about the citation, and the panel shows the
  // thread's conversation after the code, the window moved to its end
  const mounted = await $.ui.mount(above(12))
  await mounted.input({ key: field, text: 'which runs failed?' })
  await mounted.unmount()
  await clock.advance(1000)
  expect(spawns.map(s => s.description)).toEqual(['thread · the citation "12 of 40"'])
  d = await cutBand(band)
  expect(d.text).toContain('❯ which runs failed?')
  expect(d.below).toBe(0)
  expect(d.above).toBeGreaterThan(0)
  for (const k of ['tray-head', 'bar']) expect(d.shows(k)).toBe(true)
  expect(input(d.tree)).toBeDefined()
})

// a heads-up whose words are a citation's words, or hold them
const headsOn = (term: string) => ({ explain: { order: ['h1'], items: { h1: { id: 'h1', kind: 'heads', term, title: 'Names are typed in', bullets: ['Anyone who edits types a name.'] } } } })
const filledOf = (drawn: Any[]) => drawn.filter(n => n.type === 'Text' && n.props?.backgroundColor).map(textOf)

test("a heads-up on a citation's words stays on them when the check corrects them, never on the same word elsewhere in the reply", CITES, async ($, on) => {
  const text = 'The edits came from [3,103 different usernames](#). Each run has a different fake date.'
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '3,103 different usernames', start: 20, end: 50, sentence: 'The edits came from [3,103 different usernames].', status: 'corrected', shown: '3,102 different usernames', was: '3,103 different usernames', reason: 'Line 2 says 3102.',
    evidence: { kind: 'quote', file: 'names.txt', line: '2', lines: [{ n: 2, text: 'names: 3102' }] },
  }, 's-tray-heads-corrected', { text, parts: headsOn('3,103 different usernames') })
  const drawn = all(await $.ui.render(answer('row-t1', text)))
  expect(filledOf(drawn)).toEqual(['3,102 different usernames'])
  // the words keep the citation's underline, and a press on them opens the heads-up first (] goes on to the citation)
  const press = drawn.find(n => n.type === 'Button' && all(n).some((t: Any) => t.type === 'Text' && textOf(t) === '3,102 different usernames'))
  expect(String(press?.props.label)).toMatch(/^heads up/)
  expect(all(press).find(n => n.type === 'Text' && textOf(n) === '3,102 different usernames')?.props).toMatchObject({ underline: true })
  expect(textOf(drawn)).not.toContain('the check of the citations changed')
})

test('a heads-up whose words hold a citation covers them all: its fill under the citation\'s underline, every word a press of the heads-up', CITES, async ($, on) => {
  const text = 'Answers were shared by [1,212 accounts](#) in June.'
  await resumed($, on, { ...QUOTED, words: '1,212 accounts', start: 23, end: 42, sentence: 'Answers were shared by [1,212 accounts] in June.', shown: '1,212 accounts' }, 's-tray-heads-over', { text, parts: headsOn('by 1,212 accounts') })
  const drawn = all(await $.ui.render(answer('row-t1', text)))
  expect(filledOf(drawn)).toEqual(['by ', '1,212 accounts'])
  const press = drawn.find(n => n.type === 'Button' && all(n).some((t: Any) => t.type === 'Text' && textOf(t) === '1,212 accounts'))
  expect(all(press).find(n => n.type === 'Text' && textOf(n) === '1,212 accounts')?.props).toMatchObject({ underline: true })
  // all its words open the heads-up, the citation's too; ] reaches it first, then the citation
  expect(press?.props.label).toBe('heads up by 1,212 accounts')
  expect(drawn.some(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))).toBe(false)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(12)))).toContain('Names are typed in')
})

test('`a ask` in the tray\'s header opens a side thread about the heads-up; a prompt typed with it open carries nothing of it', CITES, async ($, on) => {
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', () => ({ value: undefined }))
  const { submitted } = await resumed($, on, QUOTED, 's-tray-ask', { parts: HEADS })
  await $.prompt.edit(key(']'))
  const ui = await $.ui.mount(above(40))
  const head = all(await $.ui.render(above(40))).find(n => n.props?.key === 'tray-head')
  expect(textOf(head)).toMatch(/a ask · 0 close$/)
  expect(textOf(head)).not.toContain(']')
  expect(all(head).find(n => n.props?.key === 'tray-a')?.props.label).toBe('ask about the heads-up "Retried runs count twice"')
  await ui.press({ key: 'tray-a' })
  await ui.unmount()
  expect(opens).toEqual(['thimble'])
  // a prompt typed with a heads-up open: no scope of it, no `▸ about` (Claude reads it with the comments anyway)
  await $.prompt.edit(key(']'))
  await $.prompt.submit({ text: 'what else?', origin: { kind: 'composer' } } as never)
  const told = (submitted.at(-1).context ?? []).join('\n')
  expect(told).not.toContain('open in the tray')
})

test("an explainer's or a heads-up's links to a file's lines draw as the answer's citations: one of lines the answer cites opens that citation, another the lines themselves", CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-links', { parts: HEADS, kept: { 'conf/limits.toml': '[limits]\np95_ms = 800\ntimeout_s = 30\n' } })
  // ] heads-up, ] citation, ] explainer
  for (let i = 0; i < 3; i++) { await clock.advance(2000); await $.prompt.edit(key(']')) }
  const drawn = all(await $.ui.render(above(40)))
  const cites = drawn.filter(n => n.type === 'Button' && String(n.props?.label).startsWith('citation '))
  expect(cites.map(n => n.props.label)).toEqual(['citation 1: lists it per run', 'citation 0: the config sets the limit'])
  // underlined in the text's color, the citations' tint on hover, as in the answer: no link color
  const words = all(cites[1]).find(n => n.type === 'Text' && textOf(n) === 'the config sets the limit')
  expect(words?.props).toMatchObject({ underline: true })
  expect(words?.props.color).toBe(undefined)
  expect(drawn.some(n => n.type === 'Markdown' && String(n.props.text).includes('conf/limits.toml'))).toBe(false)
  // the one of the lines the answer cites opens that citation, over the explainer
  let ui = await $.ui.mount(above(40))
  await ui.press({ key: cites[0].props.key })
  await ui.unmount()
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  // the other opens its lines, as a citation of a file shows them; 0 goes back to the explainer
  ui = await $.ui.mount(above(40))
  await ui.press({ key: cites[1].props.key })
  await ui.unmount()
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('conf/limits.toml:2-3')
  expect(band).toContain('2  p95_ms = 800')
  expect(band).toContain('3  timeout_s = 30')
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})

test('c cites the selected words in auto cite + verify too: while they wait the bar says c cite beside the claims\' w claims, and c opens their citation in the tray; with none selected, c is a letter of the prompt, and w opens Claims', CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); return { value: { isPlaced: true } } as never })
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  on('ui.selection', () => ({ value: selected }))
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite')
  // the claims keep their item on the bar while words wait: c and w each name one thing
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('c cite')
  expect(band).toContain('w claims')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started; the selection no longer waits
  band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('failed on the p95 check')
  expect(band).toContain('a ask · 0 close')
  expect(spawns.length).toBe(1)
  expect(band).not.toContain('c cite')
  expect(band).toContain('w claims')
  // with nothing selected, c is typed and opens nothing, as q, a letter no one takes (the first such letter reads what
  // the cards' keys need, once); at the key c reads the selection and none of the state: the open tray's citation,
  // which c does not act on, is not read for it
  selected = undefined
  expect(await $.prompt.edit(key('q'))).toEqual({ text: 'q', cursor: 1 })
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  expect(gets).toBe(0)
  await clock.advance(1000)
  expect(opens).toEqual([])
  // w opens Claims
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims'])
})

test('with Claims off, c cites the selected words, and with none selected c is a letter of the prompt, since nothing on the bar names it', { options: { citations: 'auto cite + verify', claimsMode: 'off' } }, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); return { value: { isPlaced: true } } as never })
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  on('ui.selection', () => ({ value: selected }))
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-off')
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started
  expect(textOf(await $.ui.render(above(40)))).toContain('failed on the p95 check')
  expect(spawns.length).toBe(1)
  // nothing selected: c is typed, and opens nothing; so is w, whose pane is off
  selected = undefined
  expect(textOf(await $.ui.render(above(40)))).not.toContain('c cite')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  await clock.advance(1000)
  expect(await $.prompt.edit(key('w'))).toEqual({ text: 'w', cursor: 1 })
  await clock.advance(1000)
  expect(opens).toEqual([])
})

test("c with words selected reads the selection once and no state at the key, however many answers the session holds: whether they wait is kept from the bar's drawing, and words selected since are checked in full", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // words dragged over more than one row: Claude Code names no row, so they are looked for in every answer
  let selected: Any = { text: 'failed on the p95 check' }
  let selections = 0
  on('ui.selection', () => { selections++; return { value: selected } })
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  // sixty answers after the one that holds the words
  const kept: Record<string, string> = {}
  for (let n = 2; n <= 61; n++) {
    kept[`answers/t${n}.json`] = JSON.stringify({ v: 1, turn: { turnId: `t${n}`, n, prompt: { text: `and run ${n}?`, by: 'composer', row: `row-q${n}` }, rows: [`row-t${n}`], answer: `row-t${n}`, reason: 'answer', startedAt: n, endedAt: n, labels: [], cards: [], seq: 0 }, msgs: [{ row: `row-t${n}`, turnId: `t${n}`, text: `Run ${n} passed every check.`, at: n }] })
  }
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-long', { kept })
  // the bar draws, and names c cite
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // c: one read of the selection, none of the state, within the hook's few milliseconds
  gets = 0
  selections = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBe(0)
  expect(selections).toBe(1)
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started
  expect(textOf(await $.ui.render(above(40)))).toContain('failed on the p95 check')
  expect(spawns.length).toBe(1)
  // cited, the selection no longer waits: c is typed, and reads no state either (q, a letter no one takes, first reads
  // what the cards' keys need, once)
  expect(await $.prompt.edit(key('q'))).toEqual({ text: 'q', cursor: 1 })
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  expect(gets).toBe(0)
  // words selected since the bar last drew: the key checks them in full, and c cites them
  selected = { text: 'Run 7 passed every check' }
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(spawns.length).toBe(2)
})

test("a double click on one of the bar's items selects its word, which is the bar's, not the answer's that also has it: the bar names neither c nor e; the answer's words, as its row draws them, still count", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  await resumed($, on, { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40' }, 's-tray-control', { text: 'Of the runs, [12 of 40](#) failed on the p95 check, as the claims show.' })
  expect(textOf(await $.ui.render(above()))).toContain('w claims')
  // `claims`, as a double click on the bar's `w claims` selects it
  selected = { text: 'claims' }
  let band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('c cite')
  expect(band).not.toContain('e explain')
  // the same word in the answer, among others
  selected = { text: 'as the claims show', requestId: 'row-t1' }
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // the corrected words the row draws in place of the citation's
  expect(textOf(await $.ui.render(answer('row-t1', 'Of the runs, [12 of 40](#) failed on the p95 check, as the claims show.')))).toContain('11 of 40 failed')
  selected = { text: 'runs, 11 of 40 failed', requestId: 'row-t1' }
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('c cite')
})

test("a click on thimble's controls that slid a cell leaves a piece of their words selected, no answer's words though the answer holds it whole: on the bar, the tray and a card's header on screen; once those are gone, their words in an answer count again", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const text = 'Of the runs, [12 of 40](#) failed on the p95 check: it is in a sweep where 0 runs pass, so ask before you close it as done.'
  const id = 'c0123456789ad'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_9', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_9: { version: 1 } }, at: 1 }
  const { clock } = await resumed($, on, QUOTED, 's-tray-slid', { text, kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  const counts = async (sel: Any) => {
    // a selection made anew: none in between, as the click that makes it takes the one before down
    selected = undefined
    await $.ui.render(above(40))
    selected = sel
    const band = textOf(await $.ui.render(above(40)))
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  // words of the answer: the bar names c and e
  expect(await counts({ text: 'failed on the p95 check', requestId: 'row-t1' })).toBe(true)
  // a click on the bar's `e explain` as it names it, then on `s rewrite` and `thimble`
  selected = { text: 'in' }
  expect(textOf(await $.ui.render(above(40)))).not.toContain('c cite')
  expect(textOf(await $.ui.render(above(40)))).not.toContain('e explain')
  expect(await counts({ text: 'it' })).toBe(false)
  expect(await counts({ text: 'im' })).toBe(false)
  // the tray open: a click on its `a ask` or `0 close`
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(textOf(await $.ui.render(above(40)))).toContain('a ask · 0 close')
  expect(await counts({ text: 'a' })).toBe(false)
  expect(await counts({ text: 'as' })).toBe(false)
  expect(await counts({ text: '0 ' })).toBe(false)
  // the answer's own words still count while the tray is open
  expect(await counts({ text: 'a sweep', requestId: 'row-t1' })).toBe(true)
  // a card under the answer, on screen: a click on its header's `p artifact` or `a ask`, in the answer's row
  expect(textOf(await $.ui.render(answer('row-t1', text)))).toContain('Runs by status')
  expect(await counts({ text: 'p', requestId: 'row-t1' })).toBe(false)
  expect(await counts({ text: 'as', requestId: 'row-t1' })).toBe(false)
  // the tray closed and the card out of view: those words in the answer count again
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(textOf(await $.ui.render(above(40)))).not.toContain('0 close')
  await $.ui.render({ ...(answer('row-t1', text) as Any), props: { text, isFirstOfReply: true, onScreen: null } } as never)
  await clock.advance(10)
  expect(await counts({ text: 'close', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'ask', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'as', requestId: 'row-t1' })).toBe(true)
})

test("a click that slid a cell on a card's title, a press that asks about the card, leaves a piece of it selected in the answer's row: the bar names neither c nor e; the card's body, a chart label and a word of the answer that the title holds too still count", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const text = 'Of the runs, [12 of 40](#) failed on the p95 check: it is in a sweep where 0 runs pass, so ask before you close it as done.'
  const id = 'c0123456789ae'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_8', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_8: { version: 1 } }, at: 1 }
  await resumed($, on, QUOTED, 's-tray-title', { text, kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  const counts = async (sel: Any) => {
    // a selection made anew: none in between, as the click that makes it takes the one before down
    selected = undefined
    await $.ui.render(above(40))
    selected = sel
    const band = textOf(await $.ui.render(above(40)))
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  // the card under the answer, on screen: its title is a press that asks about it
  const title = all(await $.ui.render(answer('row-t1', text))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('ask about') && textOf(n) === 'Runs by status')
  expect(title).toBeDefined()
  // a click on it that slid a cell: at its start, inside a word, over a space, a word the answer does not hold, and
  // the whole title
  for (const piece of ['Ru', 'ns', 'tu', 'y ', 'by', 'Runs by status']) expect(await counts({ text: piece, requestId: 'row-t1' })).toBe(false)
  // a word of the answer that the title holds too
  expect(await counts({ text: 'runs', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'Runs', requestId: 'row-t1' })).toBe(true)
  // the card's body, in the answer's row: a word of its table, a chart label
  expect(await counts({ text: 'passed', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'passed  ████████████ 28', requestId: 'row-t1' })).toBe(true)
  // the card out of view: words selected in the row count as its own again
  await $.ui.render({ ...(answer('row-t1', text) as Any), props: { text, isFirstOfReply: true, onScreen: null } } as never)
  expect(await counts({ text: 'by', requestId: 'row-t1' })).toBe(true)
})

test("c on words selected since the bar last drew reads a few states at most, however many answers: the selection's watch works out whether they wait as it sees them, and the key's own check reads the newest turns alone", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  let selections = 0
  on('ui.selection', () => { selections++; return { value: selected } })
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  // sixty answers after the one that holds the words
  const kept: Record<string, string> = {}
  for (let n = 2; n <= 61; n++) {
    kept[`answers/t${n}.json`] = JSON.stringify({ v: 1, turn: { turnId: `t${n}`, n, prompt: { text: `and run ${n}?`, by: 'composer', row: `row-q${n}` }, rows: [`row-t${n}`], answer: `row-t${n}`, reason: 'answer', startedAt: n, endedAt: n, labels: [], cards: [], seq: 0 }, msgs: [{ row: `row-t${n}`, turnId: `t${n}`, text: `Run ${n} passed every check.`, at: n }] })
  }
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-tick', { kept })
  // the answer and the bar draw, in the fullscreen layout, whose selection the watch reads; the bar names c cite
  await $.ui.render(answer('row-t1', TEXT))
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // other words selected, which the watch sees at its next read; the bar has not drawn since: c reads the selection
  // alone, within the hook's few milliseconds
  selected = { text: 'Run 7 passed every check', requestId: 'row-t7' }
  await clock.advance(400)
  gets = 0
  selections = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBe(0)
  expect(selections).toBe(1)
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  // words selected the moment before c, before the watch's next read: the key checks them itself, reading the
  // answer they lie in and the newest turns, not every one
  selected = { text: 'Run 9 passed every check', requestId: 'row-t9' }
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBeLessThan(8)
  await clock.advance(1000)
  expect(spawns.length).toBe(2)
})

test("the Claims pane's w close is a click alone: a w typed while the pane holds the keyboard reaches the prompt, where it closes the pane once its word window closed, and a question that starts with w is typed whole", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.selection', () => ({ value: undefined }))
  // the side pane as Claude Code keeps it: up from an open until a close
  let up = false
  const opens: Any[] = []
  const closes: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); up = true; return { value: { isPlaced: true } } as never })
  on('ui.close', (_$: unknown, e: Any) => { closes.push(e.id); up = false; return { value: undefined } as never })
  const { clock } = await resumed($, on, QUOTED, 's-tray-wclose', { panes: () => (up ? [{ id: 'thimble', title: 'Claims' }] : []) })
  expect(textOf(await $.ui.render(above()))).toContain('w claims')
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims'])
  // the pane's key row ends with w close, a click alone: no Button of the pane takes w, so Claude Code types a w typed
  // in the pane into the prompt
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'Claims', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  const buttons = all(pane).filter(n => n.type === 'Button')
  expect(buttons.filter(b => b.props.hotkey === 'w')).toEqual([])
  const close = buttons.find(b => String(b.key ?? b.props.key) === 'key-w')
  expect([close?.props.label, textOf(close)]).toEqual(['close', 'w: close'])
  // that w, alone: the pane closes once its word window closed
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(closes).toEqual(['thimble'])
  // open again: a question that starts with w, typed on, is a word, whole in the prompt, and the pane stays
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims', 'Claims'])
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  expect(await $.prompt.edit(key('h'))).toEqual({ text: 'wh', cursor: 2 })
  expect(await $.prompt.edit({ ...(key('y') as Any), text: 'wh', cursor: 2, start: 2, end: 2 } as never)).toEqual({ text: 'why', cursor: 3 })
  await clock.advance(1000)
  expect(closes).toEqual(['thimble'])
})

test('a sentence the check rewrote draws as rewritten, its citation corrected, though the analyst asked about other words of it: those step aside', CITES, async ($, on) => {
  const fixed = { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40', rewrite: 'Of the runs, [11 of 40] failed on the p99 check.' }
  const asked = { n: 2, row: 'row-t1', words: 'failed on the p95 check', start: 27, end: 50, sentence: 'Of the runs, [12 of 40] [failed on the p95 check].', status: 'deferred', shown: 'failed on the p95 check', asked: true }
  await resumed($, on, [fixed, asked], 's-tray-rewritten')
  const drawn = textOf(await $.ui.render(answer('row-t1', TEXT)))
  expect(drawn).toContain('Of the runs, 11 of 40 failed on the p99 check.')
  expect(drawn).not.toContain('×')
  expect(drawn).not.toContain('*')
})

test("with Citations manual, ] passes the citations Claude wrote (they draw as plain words); a click on their words still opens one", { options: { citations: 'manual' } }, async ($, on) => {
  // the answer's only citation is Claude's: nothing for ] to open, so ] is the prompt's and types
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await resumed($, on, QUOTED)
  expect((await $.prompt.edit(key(']')) as Any)?.text).toBe(']')
  expect(textOf(await $.ui.render(above()))).not.toContain('12 of 40')
  // the reply draws it as plain words, underlined under the pointer, and a press still opens it
  const cite = all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  const words = all(cite).find(n => n.type === 'Text' && textOf(n) === '12 of 40')
  expect(words.props?.underline).toBeUndefined()
  expect((cite.hover ?? cite.props.hover).underline).toBe(true)
  const reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
})

test('while the tray is open the bar names what ] goes to from the mark the tray shows, its name in that mark\'s look: a heads-up opened with h over its citation names the citation after it, as when ] reached it, and ] goes there', CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-steps', { parts: HEADS })
  // ] is on the bar, not in the header, while the tray is open
  const stepKey = async () => all(await $.ui.render(above(40))).find(n => n.type === 'Button' && String(n.props?.key ?? '').endsWith('tray-]'))
  const head = async () => textOf(await stepKey())
  // the look of the words that name the mark ] goes to, in the bar's ] key, beside `next`
  const named = async (what: string) => {
    const k = await stepKey()
    const props = (t: string) => { const n = all(k).find(x => x.type === 'Text' && textOf(x) === t); if (!n) return null; const { key: _k, children: _c, ...rest } = n.props; return rest }
    return { next: props(' next '), what: props(what) }
  }
  const fills = markColors(themeLast())
  // ] reaches the heads-up on the citation's words, then the citation, then the explainer
  await $.prompt.edit(key(']'))
  expect(await head()).toContain('] next citation')
  // a citation's name underlined, in the text's own color, as a citation's words in the reply
  expect(await named('citation')).toEqual({ next: { dimColor: true }, what: { underline: true } })
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(await head()).toContain('] next explainer')
  // an explainer's name on the explainers' teal
  expect(await named('explainer')).toEqual({ next: { dimColor: true }, what: { backgroundColor: fills.glossBg } })
  // h on the citation opens the heads-up over it: the same box, the same header
  await clock.advance(2000)
  await $.prompt.edit(key('h'))
  await clock.advance(2000)
  expect(textOf(await $.ui.render(above(40)))).toContain('Retried runs count twice')
  expect(await head()).toContain('] next citation')
  // ] goes to the citation, as the header says
  await $.prompt.edit(key(']'))
  await clock.advance(2000)
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('Retried runs count twice')
})

test("at rest the bar names ] and the mark it opens while the answer the keys act on shows marks, in either layout, a press that opens it as ] does: `show` the answer's first mark, `next` a later one, the mark's name in its own look; its verb is in thimble's color while one of the answer's marks is not opened, and dim as the bar's other keys' words once the person opened each", CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-rest', { parts: HEADS })
  const rest = async (isFullscreen = true) => all(await $.ui.render({ ...(above(40) as Any), viewport: { ...view, isFullscreen } } as never)).find(n => n.type === 'Button' && n.props?.key === 'bar-tray-next')
  const words = (b: Any) => all(b).find(n => n.type === 'Text' && textOf(n).startsWith(' '))
  const look = (b: Any, what: string) => all(b).find(n => n.type === 'Text' && textOf(n) === what)?.props
  const fills = markColors(themeLast())
  // the heads-up on the citation's words comes first; nothing of the answer was opened yet: lit, and `heads up` on the
  // heads-ups' orange, as its words in the reply
  for (const isFullscreen of [true, false]) {
    const b = await rest(isFullscreen)
    expect(textOf(b)).toBe('] show heads up')
    expect(all(b).find(n => n.type === 'Text' && textOf(n) === ']')?.props).toMatchObject({ color: accent(), bold: true })
    expect(words(b)?.props?.color).toBe(accent())
    expect(look(b, 'heads up')).toMatchObject({ backgroundColor: fills.headsBg })
    expect(look(b, 'heads up')?.color).toBeUndefined()
    expect(look(b, 'heads up')?.dimColor).toBeUndefined()
  }
  // a press on it opens the heads-up; the open tray names ] in its header alone
  const ui = await $.ui.mount(above(40))
  await ui.press({ key: 'bar-tray-next' })
  await ui.unmount()
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('Retried runs count twice')
  expect(band.match(/\] next/g)).toEqual(['] next'])
  // closed: the citation and the explainer are not opened yet, so the words stay lit, and name the citation, which ]
  // opens now: `citation` underlined, as a citation's words in the reply
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  expect(textOf(await rest())).toBe('] next citation')
  expect(words(await rest())?.props?.color).toBe(accent())
  expect(words(await rest())?.props?.dimColor).toBeUndefined()
  expect(look(await rest(), 'citation')).toMatchObject({ underline: true })
  expect(look(await rest(), 'citation')?.color).toBeUndefined()
  // ] from rest opens the citation, then on to the explainer: each mark opened, so dim, and ] names the first mark
  // again, which keeps its look
  for (const k of [']', ']', '0']) {
    await clock.advance(2000)
    await $.prompt.edit(key(k))
  }
  expect(textOf(await rest())).toBe('] show heads up')
  expect(words(await rest())?.props).toMatchObject({ dimColor: true })
  expect(words(await rest())?.props?.color).toBeUndefined()
  expect(look(await rest(), 'heads up')).toMatchObject({ backgroundColor: fills.headsBg })
})

test("while the bar's ] is lit, ] from rest opens the first of the answer's marks the person has not opened, which the bar names; from there ] and [ step in reading order; once each was opened, ] from rest opens the first mark again", CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-unopened', { parts: HEADS })
  const rest = async () => textOf(all(await $.ui.render(above(40))).find(n => n.type === 'Button' && n.props?.key === 'bar-tray-next'))
  const press = async (k: string) => {
    await clock.advance(2000)
    await $.prompt.edit(key(k))
  }
  const shows = async () => textOf(await $.ui.render(above(40)))
  // in reading order: the heads-up on the citation's words, the citation, the explainer. ] opens the heads-up first
  expect(await rest()).toBe('] show heads up')
  await press(']')
  expect(await shows()).toContain('Retried runs count twice')
  await press('0')
  // the citation is the first not opened: the bar names it, and ] opens it
  expect(await rest()).toBe('] next citation')
  await press(']')
  let band = await shows()
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('Retried runs count twice')
  // from there ] and [ step in reading order: on to the explainer, back to the citation, back to the heads-up
  await press(']')
  band = await shows()
  expect(band).toContain('The time that 95 of 100 checks stay under.')
  await press('[')
  band = await shows()
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('The time that 95 of 100 checks stay under.')
  await press('[')
  expect(await shows()).toContain('Retried runs count twice')
  await press('0')
  // each mark opened: ] is no longer lit, and from rest it opens the first mark again
  expect(await rest()).toBe('] show heads up')
  await press(']')
  expect(await shows()).toContain('Retried runs count twice')
})

test('each key shows once, where it acts: a card on screen names a in its header only while a reaches it; the open tray names a in its header, and on a card ] reached the bar names it', CITES, async ($, on) => {
  const id = 'c0123456789af'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_7', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_7: { version: 1 } }, at: 1 }
  const { clock } = await resumed($, on, QUOTED, 's-tray-head-a', { kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  // the card's Client says it is on screen, as it does once drawn
  const shown = await $.ui.mount(answer('row-t1', TEXT))
  await shown.unmount()
  const head = async () => textOf(all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.props?.key === 'head-keys'))
  const band = async () => textOf(await $.ui.render(above(40)))
  expect(await head()).toBe('a ask · p artifact')
  // ]: the tray on the citation names a in its header, and a goes there, so the card's header names ask without it;
  // the bar names ] and the card it goes to
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  const open = await band()
  expect(open).toContain('a ask · 0 close')
  expect(open.match(/a ask/g)).toEqual(['a ask'])
  expect(open).toContain('] next card')
  expect(await head()).toBe('ask · p artifact')
  // ] again reaches the card: the bar names a, which asks about it, and the card's header still names ask without it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  const stand = await band()
  expect(stand).toContain('a ask · [ previous citation · 0 back')
  expect(stand.match(/a ask/g)).toEqual(['a ask'])
  expect(await head()).toBe('ask · p artifact')
  // 0 gives the keys back: a reaches the card again, and its header names it
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).not.toContain('a ask')
  expect(await head()).toBe('a ask · p artifact')
})

test('each key shows once, where it acts: with Heads-ups on demand, the tray on a citation with a heads-up on its words names h in its header, and the bar leaves its h heads-ups out until the tray closes', { options: { citations: 'auto cite + verify', details: 'on demand' } }, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-h-once', { parts: HEADS })
  const band = async () => textOf(await $.ui.render(above(40)))
  expect(await band()).toContain('h heads-ups')
  // ] reaches the heads-up on the citation's words, and ] again the citation: h opens that heads-up over it, which the
  // tray's header names alone
  for (const k of [']', ']']) {
    expect(await $.prompt.edit(key(k))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  const open = await band()
  expect(open).toContain('failed: 12')
  expect(open.match(/h heads-ups?/g)).toEqual(['h heads-up'])
  // closed: h asks for heads-ups on the answer again, and the bar names it
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).toContain('h heads-ups')
})

test("each key shows once, where it acts: while a fix's line names y, d and n, which go to it, the bar names a card's own keys less those", CITES, async ($, on) => {
  const id = 'c0123456789af'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_7', agentId: 'a-made-up', anchorRow: 'row-t1', keys: ['n', 'd', 'o'], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_7: { version: 1 } }, at: 1 }
  // the fixes as the kernel keeps them, and a fix's line once one is ready
  const fix = { id: 1, title: 'Bar says read', words: ['make the bar say read'], rounds: 1, made_in: 's-tray-fix-keys', created: 0, state: 'ready', work: null, commit: null, files: [], tests: 'passed', summary: '', error: null }
  const fixes = { fixes: [fix], on: false, live: '/made-up/live', version: '0.10.7', count_on: 0, pointed: false, gen: 1 }
  let ready = false
  on('state.get', async (_$: unknown, e: Any, next: Any) => (ready && e?.key === 'fixLine' ? { value: { value: { id: 1, kind: 'ready' }, version: 1 } } : ready && e?.key === 'fixes' ? { value: { value: fixes, version: 1 } } : next(e)))
  await resumed($, on, QUOTED, 's-tray-fix-keys', { kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  // the card's Client says it is on screen, as it does once drawn
  const shown = await $.ui.mount(answer('row-t1', TEXT))
  await shown.unmount()
  const band = async () => textOf(await $.ui.render(above(20)))
  expect(await band()).toContain('n d o card keys')
  // a fix ready, its line above the bar
  ready = true
  const now = await band()
  expect(now).toContain('y use it now · d what changed · n later')
  expect(now).toContain('o card keys')
  expect(now).not.toContain('n d o card keys')
  expect(now.match(/\bd what changed|\bd o\b|\bn d\b/g)).toEqual(['d what changed'])
})

test("a repair that did not start: its line says what failed and why; while the tray shows x repair on that citation, the line leaves out the sentence that says to press x, and says it again once the tray closes", CITES, async ($, on) => {
  const failed = { ...QUOTED, status: 'failed', shown: '12 of 40', reason: 'Line 4 says 11 failed.' }
  const { clock } = await resumed($, on, failed, 's-tray-repair-line', { deny: 'a made-up refusal' })
  const band = async () => textOf(await $.ui.render(above(20)))
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).toContain('x repair')
  expect(await $.prompt.edit(key('x'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  // the tray shows x repair on the citation: the line says what failed, and x once, in the tray
  const open = await band()
  expect(open).toContain('The repair did not start (a made-up refusal).')
  expect(open).not.toContain('Press x')
  expect(open.match(/x repair/g)).toEqual(['x repair'])
  // closed: x repair shows nowhere, so the line says how to try again
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  const closed = await band()
  expect(closed).not.toContain('x repair')
  expect(closed).toContain('The repair did not start (a made-up refusal). Press x on the citation to try again.')
})

test('each key shows once, where it acts: while the Claims pane shows, its key row names w close, and the bar names the claims without w; w still closes it, and closed, the bar names w again', CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.selection', () => ({ value: undefined }))
  let up = false
  const closes: Any[] = []
  on('ui.open', () => { up = true; return { value: { isPlaced: true } } as never })
  on('ui.close', (_$: unknown, e: Any) => { closes.push(e.id); up = false; return { value: undefined } as never })
  const { clock } = await resumed($, on, QUOTED, 's-tray-w-once', { panes: () => (up ? [{ id: 'thimble', title: 'Claims' }] : []) })
  const band = async () => textOf(await $.ui.render(above()))
  expect(await band()).toContain('w claims')
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(up).toBe(true)
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'Claims', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  expect(textOf(pane)).toContain('w: close')
  const beside = await band()
  expect(beside).toContain('claims')
  expect(beside).not.toContain('w claims')
  // w, typed in the pane, reaches the prompt and closes it
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(closes).toEqual(['thimble'])
  expect(await band()).toContain('w claims')
})

test("each key shows once, where it acts: while a click gave the squeeze chips the keyboard, every key goes to them, so the bar's right names its items without their letters, each still a click", CITES, async ($, on) => {
  await resumed($, on, QUOTED, 's-tray-chips-held')
  const band = async () => textOf(await $.ui.render(above()))
  expect(await band()).toContain('w claims')
  expect(await $.prompt.edit(key('s'))).toEqual({ text: '', cursor: 0 })
  const ui = await $.ui.mount(answer('row-t1', TEXT))
  await ui.press({ key: 'lvl-length-1' })
  await ui.key({ key: 'return' })
  await ui.unmount()
  const held = await band()
  expect(held).toContain('claims')
  expect(held).not.toContain('w claims')
  const press = all(await $.ui.render(above())).find(n => n.type === 'Button' && n.props?.key === 'bar-claims')
  expect(press?.props?.label).toBe('claims')
})

test('an answer that shows no marks: the bar names no ]', CITES, async ($, on) => {
  await resumed($, on, [], 's-tray-rest-none', { text: 'Of the runs, 12 of 40 failed on the p95 check.' })
  const band = await $.ui.render(above(40))
  expect(all(band).some(n => n.props?.key === 'bar-tray-next')).toBe(false)
  expect(textOf(band)).not.toContain('] next')
  expect(textOf(band)).not.toContain('] show')
})

test("the pointer over a heads-up's or an explainer's words underlines them, over their stronger fill, as thimble's other presses are underlined under it", CITES, async ($, on) => {
  await resumed($, on, QUOTED, 's-tray-hover', { parts: HEADS })
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  for (const label of ['heads up 12 of 40', 'explain p95']) {
    const press = drawn.find(n => n.type === 'Button' && String(n.props?.label).startsWith(label))
    expect(press?.hover ?? press?.props?.hover).toMatchObject({ inverse: false, underline: true })
    expect((press?.hover ?? press?.props?.hover)?.backgroundColor).toBeTruthy()
  }
})
