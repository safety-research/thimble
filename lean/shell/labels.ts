// labels.ts: the person's side of labels (engine/kernel/labels.py) in the terminal. A label is drawn as a card the
// kernel saves (its counts per value, each value's records as examples), and the detail view shows on every example
// the values labels gave it, how a part's rows split by each label, and lets the person check a record with the number
// keys (panes/detail.js). This module is the host's part of that:
//
//   labelsOf     what k.want({labels: refs, gen}) asks: each record's labels, read through `thimble label --of`,
//                kept per set of refs and per generation (a check starts a new one, so the examples read them again)
//   check        the detail's k.do('check', {label, ref, value}): `thimble label NAME --check REF VALUE`, as the
//                person's command (their session, never counted as what Claude read)
//   checksDone   when the detail closes after checks (or at the next prompt to main, if the close was never heard): the
//                label counted again and its card saved again (drawn in the old one's place), and Claude hears what the
//                person checked, with their next prompt
import type { EngineInterface } from 'claude-code'

import { leanEnv, noteForClaude, showVersion } from './shell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GEN = { plugin: 'thimble', key: 'labelgen' } as const
const OF = { plugin: 'thimble', key: 'labelsof' } as const

/** The checks made since the detail opened, by folder and label: what the person said of which record. */
const made = new Map<string, { root: string; label: string; checks: { ref: string; was: string | null; now: string | null }[] }>()

async function kernel($: Engine, root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], { cwd: root, env: await leanEnv($, root), timeoutMs: 120000 })
  return { ok: r.exitCode === 0, out: `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim() }
}

/** How many checks the person has made: the examples' labels are read again when it changes. */
export async function labelGen($: Engine): Promise<number> {
  return Number((await $.state.get(GEN)).value ?? 0) || 0
}

/** Each record's labels ({ref: {label: {value, values, by, confidence, reason, checked, was}}}), read once per set of
 *  refs and generation. */
export async function labelsOf($: Engine, root: string, refs: string[], gen: number): Promise<unknown> {
  const list = refs.filter(r => typeof r === 'string' && r.length < 2000).slice(0, 200)
  if (!list.length) return {}
  const at = { ...OF, id: `${root}|${gen}|${list.join(' ').slice(0, 4000)}` }
  const kept = (await $.state.get(at)).value
  if (kept !== undefined) return kept
  const r = await kernel($, root, ['label', '--of', ...list])
  let v: unknown
  try { v = JSON.parse(r.out) } catch { v = { error: r.out.split('\n').slice(-1)[0]?.slice(0, 200) || 'thimble label --of gave nothing' } }
  await $.state.set(at, v)
  return v
}

/** The person's check of one record: what they say its value is. Returns a line for the person when it failed. */
export async function check($: Engine, root: string, a: Record<string, unknown>): Promise<string | void> {
  const label = String(a.label || '')
  const ref = String(a.ref || '')
  const value = a.value == null ? '-' : String(a.value)
  if (!label || !ref) return '× There is no record to check here.'
  const r = await kernel($, root, ['label', label, '--check', ref, value, '--json'])
  let got: Any = null
  try { got = JSON.parse(r.out) } catch { got = null }
  if (!r.ok || !got) return `× The check was not kept: ${r.out.split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'}`
  const key = `${root}|${label}`
  const m = made.get(key) ?? { root, label, checks: [] }
  m.checks = [...m.checks.filter(x => x.ref !== got.ref), { ref: got.ref, was: got.was ?? null, now: got.now ?? null }]
  made.set(key, m)
  await $.state.set(GEN, (await labelGen($)) + 1)
}

/** After the detail closes: each label the person checked is counted again and its card saved again, drawn where the
 *  old one is; Claude hears what they checked. */
export async function checksDone($: Engine): Promise<void> {
  const all = [...made.values()]
  made.clear()
  for (const m of all) {
    if (!m.checks.length) continue
    const r = await kernel($, m.root, ['label', m.label, '--json'])
    let s: Any = null
    try { s = JSON.parse(r.out) } catch { s = null }
    if (s?.card && s.card_version) await showVersion($, { id: String(s.card), v: Number(s.card_version), root: m.root })
    const agree = m.checks.filter(c => c.was != null && c.was === c.now)
    const changed = m.checks.filter(c => c.was !== c.now)
    const shown = changed.slice(0, 6).map(c => `${c.ref} (the label said ${c.was ?? 'nothing'}, the person says ${c.now})`)
    await noteForClaude($, `The person checked ${m.checks.length} record${m.checks.length === 1 ? '' : 's'} of the label ${m.label}: they agree with ${agree.length}` +
      (changed.length ? ` and changed ${changed.length}: ${shown.join('; ')}${changed.length > 6 ? '; …' : ''}` : '') +
      `. Their checks count in place of the label's values${s?.query ? `; its counts are now query ${s.query}` : ''}.`)
  }
}

/** Whether the person has made checks Claude has not heard of yet. */
export function checksPending(): boolean {
  return [...made.values()].some(m => m.checks.length > 0)
}

/** For tests: no checks remembered. */
export function resetLabels(): void {
  made.clear()
}
