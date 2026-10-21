// A fix's rounds in the terminal (shell/fix.ts refreshFixes): each `thimble fix use` of the same fix loads the plugins
// again and says the fix once, and a new title from a later round reaches the toast and the bar's line. All data is
// made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { fixLineNow, refreshFixes } from '../shell/fix'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const HOME = '/made-up/home/.thimble'
const FIX = `${HOME}/fixes/round-two/fix.json`

function engine(files: Map<string, string>, toasts: string[], commands: string[]): Any {
  const state = new Map<string, unknown>()
  return {
    env: { get: async (name: string) => (name === 'THIMBLE_HOME' ? HOME : undefined) },
    plugin: { root: '/made-up/plugins/thimble/plugin', name: 'thimble' },
    process: { run: async () => ({ exitCode: 0, stdout: 'round-two\nactive\n', stderr: '' }) },
    fs: { read: async (p: string) => { if (!files.has(p)) throw new Error(`no ${p}`); return files.get(p) } },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v) },
    },
    ui: { toast: (t: string) => { toasts.push(t) } },
    command: { run: async (c: Any) => { commands.push(c.command) } },
    clock: { after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
  }
}

test('a second round of the same fix loads the plugins again, and its new title reaches the toast and the bar', async () => {
  const files = new Map<string, string>()
  const fix = { slug: 'round-two', title: 'Draw card titles in violet', kind: 'fix', status: 'applied', created: 1, used: 10 }
  files.set(FIX, JSON.stringify(fix))
  files.set(`${HOME}/fixes/active`, 'round-two\n')
  const toasts: string[] = []
  const commands: string[] = []
  const $ = engine(files, toasts, commands)
  // the first look: what is on already is said by the session start's own line, not here
  await refreshFixes($)
  expect(toasts.length).toBe(0)
  // round 2: Claude runs `thimble fix use` again on the same fix
  files.set(FIX, JSON.stringify({ ...fix, used: 20 }))
  await refreshFixes($)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Draw card titles in violet')
  expect(commands).toEqual(['reload-plugins'])
  expect((await fixLineNow($))?.kind).toBe('applied')
  // nothing new: nothing said, nothing loaded
  await refreshFixes($)
  expect(toasts.length).toBe(1)
  expect(commands.length).toBe(1)
  // the round changed what the fix does: `thimble fix title` gives it the title that says so
  files.set(FIX, JSON.stringify({ ...fix, used: 20, title: 'Draw card titles in teal' }))
  await refreshFixes($)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('Draw card titles in teal')
  expect(commands.length).toBe(1)
  expect(((await fixLineNow($)) as Any)?.title).toBe('Draw card titles in teal')
})
