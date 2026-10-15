// The Demo tag beside the workspace's folder in the top bar, on a demo page only (lib/demo): example data and a finished
// analysis, with no Claude Code session behind the page. Its tooltip says so; nothing else on the page explains it.
import { Chip } from '../components/Chip'
import { useTooltip } from '../components/Tooltip'
import { DEMO_TAG, DEMO_TIP, useDemo } from '../lib/demo'

export function DemoTag() {
  const demo = useDemo()
  const { props, tip } = useTooltip(demo ? DEMO_TIP : null)
  if (!demo) return null
  return (
    <>
      <Chip kind="status" tone="accent" face="sans" className="shell-demo" tabIndex={0} aria-label={`${DEMO_TAG}: ${DEMO_TIP}`} data-demo="" {...props}>
        {DEMO_TAG}
      </Chip>
      {tip}
    </>
  )
}
