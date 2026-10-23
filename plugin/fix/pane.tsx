// pane.tsx: Your fixes (core/pane.ts kind `fixes`), which /thimble-fix alone opens, and the submit preview (kind
// `fixsubmit`). Both take the keys while open; esc closes them.
//
//   Your fixes   every request, newest first, but those the release now holds: its state (on, off, ready, failed,
//                redo, request, sent, saved), its title, its date and a note; under the list what the selected fix
//                changed: the person's words, what Claude did, its files and tests. j k move, ↵ selects, m marks, y
//                turns a ready or off fix on (only this press does: the fix's code then runs as thimble), u turns an
//                on fix off, r redo, s shares the marked fixes (or the selected one), g merges the marked fixes into
//                the one marked first (merge.ts; only this press does), x removes, a turns every fix off or on.
//   Share        after s, in place of the selected fix: for each fix shared, what the privacy check took out and what
//                to do with its GitHub link (share.ts); o opens GitHub's new-issue page with the text, c copies the
//                link. Nothing is sent from here.
//   Submit       for the fix the walk is on: where it goes and as whom, each detail the scan removed with its
//                placeholder and why, and the exact text that leaves. y sends (a pull request), w saves the same text
//                as files, k keeps the first detail that can be kept, esc cancels. Only these presses send. No key
//                leads here now: s shares instead (openSubmit still opens it).
//
//   state: fixView (the selection, the marks, the diff, the share), fixShare (share.ts), fixSubmit and fixDraft
//   (submit.ts)
import type { EngineInterface } from 'claude-code'

import { quiet } from '../core/askcell.js'
import { openPane } from '../core/pane'
import { cut, textWidth } from '../core/text.js'
import { ACCENT } from '../core/theme'
import { testsWord } from './fixer'
import { allOffOn, applyFix, type Fix, fixesNow, refreshFixes, removeFix, shownPath, sizeOf, undoFix } from './fixes'
import { mergeFixes } from './merge'
import { redoFix } from './request'
import { copyLink, openOnGitHub, type ShareState, shareFixes, shareNow } from './share'
import { type Draft, draftNow, type Hit, submitAction, submitFixes, submitNow, submitSkip } from './submit'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const VIEW = { plugin: 'thimble', key: 'fixView' } as const
/** A key the person can press, in thimble's accent as the bar draws its keys (core/theme.ts). */
const KEY_COLOR = ACCENT

type View = { sel: number | null; marked: number[]; diff: boolean; share: boolean }

/** How each state is drawn: a glyph, its word, its color. */
const LOOK: Record<string, { g: string; w: string; c?: string; dim?: boolean }> = {
  on: { g: '●', w: 'on', c: 'success' }, off: { g: '○', w: 'off', dim: true }, ready: { g: '◆', w: 'ready', c: 'warning' },
  working: { g: '…', w: 'working', dim: true }, failed: { g: '×', w: 'failed', c: 'error' }, redo: { g: '!', w: 'redo', c: 'warning' },
  request: { g: '◇', w: 'request', c: KEY_COLOR }, sent: { g: '↑', w: 'sent', c: KEY_COLOR }, saved: { g: '↓', w: 'saved', dim: true },
  released: { g: '✓', w: 'released', dim: true }, pending: { g: '○', w: 'off', dim: true },
}

async function viewNow($: Engine): Promise<View> {
  return { sel: null, marked: [], diff: false, share: false, ...(((await $.state.get(VIEW)).value ?? {}) as Partial<View>) }
}

async function setView($: Engine, v: Partial<View>): Promise<void> {
  await $.state.set(VIEW, { ...(await viewNow($)), ...v } as never)
}

/** /thimble-fix alone: Your fixes, with `sel` selected. */
export async function openFixes($: Engine, o: { sel?: number; diff?: boolean } = {}): Promise<boolean> {
  const list = await refreshFixes($)
  const v = await viewNow($)
  const sel = o.sel ?? v.sel ?? list?.fixes[0]?.id ?? null
  await setView($, { sel, diff: !!o.diff, share: false })
  return openPane($, 'fixes', {}, 'Your fixes', { focus: true })
}

/** A note for the list: what the person may want to know of the fix's state. */
function noteOf(f: Fix): string {
  if (f.state === 'on' && (f.rounds || 1) > 1) return `${f.rounds} rounds`
  if (f.state === 'ready') return (f.rounds || 1) > 1 ? `waits for y · ${f.rounds} rounds` : 'waits for y'
  if (f.state === 'working') return 'Claude works on it'
  if (f.state === 'pending') return `${f.note || 'set aside at an update'} · thimble reapply in a shell`
  if (f.state === 'failed' || f.state === 'redo') return f.error || ''
  if (f.state === 'request') return 'no code'
  if (f.state === 'sent') return f.pr || ''
  if (f.state === 'saved') return 'saved as files'
  return f.note || ''
}

function date(t: number): string {
  const d = new Date(Number(t) * 1000)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function keys(els: Any, list: [string, string, () => unknown][]): Any {
  const { Box, Button, Text } = els
  // a plain Button with a hotkey draws `d: diff`, the key in the accent color
  return Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: list.flatMap(([k, w, press], i) => [
    ...(i ? [Text({ key: `ks${i}`, dimColor: true, children: ' · ' })] : []),
    // under the pointer its words brighten and underline, never Claude Code's inverse, as the other panes' keys do
    Button({ key: `key-${k}`, plain: true, hotkey: k, label: w, hover: quiet(`fix-key-${k}`), onPress: press }),
  ]) })
}

function diffRows(els: Any, diff: string, width: number): Any[] {
  const { Text } = els
  return String(diff || '').replace(/\s+$/, '').split('\n').slice(0, 400).map((line, i) => {
    const tone = line.startsWith('+') && !line.startsWith('+++') ? { color: 'diffAdded' } : line.startsWith('-') && !line.startsWith('---') ? { color: 'diffRemoved' } : line.startsWith('@@') || line.startsWith('diff ') ? { dimColor: true } : {}
    return Text({ key: `d${i}`, ...tone, wrap: 'truncate-end', children: cut(line, width) || ' ' })
  })
}

/** After s: each fix shared, what the privacy check took out, and what to do with its GitHub link. */
async function shareRows($: Engine, els: Any, s: ShareState): Promise<Any[]> {
  const { Text } = els
  const out: Any[] = []
  const check = (key: string, words: string) => Text({ key, children: [Text({ key: 'g', color: 'success', children: '  ✓ ' }), Text({ key: 'w', children: words })] })
  for (const id of s.ids) {
    const it = s.items.find(x => x.id === id)
    if (!it) {
      out.push(Text({ key: `sh${id}`, children: [Text({ key: 'a', bold: true, children: `Share fix ${id}` }), Text({ key: 'b', dimColor: true, children: ': Claude writes the text…' })] }))
      continue
    }
    out.push(Text({ key: `sh${id}`, bold: true, wrap: 'wrap', children: `Share fix ${id}: ${it.title}` }))
    if (it.problem) {
      out.push(Text({ key: `shp${id}`, color: 'error', wrap: 'wrap', children: `  × ${it.problem}` }))
      continue
    }
    out.push(check(`sht${id}`, `privacy check: ${it.took}`))
    if (it.opened) out.push(check(`sho${id}`, 'opened the GitHub issue in your browser'))
    if (it.shortened) out.push(Text({ key: `shl${id}`, dimColor: true, wrap: 'wrap', children: '  · the text is longer than a GitHub link holds, so the link has the first part of it' }))
    if (it.note) out.push(Text({ key: `shn${id}`, color: 'warning', wrap: 'wrap', children: `  · ${it.note}` }))
  }
  if (s.items.some(x => !x.problem)) {
    out.push(Text({ key: 'shg', children: ' ' }))
    out.push(Text({ key: 'shw', wrap: 'wrap', children: "o opens GitHub's new-issue page with this text, c copies its link. Read the text there, paste a screenshot if you want, and press Submit; nothing is sent until you do." }))
  }
  return out
}

export async function drawFixes($: Engine, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const W = Math.max(40, Number(e.props?.bodyColumns) || 80)
  const list = await fixesNow($)
  // a fix the release now holds is no longer the person's to keep
  const fixes = (list?.fixes ?? []).filter(f => f.state !== 'released')
  const v = await viewNow($)
  const say = (said: string | null | void) => { if (said) $.ui.toast(said) }
  const head = Box({ key: 'head', flexDirection: 'column', children: [
    Text({ key: 'h1', children: [Text({ key: 'a', bold: true, children: 'Your fixes' }), Text({ key: 'b', dimColor: true, children: list && !list.on ? ` · thimble ${list.version} alone · ${list.count_on} kept off` : ` · thimble ${list?.version || ''}${list?.version ? ' ' : ''}+ ${list?.count_on ?? 0} on` })] }),
    Text({ key: 'h2', dimColor: true, children: list?.live ? `${await shownPath($, list.live)} · branch mine` : 'No fixes yet.' }),
  ] })
  if (!fixes.length) {
    return Box({ flexDirection: 'column', width: W, children: [head, Text({ key: 'none', children: ' ' }),
      Text({ key: 'how', wrap: 'wrap', children: 'Ask for a change at the prompt: /thimble-fix <what should work differently>. Claude makes it in a copy of thimble, and you apply it with y.' })] })
  }
  const sel = fixes.find(f => f.id === v.sel) ?? fixes[0]!
  const tw = Math.max(16, Math.min(40, W - 34))
  const rows = fixes.map(f => {
    const look = LOOK[f.state] ?? { g: '·', w: f.state, dim: true }
    const tone = look.c ? { color: look.c } : { dimColor: true }
    const marked = v.marked.includes(f.id)
    return Button({ key: `fix-${f.id}`, plain: true, label: `fix ${f.id} ${f.title}`, onPress: () => setView($, { sel: f.id }), ...(f.id === sel.id ? { autoFocus: true } : {}), children: [
      Text({ key: 'p', children: f.id === sel.id ? '▸ ' : '  ' }),
      Text({ key: 'm', color: KEY_COLOR, children: marked ? '☑ ' : '  ' }),
      Text({ key: 'g', ...tone, children: `${look.g} ${look.w.padEnd(9)}` }),
      Text({ key: 't', ...(f.state === 'on' || f.state === 'ready' ? { bold: f.id === sel.id } : { dimColor: f.state === 'released' || f.state === 'off' }), children: cut(f.title, tw).padEnd(tw) }),
      Text({ key: 'd', dimColor: true, children: `  ${date(f.created)}  ` }),
      Text({ key: 'n', ...(f.state === 'redo' || f.state === 'failed' ? { color: 'warning' } : { dimColor: true }), children: cut(noteOf(f), Math.max(8, W - tw - 30)) }),
    ] })
  })
  // what the selected fix changed, in a few lines, as d on the line shows it; after s, what sharing did
  const detail: Any[] = [Text({ key: 'rule', dimColor: true, children: '─'.repeat(Math.min(W, 60)) })]
  const shared = v.share ? await shareNow($) : null
  const labeled = (key: string, label: string, text: string, tone: Any = {}) => Box({ key, flexDirection: 'row', width: W, children: [
    Box({ key: 'l', width: 12, flexShrink: 0, children: [Text({ key: 't', dimColor: true, children: label.padEnd(12) })] }), Box({ key: 'v', flexShrink: 1, children: [Text({ key: 't', wrap: 'wrap', ...tone, children: text })] }),
  ] })
  if (shared) {
    // what sharing did stands in for the fix's details until the person moves
    detail.push(...(await shareRows($, els, shared)))
  } else {
    detail.push(Text({ key: 'st', children: [Text({ key: 'a', bold: true, children: sel.title }), Text({ key: 'b', dimColor: true, children: `  fix ${sel.id}${sel.commit ? ` · commit ${sel.commit.slice(0, 7)}` : ''} · made in ${sel.made_in || 'terminal'}` })] }))
    for (const [i, w] of (sel.words || []).entries()) detail.push(labeled(`w${i}`, i ? 'then' : 'You asked', cut(w, 400)))
    if (sel.summary) detail.push(labeled('sum', 'Claude did', sel.summary))
    if (sel.files?.length) detail.push(labeled('files', 'Changed', `${sizeOf(sel)} · ${testsWord(sel)} · ${sel.rounds || 1} round${(sel.rounds || 1) === 1 ? '' : 's'}`))
    if ((sel.state === 'failed' || sel.state === 'redo') && sel.error) detail.push(labeled('why', 'Why', `${sel.state === 'redo' ? 'It does not fit your thimble now' : 'It did not pass'}: ${sel.error}. r asks Claude to redo it; your words and the old change are kept.`, { color: 'warning' }))
  }
  const canUse = (sel.state === 'off' || sel.state === 'ready') && !!sel.commit
  const use = async () => say(canUse ? await applyFix($, sel.id) : `Fix ${sel.id} is ${sel.state}: there is nothing to turn on.`)
  const undo = async () => say(sel.state === 'on' ? await undoFix($, sel.id) : `Fix ${sel.id} is ${sel.state}, not on.`)
  const move = (d: number) => async () => {
    const i = Math.max(0, Math.min(fixes.length - 1, fixes.findIndex(f => f.id === sel.id) + d))
    await setView($, { sel: fixes[i]!.id, diff: false, share: false })
  }
  const mark = async () => {
    const m = new Set(v.marked)
    if (m.has(sel.id)) m.delete(sel.id)
    else m.add(sel.id)
    await setView($, { marked: [...m] })
  }
  const share = async () => {
    const ids = v.marked.length ? v.marked : [sel.id]
    await setView($, { marked: [], diff: false, share: true })
    await shareFixes($, ids)
  }
  // the marked fixes become one under the one marked first: by this key alone
  const merge = async () => {
    const ids = v.marked.filter(id => fixes.some(f => f.id === id))
    const said = await mergeFixes($, ids)
    if (!said) await setView($, { marked: [], sel: ids[0] ?? null })
    say(said)
  }
  // o and c act on the shared fix the list has selected, else the first one shared
  const sharedOne = shared?.items.find(x => x.id === sel.id && !x.problem) ?? shared?.items.find(x => !x.problem)
  const key = keys(els, [
    ['j', 'down', move(1)], ['k', 'up', move(-1)], ['m', 'mark', mark],
    ...(sel.state === 'on' ? [['u', 'undo', undo] as [string, string, () => unknown]] : [['y', 'use it now', use] as [string, string, () => unknown]]),
    ['r', 'redo', async () => say(await redoFix($, sel.id))],
    ['s', v.marked.length > 1 ? `share ${v.marked.length}` : 'share', share],
    ...(v.marked.length > 1 ? [['g', `merge ${v.marked.length} into fix ${v.marked[0]}`, merge] as [string, string, () => unknown]] : []),
    ['x', 'remove', async () => say(await removeFix($, sel.id))],
    ['a', list?.on === false ? 'all on' : 'all off', async () => say(await allOffOn($, list?.on === false))],
    ...(sharedOne ? [
      ['o', 'open on GitHub', async () => say(await openOnGitHub($, sharedOne.id))] as [string, string, () => unknown],
      ['c', 'copy the link', async () => say(await copyLink($, sharedOne.url || ''))] as [string, string, () => unknown],
    ] : []),
  ])
  return Box({ flexDirection: 'column', width: W, children: [head, Text({ key: 'g1', children: ' ' }), ...rows, Text({ key: 'g2', children: ' ' }), ...detail, Text({ key: 'g3', children: ' ' }), key] })
}

/** Why the scan removed a detail, in the person's words. */
const WHY: Record<string, string> = {
  path: 'a path on your machine', email: 'an email address', token: 'a key or token', key: 'a key', generic: 'a key or token',
  name: 'your name', git: 'your git name', host: 'your machine', folder: 'seen in your data', file: 'seen in your data',
  field: 'seen in your data', value: 'seen in your data',
}

const keepable = (h: Hit) => !['token', 'key', 'generic'].includes(h.kind)

/** The repository a pull request goes to, from the plugin's manifest. */
async function upstream($: Engine): Promise<string> {
  try {
    const m = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)))
    return /github\.com[/:]([^/]+\/[^/.]+)/.exec(String(m.repository || ''))?.[1] || 'safety-research/thimble'
  } catch {
    return 'safety-research/thimble'
  }
}

export async function drawFixSubmit($: Engine, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const W = Math.max(40, Number(e.props?.bodyColumns) || 80)
  const s = await submitNow($)
  const id = s?.ids[s.at]
  if (id == null) return Text({ color: 'error', wrap: 'wrap', children: `× ${s?.problem || 'Nothing to submit.'} Press esc.` })
  const d: Draft | null = await draftNow($, id)
  if (!d) return Text({ dimColor: true, children: 'Reading the draft…' })
  const say = (said: string | null | void) => { if (said) $.ui.toast(said) }
  const out: Any[] = []
  const of = s!.ids.length > 1 ? ` (${s!.at + 1} of ${s!.ids.length})` : ''
  out.push(Text({ key: 'title', children: [Text({ key: 'a', bold: true, children: `Submit: ${d.title}` }), Text({ key: 'b', dimColor: true, children: of })] }))
  const hasPatch = !!d.patch.trim()
  out.push(Text({ key: 'to', children: [Text({ key: 'a', dimColor: true, children: 'to  ' }), Text({ key: 'b', children: `${await upstream($)} · ${hasPatch ? 'a draft pull request from your fork' : 'an issue (a request with no code)'}` })] }))
  out.push(Text({ key: 'as', children: [Text({ key: 'a', dimColor: true, children: 'as  ' }), Text({ key: 'b', children: 'your GitHub noreply address, through gh' })] }))
  if (s?.problem) out.push(Text({ key: 'prob', color: 'warning', wrap: 'wrap', children: s.problem }))
  if (d.done) {
    out.push(Text({ key: 'g0', children: ' ' }), Text({ key: 'done', color: 'success', wrap: 'wrap', children: `✓ ${d.done}` }))
  }
  // what the scan removed
  const hits = d.hits.filter((h, i, a) => a.findIndex(x => x.found === h.found) === i)
  out.push(Text({ key: 'g1', children: ' ' }), Text({ key: 'rm', children: [Text({ key: 'a', bold: true, children: 'Removed before sending' }), Text({ key: 'b', dimColor: true, children: ` · ${hits.filter(h => !h.kept).length}` })] }))
  const fw = Math.max(6, Math.min(28, Math.max(0, ...hits.map(h => textWidth(h.found)))))
  const rw = Math.max(6, Math.min(14, Math.max(0, ...hits.map(h => textWidth(h.replacement)))))
  for (const [i, h] of hits.entries()) {
    out.push(Box({ key: `hit${i}`, flexDirection: 'row', children: [
      Text({ key: 'f', ...(h.kept ? { dimColor: true } : { color: 'warning' }), children: `  ${cut(h.found, fw).padEnd(fw)}` }),
      Text({ key: 'r', dimColor: true, children: h.kept ? '  kept'.padEnd(rw + 4) : `  → ${cut(h.replacement, rw).padEnd(rw)}` }),
      Text({ key: 'w', dimColor: true, children: `  ${WHY[h.kind] || 'a detail'}` }),
      ...(!h.kept && keepable(h) && !d.done ? [Text({ key: 's', children: '  ' }), Button({ key: `keep-${h.id}`, plain: true, dimColor: true, label: 'keep', onPress: async () => say(await submitAction($, 'keep', h.id)) })] : []),
    ] }))
  }
  out.push(Text({ key: 'never', dimColor: true, children: hits.length ? '  Keys and tokens are always removed.' : '  Nothing found. Keys and tokens are always removed.' }))
  // the exact text
  out.push(Text({ key: 'g2', children: ' ' }), Text({ key: 'ex', bold: true, children: 'Exactly what is sent' }))
  const body = d.pr.replace(/\s+$/, '').split('\n')
  const inner: Any[] = body.map((line, i) => {
    const parts = line.split(/(‹[^›]{1,40}›)/)
    return Text({ key: `l${i}`, wrap: 'wrap', children: parts.map((p, j) => (/^‹.*›$/.test(p) ? Text({ key: `p${j}`, color: 'warning', children: p }) : Text({ key: `p${j}`, ...(i === 0 ? { bold: true } : {}), children: p || (j === 0 ? ' ' : '') }))) })
  })
  if (hasPatch) inner.push(Text({ key: 'pl', children: ' ' }), Text({ key: 'pf', dimColor: true, children: `and the diff: ${d.patch.split('\n').filter(l => l.startsWith('diff --git')).length} file(s) · ${(await viewNow($)).diff ? 'below' : 'd shows it'}` }))
  out.push(Box({ key: 'box', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width: W, children: inner }))
  if (hasPatch && (await viewNow($)).diff) out.push(...diffRows(els, d.patch, W))
  out.push(Text({ key: 'g3', children: ' ' }))
  if (!d.done) {
    const firstKeep = hits.find(h => !h.kept && keepable(h))
    out.push(keys(els, [
      ['y', 'send', async () => say(await submitAction($, 'pr'))],
      ['w', 'save as files instead', async () => say(await submitAction($, 'file'))],
      ...(firstKeep ? [['k', `keep “${cut(firstKeep.found, 16)}”`, async () => say(await submitAction($, 'keep', firstKeep.id))] as [string, string, () => unknown]] : []),
      ...(hasPatch ? [['d', 'diff', async () => setView($, { diff: !(await viewNow($)).diff })] as [string, string, () => unknown]] : []),
      ...(s!.ids.length > s!.at + 1 ? [['n', 'next fix', () => submitSkip($)] as [string, string, () => unknown]] : []),
    ]))
    out.push(Text({ key: 'only', dimColor: true, children: 'Only your key press sends. Claude cannot send it. esc cancels.' }))
  } else if (s!.ids.length > s!.at + 1) {
    out.push(keys(els, [['n', 'next fix', () => submitSkip($)]]))
  }
  return Box({ flexDirection: 'column', width: W, children: out })
}

/** s in the list, for tests and the command: the preview of these fixes. */
export async function openSubmit($: Engine, ids: number[]): Promise<void> {
  await submitFixes($, ids)
}
