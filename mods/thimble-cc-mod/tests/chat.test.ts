// thimble-cc-mod's tests: `claude plugin test mods/thimble-cc-mod`. The hooks the tests register sit beneath the plugin
// and stand for the engine: a filesystem in memory, process.run as the resolver and the card scripts, the prompt,
// subagents and panes. Drawings are mounted on the terminal and the desktop (both have Client) and on vscode (static).
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { paraLayout, richMarkdown } from '../hooks/cite'
import { cardLayout } from '../hooks/draw'
import type { CardData } from '../hooks/draw'
import { citations, embeddedCards, fromMod, parseReply, scriptResult, shownMatches, tableCells, takeawayAfter, threadBody, unframed, validateCard, valueIn } from '../hooks/lib'

const CWD = '/corpus/wiki'
const BAR: CardData = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
  params: [{ name: 'by', value: 'wiki', default: 'wiki', choices: ['wiki', 'label'] }],
}
const REPLY = [
  '[[card:abc123]]',
  '',
  'dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.',
  '',
  'probier has [[1014|card:abc123#revisions/probier]], see [[pages.jsonl#L3]].',
].join('\n')

type World = {
  files: Map<string, string>
  writes: { path: string; text: string }[]
  runs: { argv: readonly string[]; env?: Record<string, string> }[]
  filled: string[]
  submitted: string[]
  spawned: { prompt: string; subagentType?: string }[]
  sent: string[]
  appended: string[]
  opened: string[]
}

/** What the resolver says of a ref: the bar card's values as its file holds them, one line of pages.jsonl, nothing else. */
function resolveOne(ref: string, display: string | null, card: CardData = BAR) {
  const values: Record<string, string> = { 'card:abc123#revisions/all': '14416' }
  for (const r of (card.rows ?? []) as { label: string; value: number }[]) values[`card:abc123#revisions/${r.label}`] = String(r.value)
  if (ref.startsWith('card:abc123#') && !(ref in values)) return { ref, kind: 'card', card: 'abc123', status: 'missing', why: `card abc123 has no value ${ref.split('#')[1]}`, window: [] }
  if (ref in values) {
    const v = values[ref]!
    const ok = display === null || display === v
    return { ref, kind: 'value', card: 'abc123', column: 'revisions', row: ref.split('/').at(-1), value: v, status: ok ? 'ok' : 'differs', why: ok ? `the card shows ${v}` : `the card shows ${v}, not ${display}`, window: [] }
  }
  if (ref === 'card:abc123') return { ref, kind: 'card', card: 'abc123', status: 'ok', why: 'the card exists', window: [] }
  if (ref === 'pages.jsonl#L3') return { ref, kind: 'lines', file: 'pages.jsonl', start: 3, end: 3, status: 'ok', why: 'resolves', window: [{ n: 3, text: '{"name": "Main"}', hit: true }] }
  return { ref, kind: 'file', status: 'missing', why: `no file ${ref}`, window: [] }
}

function world(on: On, extra: Record<string, string> = {}): World {
  const w: World = { files: new Map(Object.entries({ [`${CWD}/.thimble-cc-mod/cards/abc123.json`]: JSON.stringify(BAR), ...extra })), writes: [], runs: [], filled: [], submitted: [], spawned: [], sent: [], appended: [], opened: [] }
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\nguidance {{helper}}' }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: w.files.get(e.path)!.length, mtimeMs: w.writes.length + 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', ($, e) => {
    const names = [...w.files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }))
    return { value: names }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, env: e.init?.env })
    if (String(e.argv[1]).endsWith('/helper/resolve.py')) {
      const req = JSON.parse(e.init?.stdin ?? '{}') as { items: { id: string; ref: string; display: string | null }[] }
      const card = JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/cards/abc123.json`) ?? 'null') as CardData | null
      const out = req.items.map(it => ({ ...resolveOne(it.ref, it.display, card ?? BAR), id: it.id }))
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // a card's script, run again with a param: it writes the card with the new rows
    const params = JSON.parse(e.init?.env?.THIMBLE_CC_MOD_PARAMS ?? '{}') as Record<string, string>
    const rows = params.by === 'label' ? [{ label: 'AgentRelent', value: 317, group: '' }] : BAR.rows
    w.files.set(`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify({ ...BAR, rows, params: [{ ...BAR.params![0]!, value: params.by ?? 'wiki' }] }))
    w.writes.push({ path: 'card', text: '' })
    return { value: { exitCode: 0, stdout: 'thimble-cc-mod card abc123', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('agent.spawn', ($, e) => {
    // the kit hands the Agent tool's spelling (subagent_type), and strips the id a hook answers: only core starts one
    w.spawned.push({ prompt: e.prompt, subagentType: e.subagentType ?? (e as { subagent_type?: string }).subagent_type })
    return { model: 'm', agentId: `agent-${w.spawned.length}` }
  })
  on('session.send', ($, e) => {
    w.sent.push(e.text)
    return { isDelivered: true }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

type M = Mounted<'terminal'>

const MESSAGE = (text: string) => ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as const

// ------------------------------------------------------------------------------------------------ pure helpers

test('citations and the reply blocks: a card embed, rich paragraphs, code left alone', () => {
  const cs = citations(REPLY + '\n`[[card:zzz]]`')
  expect(cs.map(c => c.ref)).toEqual(['card:abc123', 'card:abc123#revisions/dse', 'card:abc123#revisions/all', 'card:abc123#revisions/probier', 'pages.jsonl#L3'])
  const blocks = parseReply(REPLY)
  expect(blocks.map(b => b.type)).toEqual(['card', 'rich', 'rich'])
  expect(embeddedCards(REPLY)).toEqual(['abc123'])
  expect(takeawayAfter(REPLY, 'abc123')).toBe('dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.')
})

test('validateCard holds each kind to its spec', () => {
  expect(validateCard(BAR, 'abc123')).toBe(null)
  expect(validateCard({ ...BAR, kind: 'pie' })).toContain('kind must be one of')
  expect(validateCard({ ...BAR, rows: [{ label: 'x', value: 'many' }] })).toContain('bar row 1')
  expect(validateCard({ ...BAR, id: 'other' }, 'abc123')).toContain('not abc123')
  expect(validateCard({ id: 'l', kind: 'line', question: 'q', series: [{ name: 's', points: [['2026-01-01', 3], ['2026-01-02', null]] }] })).toContain('point 2')
  expect(validateCard({ id: 't', kind: 'table', question: 'q', columns: ['a', 'b'], rows: [['x']] })).toContain('2 plain values')
  expect(validateCard({ id: 'e', kind: 'example', question: 'q', examples: [{ ref: 'pages.jsonl', quote: 'x' }] })).toContain('file#L12')
  expect(validateCard({ ...BAR, params: [{ name: 'by', value: 'user', choices: ['wiki'] }] })).toContain('param')
})

test('numbers: rounding of shown decimals, whole tokens only; a script prints RESULT', () => {
  expect(valueIn('3,908', 'pages = 3908')).toBe(true)
  expect(valueIn('91%', 'rate = 91.2%')).toBe(true)
  expect(valueIn('6,500', 'peak = 6543')).toBe(false)
  expect(shownMatches('2.5', '2.45')).toBe(true)
  expect(scriptResult('total 3\nRESULT: 317\n')).toBe('317')
  expect(threadBody('Text.\nFOR MAIN: 3908 pages.')).toBe('Text.')
})

test('layouts: a bar row is hit by its line, a chip by its cells', () => {
  const lay = cardLayout(BAR, 60, -1)
  expect(lay.items[1]!.cite).toBe('[[1013|card:abc123#revisions/probier]]')
  expect(lay.hit(10, 1)).toBe(1)
  const para = paraLayout(parseReply(REPLY)[1] as never, [{ label: '13403', state: 'link', mark: '', spin: false, tip: '' }, { label: '14416', state: 'link', mark: '', spin: false, tip: '' }], 80, -1)
  expect(para.spans.length).toBe(2)
  expect(para.spans[0]!.x0).toBe('dse has '.length)
})

test('a table whose cells hold citations is a rich block, drawn as a Markdown table with a link per citation', () => {
  expect(tableCells('| AgentRelent | [[314|call:a#L1]] of [[317|call:a#L1]] | `a|b` |')).toEqual(['AgentRelent', '[[314|call:a#L1]] of [[317|call:a#L1]]', '`a|b`'])
  const text = ['Intro.', '', '| Name | Revisions |', '|---|--:|', '| A | [[314|call:a#L1]] |', '| B | none |', '', '| x | y |', '|---|---|', '| 1 | 2 |'].join('\n')
  const blocks = parseReply(text)
  expect(blocks.map(b => b.type)).toEqual(['md', 'rich', 'md'])
  const table = blocks[1] as Extract<(typeof blocks)[number], { type: 'rich' }>
  expect(table.table?.rows.length).toBe(3)
  expect(table.table?.align).toEqual(['left', 'right'])
  expect(table.runs.filter(r => r.cite).length).toBe(1)
  const md = richMarkdown(table, (c, n) => `[${c.display}](#c${n})`)
  // header, rule (its alignment kept), two rows; a citation a link, the cell without one as written
  expect(md).toBe(['| Name | Revisions |', '| --- | --: |', '| A | [314](#c0) |', '| B | none |'].join('\n'))
  // a paragraph keeps its code, bold and italic; a heading its level; a quote its marker; a pipe in a cell is escaped
  const para = parseReply('A **big** *gap* in `x` at [[5|a.md#L1]] and [[6|a.md#L2]].')[0] as typeof table
  expect(richMarkdown(para, (c, n) => `[${c.display}](#c${n})`)).toBe('A **big** *gap* in `x` at [5](#c0) and [6](#c1).')
  const head = parseReply('## Size: [[5|a.md#L1]]')[0] as typeof table
  expect(richMarkdown(head, c => `[${c.display}](#)`)).toBe('## Size: [5](#)')
  const quote = parseReply('> said [[5|a.md#L1]]')[0] as typeof table
  expect(richMarkdown(quote, c => `[${c.display}](#)`)).toBe('> said [5](#)')
  const piped = parseReply(['| a | b |', '|---|---|', '| x \\| y | [[5|a.md#L1]] |'].join('\n'))[0] as typeof table
  expect(richMarkdown(piped, c => `[${c.display}](#)`).split('\n')[2]).toBe('| x \\| y | [5](#) |')
})

test('the mod knows its own prompts under the engine framing', () => {
  const framed = 'The thimble-cc-mod plugin sent a message:\nthimble-cc-mod found problems in your last reply\n- x\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.'
  expect(fromMod(framed)).toBe(true)
  expect(unframed(framed)).toBe('thimble-cc-mod found problems in your last reply\n- x')
  expect(fromMod('Which wikis have the most revisions?')).toBe(false)
})

// ------------------------------------------------------------------------------------------------ the reply

test('a reply draws its card and its paragraphs with citations as Clients; elsewhere the paragraphs are Markdown with a link per citation', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MESSAGE(REPLY), surface } as never)
    expect(await ui.find({ type: 'Client', key: 'card-1-abc123' })).toBeDefined()
    const para = (await ui.find({ key: 'para-2' })) as { type: string; props: { module: string; props: { raws: string[]; chips: { label: string }[] } } }
    expect(para.type).toBe('Client')
    expect(para.props.module).toMatch(/para\.tsx$/)
    expect(para.props.props.raws.length).toBe(2)
    expect(para.props.props.chips.map(c => c.label)).toEqual(['13403', '14416'])
    await ui.unmount()
  }
  const flat = await $.ui.mount({ ...MESSAGE(REPLY), surface: 'vscode' } as never)
  expect(await flat.find({ type: 'Text', text: /Which wikis have the most revisions\?/ })).toBeDefined()
  expect(await flat.find({ type: 'Client' })).toBeUndefined()
  const md = (await flat.find({ type: 'Markdown', text: /^dse has \[13403\]/ })) as { props: { text: string; pressableLinks?: string[] } } | undefined
  expect(md?.props.text).toMatch(/^dse has \[13403\]\(file:\/\/\/corpus\/wiki\/\.thimble-cc-mod\/cards\/abc123\.json\) of \[14416\]\(file:[^)]+\) revisions\.$/)
  expect(md?.props.pressableLinks).toBeUndefined()
  await flat.unmount()
})

test('a card that does not validate is drawn as an error', async ($, on) => {
  world(on, { [`${CWD}/.thimble-cc-mod/cards/bad111.json`]: JSON.stringify({ id: 'bad111', kind: 'bar', question: 'q', rows: [] }) })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...MESSAGE('[[card:bad111]]\n\nsee [[card:bad111]]'), surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /Card 1 cannot be drawn: a bar card needs rows/ })).toBeDefined()
  await ui.unmount()
})

test('a param picked on the card runs its script again for that card, and the card redraws', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  // the reply's citations are checked at its end
  await $.turn.start({ text: 'which wiki?', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
  const ui = (await $.ui.mount({ ...MESSAGE(REPLY), surface: 'terminal' } as never)) as unknown as M
  await ui.post({ type: 'param', card: 'abc123', name: 'by', value: 'label' }, { in: 'card-1-abc123' })
  const run = w.runs.find(r => r.argv[1] === '.thimble-cc-mod/scripts/by.py')
  expect(run?.env).toEqual({ THIMBLE_CC_MOD_PARAMS: '{"by":"label"}', THIMBLE_CC_MOD_ONLY: '0:abc123', THIMBLE_CC_MOD_ROOT: CWD })
  expect(await ui.find({ type: 'Text', text: /AgentRelent/, in: 'card-1-abc123' })).toBeDefined()
  await ui.unmount()
  // the reply's citations were written for "by = wiki": they stay links, and their tip says so, with no card id
  let again = (await $.ui.mount({ ...MESSAGE(REPLY), surface: 'terminal' } as never)) as unknown as M
  const para = JSON.stringify(await again.find({ key: 'para-2' }))
  expect(para).toContain('"label":"13403","state":"link"')
  expect(para).toContain('written for by = wiki; the card now shows by = label')
  expect(para).not.toMatch(/abc123 has no value/)
  // back at their choice, they are checked again as before
  await again.post({ type: 'param', card: 'abc123', name: 'by', value: 'wiki' }, { in: 'card-1-abc123' })
  await again.unmount()
  again = (await $.ui.mount({ ...MESSAGE(REPLY), surface: 'terminal' } as never)) as unknown as M
  const back = JSON.stringify(await again.find({ key: 'para-2' }))
  expect(back).toContain('"label":"13403","state":"link"')
  expect(back).not.toContain('written for')
  await again.unmount()
  // the script pane shows what the script printed, not the card helper's lines for main
  const card = (await $.ui.mount({ ...MESSAGE(REPLY), surface: 'terminal' } as never)) as unknown as M
  const target = { kind: 'card', ref: 'card:abc123', cardId: 'abc123', text: BAR.question, script: BAR.source!.script }
  await card.post({ type: 'gesture', origin: 'o9', gestures: [{ seq: 1, gesture: 'menu', target, ev: { button: 'right', shift: false, ctrl: false, alt: false, type: 'press' } }] } as never, { in: 'card-1-abc123' })
  await card.unmount()
  const menu = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 40, rows: 10 }, props: { bodyColumns: 34, bodyRows: 8 } } as never)) as unknown as M
  await menu.press({ key: 'menu-script' })
  await menu.unmount()
  // the card view replaces the menu in the one panel
  const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /output of the last run \(exit 0\): nothing printed/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /thimble-cc-mod card abc123/ })).toBeUndefined()
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ turns

test('a Bash output is saved and main is told how to cite its lines', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: 'a\nb' }] }, text: 'a\nb' }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ran = await $.tool.call({ tool: 'Bash', command: 'wc -l pages.jsonl' } as never)
  const context = ((ran as { context?: readonly string[] }).context ?? []).join('\n')
  expect(context).toMatch(/this output is call:\w+\. To cite a line of it, write \[\[<value>\|call:\w+#L<n>\]\]/)
  expect(w.writes.some(x => x.path.includes('/.thimble-cc-mod/calls/'))).toBe(true)
})

// ------------------------------------------------------------------------------------------------ side threads

test('a press on a card\'s title asks a forked subagent about it, out of main\'s chat, and its pane takes the question', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount({ ...MESSAGE(REPLY), surface: 'terminal' } as never)) as unknown as M
  // a press on the card's title, a Button
  await ui.press({ key: 'card-title:abc123', in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble'])
  await ui.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface, viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
    expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
    expect(await pane.find({ key: 'ask' })).toBeDefined()
    expect(await pane.find({ key: 'main' })).toBeUndefined() // nothing is offered to main's prompt
    await pane.unmount()
  }
  const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  await pane.input({ key: 'ask', text: 'Why is dse so large?' })
  expect(w.spawned[0]?.subagentType).toBe('fork')
  expect(w.spawned[0]?.prompt).toContain('Why is dse so large?')
  expect(w.spawned[0]?.prompt).toContain('Which wikis have the most revisions?')
  expect(w.spawned[0]?.prompt).not.toContain('FOR MAIN')
  // a thread about a card may change it: edit and rerun its script, the question kept so the card is replaced in place
  expect(w.spawned[0]?.prompt).toContain('edit the script that made it and run it again')
  expect(w.spawned[0]?.prompt).toContain("keeping the card's question exactly as it is")
  expect(w.spawned[0]?.prompt).toContain('.thimble-cc-mod/cards/abc123.json')
  // a view that changes the values the reply cites is a new card, never this one changed
  expect(w.spawned[0]?.prompt).toContain('make a new card with its own question')
  // the kit starts no subagent, so the mod falls back to a general-purpose one given the guidance, then reports it
  expect(w.spawned[1]?.subagentType).toBe('general-purpose')
  expect(w.spawned[1]?.prompt).toContain('# thimble-cc-mod')
  expect(await pane.find({ type: 'Text', text: /could not start a subagent/ })).toBeDefined()
  expect(w.submitted.length).toBe(0) // nothing of the thread reached main's chat
  expect(w.filled.length).toBe(0)
  await pane.unmount()
})

test('a side thread about a citation asks for no change to a card', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-ask', args: 'why is dse so large?' } as never)
  const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  if (!w.spawned.length) await pane.input({ key: 'ask', text: 'why is dse so large?' })
  await pane.unmount()
  expect(w.spawned[0]?.prompt).toContain('why is dse so large?')
  expect(w.spawned[0]?.prompt).not.toContain('edit the script that made it')
  expect(w.spawned[0]?.prompt).not.toContain('FOR MAIN')
})

test('/exit and the end of the session stop the mod\'s subagents that still run, and no other', async ($, on) => {
  world(on)
  const stopped: string[] = []
  const agents = [
    { id: 'agent-1', description: 'verification · checking 3908', type: 'fork', status: 'running', spawnedBy: 'thimble-cc-mod' },
    { id: 'agent-2', description: 'side thread · why', type: 'fork', status: 'completed', spawnedBy: 'thimble-cc-mod' },
    { id: 'agent-3', description: 'Explore the wiki', type: 'Explore', status: 'running' },
  ]
  on('agent.list', () => ({ value: agents }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskStop') stopped.push(String((e as { task_id?: unknown }).task_id))
    return { result: { message: 'stopped', task_id: 'agent-1', task_type: 'local_agent' }, text: 'stopped' } as never
  })
  on('command.run', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'exit', args: '' } as never)
  expect(stopped).toEqual(['agent-1'])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(stopped).toEqual(['agent-1', 'agent-1'])
})
