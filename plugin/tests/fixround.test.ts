// A fix's rounds in the terminal (shell/fix.ts refreshFixes): each `thimble fix use` of the same fix loads the plugins
// again and says the fix once, and a new title from a later round reaches the toast and the bar's line. All data is
// made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { fixCommand, fixLineNow, refreshFixes } from '../shell/fix'

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

const TEAL = `${HOME}/fixes/teal-titles/fix.json`
const ACTIVE = `${HOME}/fixes/active`

/** An engine whose `thimble fix` changes the made-up fixes as the kernel does, in a session that runs the fix's copy
 *  through the marketplace (Claude Code reads a folder marketplace in place, so the plugin's root is the copy). */
function sessionOnCopy(files: Map<string, string>, toasts: string[], commands: string[]): Any {
  const $ = engine(files, toasts, commands)
  const fix = () => JSON.parse(files.get(TEAL) || 'null')
  const said: Record<string, string> = {
    use: 'thimble now runs the fix teal-titles from /made-up/copy/plugin. This Claude Code session loads it by itself once it is idle, so the person has nothing to do.',
    undo: 'thimble is back to the release from /made-up/release. This Claude Code session loads it by itself once it is idle, so the person has nothing to do.',
    remove: "thimble is back to the release from /made-up/release. Removed the fix 'Titles in teal': its copy and its record (1 MB).",
  }
  return {
    ...$,
    plugin: { root: `${HOME}/fixes/teal-titles/worktree/plugin`, name: 'thimble' },
    env: { get: async (name: string) => ({ THIMBLE_HOME: HOME, THIMBLE_ROOT: '/made-up/data' } as Any)[name] },
    fs: { ...$.fs, exists: async (p: string) => files.has(p) },
    session: { id: async () => 'made-up-session', cwd: async () => '/made-up/data', messages: async () => [] },
    // what runs a moment later (after 0) runs as the session would; the bar's busy ticks never do
    clock: { ...$.clock, now: async () => 0, after: (ms: number, fn: () => void) => { if (!ms) void Promise.resolve().then(fn); return { cancel() {} } } },
    ui: { ...$.ui, log: () => undefined },
    process: {
      run: async (args: string[]) => {
        if (args[0] === 'ls') return { exitCode: 0, stdout: files.has(TEAL) ? 'teal-titles\nactive\n' : '', stderr: '' }
        const verb = args[2]!
        if (verb === 'use') { files.set(TEAL, JSON.stringify({ ...fix(), status: 'applied', used: fix().used + 1 })); files.set(ACTIVE, 'teal-titles\n') }
        if (verb === 'undo') { files.delete(ACTIVE); files.set(TEAL, JSON.stringify({ ...fix(), status: 'ready' })) }
        if (verb === 'remove') { files.delete(ACTIVE); files.delete(TEAL) }
        return { exitCode: 0, stdout: `${said[verb] || ''}\n`, stderr: '' }
      },
    },
  }
}

/** The work a command leaves running (refreshFixes, started without waiting), done. */
const settle = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

test('round 2 loads the plugins in a session that already runs the copy, and undo, try and remove each load them once', async () => {
  const files = new Map<string, string>()
  files.set(TEAL, JSON.stringify({ slug: 'teal-titles', title: 'Titles in teal', kind: 'fix', status: 'applied', created: 1, used: 10 }))
  files.set(ACTIVE, 'teal-titles\n')
  const toasts: string[] = []
  const commands: string[] = []
  const $ = sessionOnCopy(files, toasts, commands)
  // the look after round 1's load (an earlier test's fixes may have been seen first)
  await refreshFixes($)
  commands.length = 0
  // round 2: Claude runs `thimble fix use` again; the session runs the copy since round 1, and loads this round too
  files.set(TEAL, JSON.stringify({ ...JSON.parse(files.get(TEAL)!), used: 20 }))
  await refreshFixes($)
  expect(commands).toEqual(['reload-plugins'])
  // undo, try and remove: one load each
  await fixCommand($, 'undo')
  await settle()
  expect(commands.length).toBe(2)
  await fixCommand($, 'try')
  await settle()
  expect(commands.length).toBe(3)
  await fixCommand($, 'remove')
  await settle()
  expect(commands.length).toBe(4)
  // nothing new: nothing loads
  await refreshFixes($)
  expect(commands.length).toBe(4)
})
