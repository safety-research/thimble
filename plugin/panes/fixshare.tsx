// fixshare.tsx: the preview of a fix's share (core/pane.ts kind `fixshare`). It opens on a `fix_ask` line of the change
// feed (`thimble fix draft` wrote the share and waits for the person), or on p for a fix in use. It shows the exact text
// that would leave the machine, in three parts: the privacy scan's hits (each removed, with its placeholder; one that
// is not a key or a token can be kept as it is), the issue as it will be sent, and the pull request's files (d reads
// the whole diff). Nothing is sent without y or w, which run as the person's own command with the secret of that press
// (bar/fix.ts fixAction); neither this pane nor Claude ever holds it.
//
//   args: {slug}; state: paneView/fixshare {diff: true while d shows the whole diff}
import type { EngineInterface } from 'claude-code'

import { fixAction, fixStore } from '../bar/fix'
import { cut, textWidth } from '../core/text.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const VIEW = { plugin: 'thimble', key: 'paneView', id: 'fixshare' } as const

/** What each kind of hit is, in words. */
const KIND_WORDS: Record<string, string> = {
  path: 'path', email: 'email', token: 'token', key: 'key', name: 'name', host: 'host name', git: 'git name',
  folder: 'folder name', file: 'file name', field: 'field name', value: 'value', generic: 'detail',
}

/** Keys and tokens are never kept. */
const keepable = (h: Any) => !!h && h.kind !== 'key' && h.kind !== 'token'

const len = textWidth

/** The files a diff changes, each with its lines added and removed, in the diff's order. */
function diffFiles(patch: string): { file: string; add: number; del: number }[] {
  const out: { file: string; add: number; del: number }[] = []
  let cur: { file: string; add: number; del: number } | null = null
  for (const line of String(patch || '').split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line)
    if (m) { cur = { file: m[2]!, add: 0, del: 0 }; out.push(cur); continue }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) cur.add++
    else if (line.startsWith('-')) cur.del++
  }
  return out
}

export async function drawFixShare($: EngineInterface, e: Any, args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const W = Math.max(40, Number(e.props?.bodyColumns) || 80)
  const slug = String((args as Any)?.slug || '')
  const s = (await fixStore($, slug)) as Any
  if (s?.problem) return Text({ color: 'error', wrap: 'wrap', children: `× ${String(s.problem)}` })
  if (!s?.issue) return Text({ dimColor: true, wrap: 'wrap', children: 'No draft yet.' })
  const view = ((await $.state.get(VIEW)).value ?? {}) as { diff?: boolean }
  const report = s.kind === 'report' || !s.diff
  const act = (a: Record<string, unknown>) => async () => {
    const said = await fixAction($, { slug }, a)
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  const head = (k: string, words: string, more = '') => Text({ key: k, children: [Text({ key: `${k}-w`, bold: true, children: words }), ...(more ? [Text({ key: `${k}-m`, dimColor: true, children: ` · ${more}` })] : [])] })
  const gap = (k: string) => Text({ key: k, children: ' ' })
  const out: Any[] = [
    Text({ key: 'title', bold: true, children: report ? 'Submit your request' : 'Submit your fix' }),
    Text({ key: 'sub', dimColor: true, wrap: 'wrap', children: s.waiting ? 'Nothing has been sent. This is the exact text.' : 'This text was sent or saved as a file already. Ask Claude for a new draft to share it again.' }),
  ]

  // the privacy scan: each hit, already removed, with what took its place
  const hits = (s.scan || []) as Any[]
  const kept = hits.filter(h => h.kept).length
  out.push(gap('g1'), head('scan', 'Privacy scan', hits.length ? `${hits.length} found · ${kept ? `${kept} kept, the rest removed` : 'all removed'}` : 'nothing found'))
  const fw = Math.max(4, Math.min(32, Math.floor((W - 34) / 2), Math.max(0, ...hits.map(h => len(String(h.found))))))
  hits.forEach((h, i) => {
    const found = cut(String(h.found), fw).padEnd(fw)
    out.push(Box({ key: `hit${i}`, flexDirection: 'row', children: [
      Text({ key: 'm', ...(h.kept ? { dimColor: true } : { color: 'error' }), children: h.kept ? '✓ ' : '× ' }),
      Text({ key: 'k', dimColor: true, children: `${(KIND_WORDS[h.kind] || 'detail').padEnd(11)} ` }),
      Text({ key: 'f', children: `${found}  ` }),
      ...(h.kept ? [Text({ key: 'r', dimColor: true, children: 'kept' })] : [Text({ key: 'a', dimColor: true, children: '→ ' }), Text({ key: 'r', color: 'warning', children: String(h.replacement || '‹removed›') })]),
      ...(s.waiting && keepable(h) && !h.kept ? [Text({ key: 'g', children: '  ' }), Button({ key: `keep-${String(h.id)}`, plain: true, dimColor: true, label: 'keep it', onPress: act({ do: 'keep', id: h.id }) })] : []),
    ] }))
  })
  if (hits.length) out.push(Text({ key: 'never', dimColor: true, children: '  keys and tokens are never kept' }))

  // the issue, line by line as it will be sent (its first line is the title), placeholders in amber
  out.push(gap('g2'), head('issue', 'Issue', [s.repo, s.login ? `as @${s.login}` : ''].filter(Boolean).join(' · ')))
  String(s.issue).replace(/\s+$/, '').split('\n').forEach((line, i) => {
    const t = i === 0 ? line.replace(/^#\s*/, '') : line
    const parts = t.split(/(‹[^›]{1,40}›)/)
    out.push(Box({ key: `l${i}`, marginLeft: 2, children: [Text({ wrap: 'wrap', children: parts.map((p, j) => (/^‹.*›$/.test(p) ? Text({ key: `p${j}`, color: 'warning', children: p }) : Text({ key: `p${j}`, ...(i === 0 ? { bold: true } : {}), children: p || (j === 0 && !t ? ' ' : '') }))) })] }))
  })

  // the pull request's files, or (d) the whole diff
  if (!report) {
    const files = diffFiles(s.diff)
    const add = files.reduce((n, f) => n + f.add, 0)
    const del = files.reduce((n, f) => n + f.del, 0)
    out.push(gap('g3'), Box({ key: 'pr', flexDirection: 'row', children: [
      head('pr-h', 'Draft pull request', `${files.length} file${files.length === 1 ? '' : 's'} · +${add} −${del}`),
      Text({ key: 'gap', children: '   ' }),
      Button({ key: 'diff', plain: true, hotkey: 'd', label: view.diff ? 'the files' : 'read the diff', onPress: () => $.state.set(VIEW, { diff: !view.diff }) }),
    ] }))
    if (view.diff) {
      String(s.diff).replace(/\s+$/, '').split('\n').forEach((line, i) => {
        const tone = line.startsWith('+') && !line.startsWith('+++') ? { color: 'diffAdded' } : line.startsWith('-') && !line.startsWith('---') ? { color: 'diffRemoved' } : { dimColor: true }
        out.push(Text({ key: `d${i}`, ...tone, wrap: 'truncate-end', children: line || ' ' }))
      })
    } else {
      const nw = Math.min(48, Math.max(8, ...files.map(f => len(f.file))))
      files.forEach((f, i) => out.push(Text({ key: `f${i}`, children: [
        Text({ key: 'n', children: `  ${cut(f.file, nw).padEnd(nw)}  ` }), Text({ key: 'a', color: 'success', children: `+${f.add}` }), ...(f.del ? [Text({ key: 'd', color: 'error', children: ` −${f.del}` })] : []),
      ] })))
    }
  }

  // what the person can do: send, save as a file; esc leaves it for later
  out.push(gap('g4'))
  if (s.waiting) {
    out.push(Box({ key: 'acts', flexDirection: 'row', children: [
      Button({ key: 'send', plain: true, hotkey: 'y', autoFocus: true, label: report ? 'send' : 'send (the pull request as a draft)', onPress: act({ do: 'send', answer: 'send' }) }),
      Text({ key: 's1', dimColor: true, children: ' · ' }),
      Button({ key: 'file', plain: true, hotkey: 'w', label: 'save as a file', onPress: act({ do: 'send', answer: 'file' }) }),
      Text({ key: 's2', dimColor: true, children: ' · esc not now' }),
    ] }))
  }
  return Box({ flexDirection: 'column', width: W, children: out })
}
