// fixshare.tsx: the preview of a fix's share (core/pane.ts kind `fixshare`): the exact text that would be sent, how
// many details the scan removed, and the presses that send it or save it as a file (bar/fix.ts fixStore, fixAction).
// The person's press alone sends: fixAction gives the kernel the secret of this press, which Claude never sees.
//
// The bar lane draws it in full here (the scan's hits, keeping one, the keys y w k). Until then it is this plain form.
import type { EngineInterface } from 'claude-code'

import { fixAction, fixStore } from '../bar/fix'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function drawFixShare($: EngineInterface, _e: Any, args: unknown, els: Any): Promise<unknown> {
  const { Box, Text, Button } = els
  const slug = String((args as Any)?.slug || '')
  const s = (await fixStore($, slug)) as Any
  if (s?.problem) return Text({ color: 'error', wrap: 'wrap', children: String(s.problem) })
  if (!s?.title) return Text({ dimColor: true, children: 'Reading the draft…' })
  const press = (answer: 'send' | 'file') => async () => {
    const said = await fixAction($, { slug }, { do: 'send', answer })
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  return Box({
    flexDirection: 'column',
    children: [
      Text({ key: 'title', bold: true, children: `${s.kind === 'report' ? 'Report' : 'Fix'}: ${s.title}` }),
      Text({ key: 'scan', dimColor: true, children: `${(s.scan || []).length} detail${(s.scan || []).length === 1 ? '' : 's'} removed by the scan` }),
      Text({ key: 'issue', wrap: 'wrap', children: String(s.issue || '') }),
      ...(s.waiting ? [Box({ key: 'acts', children: [
        Button({ key: 'send', label: 'Send under your GitHub login', onPress: press('send') }),
        Button({ key: 'file', label: 'Save as a file', onPress: press('file') }),
      ] })] : [Text({ key: 'done', dimColor: true, children: 'This draft no longer waits for you.' })]),
    ],
  })
}
