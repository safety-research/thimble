// submit.ts: submitting fixes as a pull request, which no key leads to now: s in Your fixes shares a fix as a GitHub
// issue the person submits themselves (share.ts). For each fix Claude drafts a title and a summary in one model call
// (share.ts drafted, prompts/fix-draft.md); thimble's privacy scan (`thimble fix draft`, engine/kernel/privacy.py)
// removes the details of the person's data and machine from them, the person's words and the diff; the preview (pane.tsx,
// kind fixsubmit) shows the exact text that leaves. Only the person's key sends it: y opens a pull request from their
// fork, w saves the same text as files, k keeps a detail the scan removed. Each press makes a secret held only here
// (fixes.ts keyPress), so Claude's shell cannot send.
//
//   state: fixSubmit (the fixes the preview walks, the one it shows), fixDraft (a draft as the preview reads it)
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/home'
import { openPane } from '../core/pane'
import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { fixesDir, jsonOf, kernelFix, pressKey, refreshFixes, shownPath } from './fixes'
import { drafted } from './share'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SUBMIT = { plugin: 'thimble', key: 'fixSubmit' } as const
const DRAFT = { plugin: 'thimble', key: 'fixDraft' } as const

export type Hit = { id: string; kind: string; found: string; replacement: string; where: string; kept: boolean }
export type Draft = { id: number; title: string; pr: string; patch: string; hits: Hit[]; problem?: string; done?: string }

async function readText($: Engine, p: string): Promise<string> {
  try { return String(await $.fs.read(p)) } catch { return '' }
}

/** A fix's draft as the kernel wrote it, into the state the preview reads. */
export async function loadDraft($: Engine, id: number): Promise<Draft> {
  const d = `${fixesDir(await thimbleHome($))}/drafts/${id}`
  const hits = jsonOf<Hit[]>(await readText($, `${d}/scan.json`)) ?? []
  const was = ((await $.state.get({ ...DRAFT, id: String(id) })).value ?? {}) as Partial<Draft>
  const draft: Draft = { id, title: (await readText($, `${d}/title`)).trim(), pr: await readText($, `${d}/pr.md`), patch: await readText($, `${d}/fix.patch`), hits, ...(was.done ? { done: was.done } : {}) }
  await $.state.set({ ...DRAFT, id: String(id) }, draft as never)
  return draft
}

export async function draftNow($: Engine, id: number): Promise<Draft | null> {
  return ((await $.state.get({ ...DRAFT, id: String(id) })).value ?? null) as Draft | null
}

export async function submitNow($: Engine): Promise<{ ids: number[]; at: number; problem?: string } | null> {
  return ((await $.state.get(SUBMIT)).value ?? null) as { ids: number[]; at: number; problem?: string } | null
}

/** s in Your fixes: each marked fix drafted and scanned, then the preview of the first. Nothing is sent. */
export async function submitFixes($: Engine, ids: number[]): Promise<void> {
  const ok: number[] = []
  let problem = ''
  for (const id of ids) {
    const d = await drafted($, id)
    if (typeof d === 'string') { problem ||= d; continue }
    const r = await kernelFix($, ['draft', String(id)], { stdin: JSON.stringify({ title: d.title, summary: d.summary }), timeoutMs: 180000, doing: `scanning fix ${id}` })
    if (!r.ok) { problem ||= `Fix ${id} was not drafted: ${cut(r.err || 'the scan gave nothing', 200)}`; continue }
    await $.state.set({ ...DRAFT, id: String(id) }, null as never)
    await loadDraft($, id)
    ok.push(id)
  }
  await $.state.set({ plugin: 'thimble', key: 'fixSubmit' }, { ids: ok, at: 0, ...(problem ? { problem } : {}) } as never)
  await openPane($, 'fixsubmit', {}, ok.length > 1 ? `Submit ${ok.length} fixes` : 'Submit your fix', { focus: true })
}

/** y, w or k in the preview, for the fix it shows: as the person, with the secret of this press. */
export async function submitAction($: Engine, what: 'pr' | 'file' | 'keep', hit?: string): Promise<string | null> {
  const s = await submitNow($)
  const id = s?.ids[s.at]
  if (id == null) return null
  const secret = await pressKey($, id)
  if (what === 'keep') {
    const r = await kernelFix($, ['keep', String(id), String(hit || ''), '--ask', '-'], { stdin: secret, timeoutMs: 60000 })
    await loadDraft($, id)
    return r.ok ? null : `× That detail was not kept: ${cut(r.err || 'thimble fix keep gave nothing', 200)}`
  }
  const r = await kernelFix($, ['send', String(id), '--answer', what, '--ask', '-'], { stdin: secret, timeoutMs: 300000, doing: what === 'pr' ? `sending fix ${id}` : `saving fix ${id}` })
  if (!r.ok) return `× Nothing was ${what === 'pr' ? 'sent' : 'saved'}: ${cut(r.err || 'thimble fix send gave nothing', 200)}`
  const out = jsonOf<Any>(r.out) ?? {}
  const done = what === 'pr' ? `Sent: ${out.pr || ''}` : `Saved as files, nothing sent: ${await shownPath($, String(out.saved || ''))}`
  const d = await draftNow($, id)
  if (d) await $.state.set({ ...DRAFT, id: String(id) }, { ...d, done } as never)
  await tellAtNextPrompt($, `fix-${id}-sent`, `The person ${what === 'pr' ? `sent thimble fix ${id} as a pull request (${out.pr || ''})` : `saved thimble fix ${id} as files`}.`)
  await refreshFixes($)
  // the next fix of the walk, if any
  if (s && s.at + 1 < s.ids.length) await $.state.set(SUBMIT, { ...s, at: s.at + 1 } as never)
  return null
}

/** The preview's next fix without sending this one (esc closes the pane instead). */
export async function submitSkip($: Engine): Promise<void> {
  const s = await submitNow($)
  if (s && s.at + 1 < s.ids.length) await $.state.set(SUBMIT, { ...s, at: s.at + 1 } as never)
}
