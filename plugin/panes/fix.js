// fix.js: the preview of a fix's share, a program on the card runtime (draw/kit.js) in the side panel. It opens on a
// `fix_ask` line of the change feed (`thimble fix draft` wrote the share and waits for the person), or on p after a
// fix is in the person's thimble. It shows the exact text that would leave the machine, in three parts: the privacy
// scan's hits (each removed, with its placeholder), the issue as it will be sent, and the pull request's files (d reads
// the whole diff). Nothing is sent from here without y or w, which the host runs as the person's own command with the
// ask id (shell/fix.ts); the id never reaches the program or Claude.
//
//   args: {slug}
//   reads: fix:<slug> (shell/fix.ts fixStore: fix.json, share/scan.json, issue.md, pr.md, diff.patch)
//   state: {diff: true while d shows the whole diff, keeping: true while k picks a hit to keep}
//   keys: y send (the pull request as a draft) · w save as a file · e edit · d read the diff · k keep one · esc not now
//   asks of the host: send {slug, answer: send|file}, keep {slug, id}, edit {slug}

/** What each kind of hit is, in words. */
const KIND_WORDS = {
  path: 'path', email: 'email', token: 'token', key: 'key', name: 'name', host: 'host name', git: 'git name',
  folder: 'folder name', file: 'file name', field: 'field name', value: 'value', generic: 'detail',
}

/** A hit's kind in words. */
export const hitWords = kind => KIND_WORDS[kind] || 'detail'

/** Keys and tokens are never kept. */
export const keepable = hit => !!hit && hit.kind !== 'key' && hit.kind !== 'token'

/** The files a diff changes, each with its lines added and removed, in the diff's order. */
export function diffFiles(patch) {
  const out = []
  let cur = null
  for (const line of String(patch || '').split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line)
    if (m) { cur = { file: m[2], add: 0, del: 0 }; out.push(cur); continue }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) cur.add++
    else if (line.startsWith('-')) cur.del++
  }
  return out
}

const cut = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')

/** The hits the keep keys number: 1–9, keepable ones that are still removed. */
export const keepList = scan => (Array.isArray(scan) ? scan : []).filter(h => keepable(h) && !h.kept).slice(0, 9)

/** The keys the preview says in its last line, as words. */
export function keyLine(kind, diff = 'x') {
  return kind === 'report' || !diff
    ? 'y send · w save as a file · e edit · esc not now'
    : 'y send (the pull request as a draft) · w save as a file · e edit · esc not now'
}

export default {
  name: 'fix',
  title: 'Submit your fix',
  reads: args => [`fix:${String(args.slug || '')}`],
  stateKey: args => `fix-${String(args.slug || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64)}`,
  data(stores, args) {
    const s = stores[`fix:${String(args.slug || '')}`] || {}
    return {
      slug: String(args.slug || ''), title: String(s.title || ''), kind: String(s.kind || 'fix'), repo: String(s.repo || ''), login: String(s.login || ''),
      scan: Array.isArray(s.scan) ? s.scan : [], issue: String(s.issue || ''), diff: String(s.diff || ''), waiting: !!s.waiting, problem: s.problem ? String(s.problem) : '',
    }
  },
  titleOf: () => 'Submit your fix',
  // no side thread: what to change goes to main, in the prompt (e says so)
  thread: () => null,
  program,
}

export function program(k, data) {
  const st = k.state || {}
  const W = Math.max(30, k.w)
  if (data.problem) return k.text(`{bad:×} ${k.escape(data.problem)}`)
  if (!data.issue) return k.text('{dim:There is no draft to show yet. Claude writes it with `thimble fix draft`, and it opens here.}')
  // a copy with no change goes out as an issue alone: a request
  const report = data.kind === 'report' || !data.diff
  const send = answer => () => { k.do('send', { slug: data.slug, answer }); return null }
  const toKeep = keepList(data.scan)
  if (st.keeping) {
    // k: a number keeps that hit (it goes out as it is); esc goes back without keeping one
    toKeep.forEach((h, i) => k.on(String(i + 1), () => { k.do('keep', { slug: data.slug, id: h.id }); return { keeping: false } }, 'keep'))
    k.on('esc', () => ({ keeping: false }), 'back')
  } else {
    if (data.waiting) {
      k.on('y', send('send'), report ? 'send' : 'send (the pull request as a draft)')
      k.on('w', send('file'), 'save as a file')
    }
    k.on('e', () => { k.do('edit', { slug: data.slug }); return null }, 'edit')
    if (!report && data.diff) k.on('d', () => ({ diff: !st.diff }), st.diff ? 'the files' : 'read the diff')
    if (toKeep.length) k.on('k', () => ({ keeping: true }), 'keep one')
  }

  const out = []
  out.push(k.text(`**${report ? 'Submit your request' : 'Submit your fix'}**`, { wrap: false }))
  out.push(k.text(data.waiting ? '{dim:Nothing has been sent. This is the exact text.}' : '{dim:This text was sent or saved as a file.}'))

  // the privacy scan: each hit, already removed, with what took its place
  const hits = data.scan
  const kept = hits.filter(h => h.kept).length
  out.push(k.space(1, 1), k.text(`**Privacy scan** {dim:· ${hits.length ? `${hits.length} found · ${kept ? `${kept} kept, the rest removed` : 'all removed'}` : 'nothing found'}}`, { wrap: false }))
  const fw = Math.max(4, Math.min(32, Math.floor((W - 20) / 2), Math.max(0, ...hits.map(h => Array.from(String(h.found)).length))))
  hits.forEach(h => {
    const n = st.keeping ? toKeep.indexOf(h) : -1
    const mark = n >= 0 ? `{accent:${n + 1}}` : h.kept ? '{dim:✓}' : '{bad:×}'
    const found = k.escape(cut(h.found, fw).padEnd(fw))
    const tail = h.kept ? '{dim:kept}' : `{dim:→} {warn:${k.escape(h.replacement || '‹removed›')}}`
    out.push(k.text(`${mark} ${k.escape(hitWords(h.kind).padEnd(11))} ${found}  ${tail}`, { wrap: false }))
  })
  if (st.keeping) out.push(k.text(toKeep.length ? '  {dim:press a number to keep that one as it is · esc back}' : '  {dim:nothing here can be kept · esc back}'))
  else if (toKeep.length) out.push(k.text('  {accent:k} {dim:keep one · keys and tokens are never kept}'))
  else if (hits.length) out.push(k.text('  {dim:keys and tokens are never kept}'))

  // the issue, line by line as it will be sent (its first line is the title), placeholders in amber
  out.push(k.space(1, 1), k.text(`**Issue**${data.repo ? ` {dim:· ${k.escape(data.repo)}}` : ''}${data.login ? ` {dim:· as @${k.escape(data.login)}}` : ''}`, { wrap: false }))
  const marked = s => k.escape(s).replace(/‹[^›]{1,24}›/g, m => `{warn:${m}}`)
  String(data.issue).replace(/\s+$/, '').split('\n').forEach((line, i) => {
    const t = i === 0 ? line.replace(/^#\s*/, '') : line
    out.push(k.text(i === 0 ? `  **${marked(t)}**` : t.trim() ? `  ${marked(t)}` : ' '))
  })

  // the pull request's files, or (d) the whole diff
  if (!report && data.diff) {
    const files = diffFiles(data.diff)
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0)
    out.push(k.space(1, 1), k.text(`**Draft pull request** {dim:· ${files.length} file${files.length === 1 ? '' : 's'} · +${add} −${del}}   {accent:d} {dim:${st.diff ? 'the files' : 'read the diff'}}`, { wrap: false }))
    if (st.diff) {
      for (const line of data.diff.replace(/\s+$/, '').split('\n')) {
        const tone = line.startsWith('+') && !line.startsWith('+++') ? 'good' : line.startsWith('-') && !line.startsWith('---') ? 'bad' : 'dim'
        out.push(k.text(`{${tone === 'good' ? 'c2' : tone}:${k.escape(cut(line || ' ', W - 2))}}`, { wrap: false }))
      }
    } else {
      const nw = Math.min(48, Math.max(...files.map(f => Array.from(f.file).length), 8))
      for (const f of files) out.push(k.text(`  ${k.escape(cut(f.file, nw).padEnd(nw))}  {c2:+${f.add}}${f.del ? ` {bad:−${f.del}}` : ''}`, { wrap: false }))
    }
  }
  out.push(k.space(1, 1))
  if (!data.waiting) out.push(k.text('{dim:This draft was sent or saved already. Ask Claude for a new draft to share it again.}'))
  else out.push(k.text(`{accent:y} {dim:${report ? 'send' : 'send (the pull request as a draft)'}} {dim:·} {accent:w} {dim:save as a file ·} {accent:e} {dim:edit ·} {accent:esc} {dim:not now}`))
  return k.stack(out)
}
