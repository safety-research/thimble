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

test("the settings' Color row: six samples, ▸ on purple; a press on teal keeps it through Claude Code and draws thimble's name and keys in teal at once", async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { marks: true, cards: true, counts: true, color: 'purple' }
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
  const names = ['purple', 'blue', 'teal', 'green', 'orange', 'yellow']
  for (const n of names) expect((await pane.find({ key: `color-${n}` }))?.text).toContain(n)
  expect((await pane.find({ key: 'color-purple' }))?.text).toContain('▸')
  expect((await pane.find({ key: 'color-teal' }))?.text).not.toContain('▸')
  expect((await pane.find({ type: 'Text', text: 'thimble' }))?.props?.color).toBe('merged')

  await pane.press({ key: 'color-teal' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.color', value: 'teal' })])
  expect((await pane.find({ key: 'color-teal' }))?.text).toContain('▸')
  expect((await pane.find({ key: 'color-purple' }))?.text).not.toContain('▸')
  // the preview's name and its keys (v card) in the new color
  expect((await pane.find({ type: 'Text', text: 'thimble' }))?.props?.color).toBe('planMode')
  expect((await pane.find({ type: 'Text', text: 'v card' }))?.children?.[0]?.props?.color).toBe('planMode')
  await pane.unmount()
  // purple again, for the other tests
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const again = await $.ui.mount(PANE)
  await again.press({ key: 'color-purple' })
  expect((await again.find({ type: 'Text', text: 'thimble' }))?.props?.color).toBe('merged')
  await again.unmount()
})
