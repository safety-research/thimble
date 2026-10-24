// The settings pane: /thimble-settings opens it with the keys, it shows the bar as the switches leave it, and a press on
// a switch turns it off through Claude Code ($.config.set). All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'thimble settings', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never

test('/thimble-settings opens the switches; a press turns one off through Claude Code, and its items leave the preview', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean> = { marks: true, cards: true, counts: true }
  const set: Any[] = []
  const opened: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)

  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  expect(opened[0]).toMatchObject({ id: 'thimble', focus: true, closeOnEscape: true })
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'switch-counts' }))?.text).toContain('on')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeDefined()

  await pane.press({ key: 'switch-counts' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.counts', value: false })])
  expect((await pane.find({ key: 'switch-counts' }))?.text).toContain('off')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeUndefined()
  await pane.unmount()
})

test('Citation checks has three modes: on demand by default, a press on auto sets it, and ↵ on the row goes to the next', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { marks: true, citationChecks: 'on demand' }
  const set: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)

  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'switch-citationChecks' }))?.text).toContain('Citation checks')
  expect(await pane.find({ key: 'mode-citationChecks-auto' })).toBeDefined()
  expect(await pane.find({ key: 'mode-citationChecks-off' })).toBeDefined()
  await pane.press({ key: 'mode-citationChecks-auto' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.citationChecks', value: 'auto' })])
  await pane.press({ key: 'switch-citationChecks' })
  expect(set[1]).toMatchObject({ key: 'thimble@inline.citationChecks', value: 'on demand' })
  await pane.press({ key: 'switch-citationChecks' })
  expect(set[2]).toMatchObject({ value: 'off' })
  expect(rows.citationChecks).toBe('off')
  await pane.unmount()
})
