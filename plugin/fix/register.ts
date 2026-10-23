// register.ts: thimble fix, the person's changes to their own thimble, in the hooks module.
//
//   /thimble-fix <words>   a prompt to Claude: the plugin's prompt command /thimble:thimble-fix (commands/
//                          thimble-fix.md, left out of the menu) runs with the words, so the transcript shows them as
//                          typed, and Claude reads the person's fixes beside it (fixesContext: number, name, state).
//                          Claude starts the fix with the fix-thimble skill, `N <words>` when the words follow up on
//                          fix N, `new <words>` when they are about something else, or first asks one short question.
//                          Typed mid-turn, it waits for the turn's end
//   the fix-thimble skill  a request: the kernel makes a scratch copy (~/.thimble/fixes/work/<id>), and the fixer
//                          (fixer.ts) works in it in the background; N <words> is a round of fix N itself (its fixer's,
//                          or in place: the version the person has stays until y), new <words> a new fix; words with
//                          neither go to the fixer that works, else the fix the line shows, else a new fix
//                          (request.ts). The person asked for it after their
//                          /thimble-fix <words>; else Claude did, on the person's yes to the fix it offered when it
//                          saw thimble misbehave (skills/fix-thimble/SKILL.md, guidance.md). Claude reads what came
//                          of it in the skill's place, and is told when the fix ends
//   /thimble-fix           how to ask for a fix, and that fixes are listed and managed in a shell (thimble fix), at
//                          once, without a turn of Claude's
//   the fixer's calls      its shell runs in the sandbox runtime (no network, reads only the system, its tools and
//                          the copy, writes only the copy), at most 5 minutes a command, with no dialog unless the
//                          person's rules deny the command; Write and Edit only in its copy; its other calls go
//                          through Claude Code's own permission handling, in the person's mode (fixer.ts)
//   every call             only thimble and the person's keys apply, submit or record a fix: Claude's `thimble fix`
//                          calls of those verbs (the fixer's too), and writes into the fixes' folder outside the
//                          fixes' copies, are refused
//   the fixer's end        thimble commits and tests the change; the line above the bar offers y use it now · d what
//                          changed · n later, and Claude Code sends a notification
//   the person's prompt    a line that only told something goes (line.ts)
//   session start          a newer release is out: one line says so (thimble update, in a shell, moves to it)
//
// A newer release comes with `thimble update` in a shell, never inside Claude Code.
//
// The kernel (engine/kernel/fixes.py) holds the records and makes every change to live; nothing here edits a file of
// thimble's or of Claude Code's.
import type { EngineInterface, Register } from 'claude-code'

import { startDir } from '../core/env'
import { thimbleHome } from '../core/home'
import { cut } from '../core/text.js'
import { busyFixer, fixerCall, fixerCallDone, fixerCheck, fixerEnded, fixOfAgent, ownFixes, recoverFixers } from './fixer'
import { type Fix, fixesDir, fixesNow, fixingWord, fixLineNow, fixName, refreshFixes, reloaded, reloadIfDue, setFixLine, checkUpdate, FIX_ALONE, UPDATE_IN_SHELL, updateRan } from './fixes'
import { lineSeen } from './line'
import { fixesContext, request } from './request'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The lead before the words in the skill's text (skills/fix-thimble/SKILL.md), as Claude Code filled in its argument. */
const SKILL_LEAD = 'What thimble does wrong, and what it should do:'

/** The words Claude gave the fix-thimble skill, or '' when it gave none. */
export function wordsOfSkill(text: string): string {
  const i = text.indexOf(SKILL_LEAD)
  const words = i < 0 ? '' : text.slice(i + SKILL_LEAD.length).split(/\n\s*\n/)[0]!.trim()
  if (words && words !== '$ARGUMENTS') return words
  // a skill whose text names no $ARGUMENTS gets them after its text
  return /\nARGUMENTS:\s*([\s\S]+)$/.exec(text)?.[1]?.trim() ?? ''
}

/** The fix-thimble skill, as Claude Code names it (with the plugin's name, or without). */
const FIX_SKILL = /^(?:thimble:)?fix-thimble$/

/** What Claude reads when the skill's hook failed: the reason, so that it tells the person the truth. */
export function notStarted(error: { kind?: string; message?: string } | undefined): string {
  const why = error?.kind === 'timeout' ? `it took too long${error.message ? ` (${error.message})` : ''}` : error?.message || 'it failed'
  return `thimble started no fix: its fix-thimble hook failed: ${cut(why, 240)}. Tell the person in one short line, with that reason.`
}

/** The fix-thimble skill with Claude's words: the request, and what Claude reads of it in the skill's place. */
async function startFromSkill($: Engine, words: string): Promise<string> {
  if (!words) return 'thimble started no fix: the skill needs, as its argument, what thimble does wrong and what it should do. Call it again with those words.'
  // after the person's /thimble-fix <words>, the request is theirs: the fixer reads their words as theirs
  const asked = Number((await $.state.get(ASKED)).value ?? 0) > 0
  if (asked) await $.state.set(ASKED, 0 as never)
  const r = await request($, words, asked ? 'person' : 'claude', false)
  if (r.failed || !r.fix) return `${r.text.replace(/^×\s*/, '')} Tell the person in one short line.`
  // the fix by its name, never its number: a round changes the fix in place, a new fix is one of its own
  const then = 'Tell the person in one short line, then go on with their request.'
  const name = `"${fixName(r.fix)}"`
  if (r.live) return `thimble gave these words to the fork that is already ${fixingWord(r.fix).replace(/ .*/, '')} ${name}. ${then}`
  if (r.round) {
    return `thimble started a fork of this conversation that changes the person's fix ${name} in the background, in a copy${r.fix.prev ? '; the version they have stays until they press y' : ''}. The person sees "${fixingWord(r.fix)}" on the bar while it works, and decides with a key whether to use the changed fix. ${then} thimble tells you when it ends.`
  }
  return `thimble started a fork of this conversation that fixes thimble in the background, in a copy (${name}). The person sees "${fixingWord(r.fix)}" on the bar while it works, and decides with a key whether to use the fix. ${then} thimble tells you when the fix ends.`
}

/** The strays the line told of already (kept across a reload of the module). */
const STRAYS = { plugin: 'thimble', key: 'fixStrays' } as const

/** A follow-up from before rounds changed a fix in place, which the kernel folded into its fix as a new version that
 *  waits for y (its line offers it), or could not fold because the lines conflict (the line says how Claude can).
 *  Once a stray, and only while no other line shows. */
export async function strayLine($: Engine, fixes: Fix[]): Promise<void> {
  if (await fixLineNow($)) return
  const told = new Set(((await $.state.get(STRAYS)).value ?? []) as string[])
  const waits = fixes.find(f => f.state === 'ready' && f.prev && !f.work && (f.merged ?? []).some(m => !told.has(`w${m}`)))
  const stuck = fixes.find(f => f.fold_conflict != null && !told.has(`c${f.id}`))
  if (waits) {
    for (const m of waits.merged ?? []) told.add(`w${m}`)
    await setFixLine($, { id: waits.id, kind: 'ready' })
  } else if (stuck) {
    told.add(`c${stuck.id}`)
    const into = fixes.find(f => f.id === stuck.fold_conflict)
    await setFixLine($, { id: stuck.id, kind: 'problem', said: `“${fixName(stuck)}” follows up on “${into ? fixName(into) : `fix ${stuck.fold_conflict}`}”, and their lines conflict, so thimble could not join them. /thimble-fix ${stuck.fold_conflict} fold in fix ${stuck.id} asks Claude to.` })
  } else return
  await $.state.set(STRAYS, [...told] as never)
}

/** The kernel's verbs that are thimble's own (the plugin's lifecycle and the person's keys), and `thimble file issue` and
 *  `thimble file pr`, which post the person's fix publicly from their own terminal: never Claude's. */
const OWN_VERBS = /\bthimble\s+(?:fix\s+(?:new|round|again|done|apply|merge|notnow|redo|undo|remove|sandbox|draft|keep|send)|file\s+(?:issue|pr))\b/

/** The fixers this load knows, so a guard that fails can still refuse their calls. */
/** Whether this session looked for a newer release already (kept across a reload of the module). */
const UPDATED = { plugin: 'thimble', key: 'fixUpdated' } as const

const fixerAgents = new Set<string>()

/** The person's /thimble-fix <words>: the turns of main's in which the fix-thimble skill is still the person's request
 *  (the turn of the command, and the one after Claude's question). */
const ASKED = { plugin: 'thimble', key: 'fixAsked' } as const

async function knowFixers($: Engine): Promise<void> {
  for (const id of Object.keys(((await $.state.get({ plugin: 'thimble', key: 'fixers' })).value ?? {}) as Record<string, number>)) fixerAgents.add(id)
}

/** An absolute path with its . and .. parts resolved, so that live/../asks is asks. */
export function normal(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return p.startsWith('/') ? `/${out.join('/')}` : out.join('/')
}

/** A call of Claude's (main's, or any agent's but a fixer's) that would do what only thimble or the person's key does. */
async function refusal($: Engine, e: Any): Promise<string | null> {
  if (e.tool === 'Bash') {
    return OWN_VERBS.test(String(e.command ?? ''))
      ? 'Only thimble and the person do that: /thimble-fix asks for a fix, the person applies it with a key in thimble, and sends it with `thimble file issue` or `thimble file pr` in their own terminal. `thimble fix list`, `show`, `diff`, `export`, `off` and `on` are yours to run.'
      : null
  }
  const p = normal(String(e.file_path ?? e.notebook_path ?? ''))
  const dir = fixesDir(await thimbleHome($))
  if (!p.startsWith(`${dir}/`) || p.startsWith(`${dir}/work/`)) return null
  // the session the person opened in live with the pending fixes' prompt (thimble update printed its command) edits
  // live's code; thimble update --continue then checks each commit before it records it
  const start = await startDir($)
  if (p.startsWith(`${dir}/live/`) && (start === `${dir}/live` || start.startsWith(`${dir}/live/`))) return null
  return "thimble's fixes are changed by thimble alone; /thimble-fix asks for a change."
}

export const registerFix: Register = on => {
  on('session.start', { cwd: /^\/.*$/ }, async ($, e, next) => {
    const r = await next(e)
    // not immediate: words typed mid-turn wait for the turn's end, as a prompt does
    try {
      await $.command.register({ name: 'thimble-fix', description: 'Change thimble for yourself: say what should work differently. Alone: your fixes.', argumentHint: '[what should work differently]' })
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
      // a reload the line waited for: this is it
      else await reloaded($)
      // a follow-up from before rounds changed a fix in place, folded in by the kernel: once, its fix's line
      await strayLine($, list?.fixes ?? [])
      const working = await ownFixes($, (list?.fixes ?? []).filter(f => f.state === 'working'))
      for (const f of working) busyFixer($, f, async () => (await refreshFixes($))?.fixes.find(x => x.id === f.id))
      await recoverFixers($, working)
      // a newer release: one line says so, once per session (a reload starts the module again)
      if (list?.pointed && !(await $.state.get(UPDATED)).value) {
        await $.state.set(UPDATED, true as never)
        await checkUpdate($)
      }
    })().catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // /thimble-fix alone and /thimble-fix update answer here, without a turn; words become the prompt command's run
  // (commands/thimble-fix.md), whose row in the transcript shows them, a moment after this hook (a run from inside it
  // would wait on it)
  on('command.run', { command: /^(?:thimble:)?thimble-fix$/ }, async ($, e, next) => {
    const words = String(e.args || '').trim()
    if (/^update$/i.test(words)) return { text: UPDATE_IN_SHELL }
    if (!words) return { text: FIX_ALONE }
    await $.state.set(ASKED, 2 as never)
    if (e.command !== 'thimble-fix') {
      // the prompt command: Claude reads the person's fixes beside it, to tell a follow-up from a new fix
      const r = await next(e)
      const list = fixesContext((await refreshFixes($))?.fixes ?? [])
      return list ? { ...r, context: [...(r?.context ?? []), list] } : r
    }
    $.clock.after(0, () => {
      void $.command.run({ command: 'thimble:thimble-fix', args: words } as never).catch(err => $.ui.toast(`thimble could not ask Claude for this fix: ${cut(String((err as Error)?.message || err), 160)}`))
    })
    return {}
  })

  // one /thimble-fix in the menu: the prompt command it runs stays out of it
  on('command.describe', { command: 'thimble:thimble-fix' }, async ($, e, next) => ({ ...(await next(e)), isHidden: true })).catch(($, e, next) => next(e))

  // the fix-thimble skill: Claude asks for the same fix, in the skill's argument, and reads what came of it in the
  // skill's place. It is answered at the Skill tool's call, which every person's plugin gets: where an organization
  // manages Claude Code, its built-in security plugin sends skill.prompt on past the plugins a person installs, so a
  // skill.prompt hook alone never ran there. The skill then does not run, so no fix starts twice. A hook that fails
  // says why, in the skill's place
  on('tool.call', { tool: 'Skill', skill: FIX_SKILL }, async ($, e, next) => {
    if (e.tool !== 'Skill' || !FIX_SKILL.test(String(e.skill ?? ''))) return next(e)
    const text = await startFromSkill($, String(e.args ?? '').trim())
    return { result: { success: true, commandName: String(e.skill) }, context: [text] } as never
  }).catch(($, e, next) => (next.called ? next(e) : { deny: notStarted(next.error) }))

  // the same skill expanded some other way (a subagent's preload): the skill's text is what came of it. A Claude Code
  // without the hooks module leaves the skill's own text (SKILL.md), which says thimble's hooks did not answer
  on('skill.prompt', { skill: FIX_SKILL }, async ($, e, next) => ({ text: await startFromSkill($, wordsOfSkill(String(e.text ?? ''))) }))
    .catch(($, e, next) => (next.called ? next(e) : { text: notStarted(next.error) }))

  // every call, the fixer's too: the verbs and the folder that are thimble's own and the person's keys'. The fixer's
  // shell then runs in the sandbox runtime, and its writes stay in its copy
  on('tool.call', { tool: /^(?:Bash|Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const id = e.agentId ? await fixOfAgent($, e.agentId) : null
    if (id != null) fixerAgents.add(String(e.agentId))
    const no = await refusal($, e)
    if (no) return { deny: no }
    const f = id != null ? await fixerCall($, e, id) : null
    if (f?.deny) return { deny: f.deny }
    const r = await next((f?.call ?? e) as never)
    if (f?.call) fixerCallDone(e)
    // after Claude's thimble update --continue (in the session thimble reapply opens), the plugins load again
    if (e.tool === 'Bash' && /\bthimble\s+(?:fix\s+)?update\b/.test(String(e.command ?? ''))) await updateRan($).catch(() => undefined)
    return r
  }).catch(($, e, next) => (fixerAgents.has(String(e.agentId)) ? { deny: 'thimble could not check this call of the fixer.' } : next(e)))

  // the fixer's shell commands in the sandbox need no dialog, as Claude Code's own sandboxed commands need none
  on('tool.check', { agentId: /^[\s\S]+$/ }, async ($, e, next) => {
    if ((await fixOfAgent($, e.agentId)) == null) return next(e)
    return ((await fixerCheck($, e)) ?? next(e)) as never
  }).catch(($, e, next) => next(e))

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
      const asked = Number((await $.state.get(ASKED)).value ?? 0)
      if (asked > 0) await $.state.set(ASKED, (asked - 1) as never)
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
