// notices_of.mjs: what main reads after the check of its citations or a repair of one, and the request a repair's fork
// reads, for the server's check of a reply (marks.py): built as the terminal plugin builds them
// (plugin/marks/notices.mjs) from the same text (plugin/prompts/notices.md, the registry's `notices`), with the
// workbench's words in its slots (plugin/prompts/node.mjs textOf).
//
//   stdin   {"kind": "tell", "items": [...]}                 after a reply's check (notices.mjs tellText)
//           {"kind": "repair", "items": [...], "auto": bool} after a repair (repairTellText)
//           {"kind": "request", "mark": {...}, "n": N, "auto": bool}   a repair's request (repairRequest)
//   stdout  {"text": "…", "frame": "…"}: the text ('' for nothing to tell), and the frame that heads thimble's reports
import { partsOf, repairRequest, repairTellText, tellText } from '../../../plugin/marks/notices.mjs'
import { textOf } from '../../../plugin/prompts/node.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', async () => {
  const a = JSON.parse(input || '{}')
  const p = partsOf(await textOf('notices', 'browser'))
  const text = a.kind === 'tell' ? tellText(p, a.items ?? [])
    : a.kind === 'repair' ? repairTellText(p, a.items ?? [], !!a.auto)
      : a.kind === 'request' ? repairRequest(p, a.mark ?? {}, a.n ?? 1, !!a.auto)
        : ''
  process.stdout.write(JSON.stringify({ text, frame: p.frame }))
})
