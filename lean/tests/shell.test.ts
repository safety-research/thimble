// The shell's hooks (shell/shell.tsx): an object Claude saves is placed under the turn's next words, a prompt asked
// while the detail view is open carries the object and its selected part, and /verb lists the verbs for an object.
// `claude plugin test lean`. The Node children (the drawing, `lean resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/data'
const FILE = `${ROOT}/thimble/objects/01-saves.json`
const OBJECT = {
  id: '01-saves', version: 1, title: 'Saves per day', question: 'When did the agents edit the wiki most?',
  program: 'return k.bars(...)', data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] },
  lineage: { cites: [] },
}
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' }, kid: { t: 'beside', kids: [{ t: 'text', runs: [{ s: 'Jun 18', tone: 'ink' }], wrap: false, w: 6 }, { t: 'bar', tone: 'accent', value: 6543, max: 6543 }, { t: 'text', runs: [{ s: '6,543', tone: 'ink' }], align: 'right', w: 5 }], gap: 1 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const VERBS = [{ key: 'e', name: 'echo', line: 'say back what it holds', phrase: 'say back its 1 part', picked: true }]
const RESOLVED = { ref: 'q1#day=2026-06-18@n', chain: [{ step: 'query', id: 'q1', about: 'saves per day' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'x' }], notes: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any) {
  mock.env(on, {})
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path === FILE || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${ROOT}/thimble/objects` ? [{ name: '01-saves.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path === FILE ? JSON.stringify(OBJECT) : '' }))
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    const out = e.argv.some(a => a.endsWith('prep.mjs')) ? { drawing: DRAWING, verbs: VERBS, problems: [] } : e.argv.includes('resolve') ? RESOLVED : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

// every string a drawn tree holds, in order
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = ($: any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

test('an object Claude saves is drawn under the next words of the turn, with its verbs', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n  /days ← q1 (exact)\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: "lean save saves <<'JSON'\n{}\nJSON" } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  const first = textOf(await reply($))
  expect(first).toContain('the reply')
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('the reply')
  expect(drawn).toContain('Jun 18')
  expect(drawn).toContain('6,543')
  expect(drawn).toContain('e echo')
  expect(drawn).toContain('? all')
})

test('a reply after no save draws as Claude Code draws it', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  expect(textOf(await reply($))).toBe('the reply')
})

test('while the detail view is open, a prompt carries the object and its selected part', async ($, on) => {
  const runs = world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: false, isPlaced: true, plugin: 'thimble-lean' }] }))
  let carried: readonly string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    carried = e.context ?? []
    return { text: e.text }
  })
  await $.command.run({ command: 'obj', args: 'saves day-2026-06-18' } as never)
  // the region's rows were resolved for the view, as the person's, not as what Claude read
  const resolve = runs.find(a => a.includes('resolve'))
  expect(resolve).toBeDefined()
  expect(resolve!.includes('q1#day=2026-06-18@n')).toBe(true)
  await $.prompt.submit({ text: 'why is this day so high?' })
  expect(carried.length).toBe(1)
  expect(carried[0]).toContain('01-saves@1')
  expect(carried[0]).toContain('day-2026-06-18')
  expect(carried[0]).toContain('q1#day=2026-06-18@n')
})

test('/verb ? lists every verb for the object, the picked ones marked', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  const r = await $.command.run({ command: 'verb', args: '?' } as never)
  expect(String(r.text)).toContain('● e  echo')
  expect(String(r.text)).toContain('say back its 1 part')
})
