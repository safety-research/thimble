// notices_of.mjs: what main reads after the check of its citations or a repair of one, and the request a repair's fork
// reads, for the server's check of a reply (marks.py): built as the terminal plugin builds them
// (plugin/marks/notices.mjs) from the same text (plugin/prompts/notices.md, the registry's `notices`), with the
// workbench's words in its slots (plugin/prompts/node.mjs textOf).
//
//   stdin   {"kind": "tell", "items": [...]}                 after a reply's check (notices.mjs tellText)
//           {"kind": "repair", "items": [...], "auto": bool} after a repair (repairTellText)
//           {"kind": "request", "mark": {...}, "n": N, "auto": bool, "also": [...], "ran": ["card:<id>", ...]}
//                                                            a repair's request (repairRequest)
//           {"kind": "opened", "n": N}                       what follows the checker's text for the check of a
//                                                            citation c made of words the analyst selected (openedNote)
//   stdout  {"text": "…", "frame": "…"}: the text ('' for nothing to tell), and the frame that heads thimble's reports
import { openedNote, partsOf, repairRequest, repairTellText, tellText } from '../../../plugin/marks/notices.mjs'
import { textOf } from '../../../plugin/prompts/node.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', async () => {
  const a = JSON.parse(input || '{}')
  const p = partsOf(await textOf('notices', 'browser'))
  const text = a.kind === 'tell' ? tellText(p, a.items ?? [])
    : a.kind === 'repair' ? repairTellText(p, a.items ?? [], !!a.auto)
      : a.kind === 'request' ? repairRequest(p, a.mark ?? {}, a.n ?? 1, !!a.auto, a.also ?? [], a.ran ?? [])
        : a.kind === 'opened' ? openedNote(p, a.n ?? 1)
          : ''
  process.stdout.write(JSON.stringify({ text, frame: p.frame }))
})
