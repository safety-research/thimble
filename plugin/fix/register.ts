// register.ts: thimble fix, the person's changes to their own thimble, in the hooks module.
//
//   /thimble-fix <words>   a request: the kernel makes a scratch copy (~/.thimble/fixes/work/<id>), and the fixer
//                          (fixer.ts) works in it in the background; while the line of a fix with a copy shows, the
//                          words are a new round of that fix (request.ts)
//   /thimble-fix           Your fixes (pane.tsx)
//   the fixer's calls      Claude Code's own permission handling, in the person's mode, as any subagent's
//   every call             only thimble and the person's keys apply, submit or record a fix: Claude's `thimble fix`
//                          calls of those verbs (the fixer's too), and writes into the fixes' folder outside the
//                          fixes' copies, are refused
//   the fixer's end        thimble commits and tests the change; the line above the bar offers y use it · d · n
//   the person's prompt    a line that only told something goes (line.ts)
//
// A newer release comes with `thimble update` in a shell, never inside Claude Code.
//
// The kernel (engine/kernel/fixes.py) holds the records and makes every change to live; nothing here edits a file of
// thimble's or of Claude Code's.
import type { EngineInterface, Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { thimbleHome } from '../core/home'
import { cut } from '../core/text.js'
import { fixerEnded, fixOfAgent, recoverFixers } from './fixer'
import { fixesDir, fixesNow, fixLineNow, refreshFixes, reloadIfDue, setFixLine } from './fixes'
import { lineSeen } from './line'
import { openFixes } from './pane'
import { requestFix } from './request'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The kernel's verbs that are thimble's own (the plugin's lifecycle and the person's keys), never Claude's. */
const OWN_VERBS = /\bthimble\s+fix\s+(?:new|round|done|apply|notnow|redo|undo|remove|sandbox|draft|keep|send)\b/

/** The fixers this load knows, so a guard that fails can still refuse their calls. */
const fixerAgents = new Set<string>()

async function knowFixers($: Engine): Promise<void> {
  for (const id of Object.keys(((await $.state.get({ plugin: 'thimble', key: 'fixers' })).value ?? {}) as Record<string, number>)) fixerAgents.add(id)
}

/** A call of Claude's (main's, or any agent's but a fixer's) that would do what only thimble or the person's key does. */
async function refusal($: Engine, e: Any): Promise<string | null> {
  if (e.tool === 'Bash') {
    return OWN_VERBS.test(String(e.command ?? ''))
      ? 'Only thimble and the person do that: /thimble-fix asks for a fix, and the person applies or submits it with a key in thimble. `thimble fix list`, `show`, `diff`, `export`, `off` and `on` are yours to run.'
      : null
  }
  const p = String(e.file_path ?? e.notebook_path ?? '')
  const dir = fixesDir(await thimbleHome($))
  if (p.startsWith(`${dir}/`) && !p.startsWith(`${dir}/work/`)) return "thimble's fixes are changed by thimble alone; /thimble-fix asks for a change."
  return null
}

export const registerFix: Register = on => {
  on('session.start', { cwd: /^\/.*$/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'thimble-fix', description: 'Change thimble for yourself: say what should work differently. Alone: your fixes.', argumentHint: '[what should work differently]', immediate: true })
    } catch {
      // the command is missing in this session; the shell's `thimble fix list` still works
    }
    // the fixes as they stand, without holding the session's start; a reload while a fixer works shows it again
    void (async () => {
      await knowFixers($)
      const list = await refreshFixes($)
      // a fix's line that no longer holds (the shell turned the fixes off, or the fix went off): it goes
      const l = await fixLineNow($)
      const lf = l ? list?.fixes.find(f => f.id === l.id) : null
      if (l?.kind === 'applied' && (list?.on === false || (lf && lf.state !== 'on'))) await setFixLine($, null)
      const working = (list?.fixes ?? []).filter(f => f.state === 'working')
      for (const f of working) void busyWhile($, `fixing: ${cut(f.title, 36)} · in a copy`, async () => ((await refreshFixes($))?.fixes.find(x => x.id === f.id)?.state === 'working'))
      await recoverFixers($, working)
    })().catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'thimble-fix' }, async ($, e) => {
    const words = String(e.args || '').trim()
    if (/^update$/i.test(words)) return { text: 'A newer thimble comes with `thimble update` in a shell, outside Claude Code. It keeps your fixes.' }
    if (!words) {
      const placed = await openFixes($)
      return placed ? {} : { text: 'Your fixes open in a pane in a wider terminal. In a shell: thimble fix list' }
    }
    return { text: await requestFix($, words) }
  })

  // every call, the fixer's too: the verbs and the folder that are thimble's own and the person's keys'. The fixer's
  // other calls go through Claude Code's own permission handling, as any subagent's do
  on('tool.call', { tool: /^(?:Bash|Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    if (e.agentId && (await fixOfAgent($, e.agentId)) != null) {
      // the fixer writes in its copy (~/.thimble/fixes/work/<id>), which the folder rule allows
      fixerAgents.add(String(e.agentId))
    }
    const no = await refusal($, e)
    return no ? { deny: no } : next(e)
  }).catch(($, e, next) => (fixerAgents.has(String(e.agentId)) ? { deny: 'thimble could not check this call of the fixer.' } : next(e)))

  // the fixer's end: thimble commits and tests its change, a moment after (the tests take a while)
  on('turn.complete', { agentId: /^[\s\S]+$/ }, async ($, e, next) => {
    const r = await next(e)
    const id = await fixOfAgent($, e.agentId)
    // not awaited: the commit and the tests take a while, and the turn's end should not wait on them
    if (id != null) void fixerEnded($, e, id)
    return r
  }).catch(($, e, next) => next(e))

  // the end of main's turn: a reload of the plugins asked inside it runs now
  on('turn.complete', { reason: /^[\s\S]*$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      $.clock.after(0, () => {
        void reloadIfDue($).catch(() => undefined)
        void (async () => recoverFixers($, ((await fixesNow($))?.fixes ?? []).filter(f => f.state === 'working')))().catch(() => undefined)
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  // the person's prompt: a line that only told something goes
  on('prompt.submit', { origin: { kind: /^(?:composer)$/ } }, async ($, e, next) => {
    if (!e.command) await lineSeen($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))
}
