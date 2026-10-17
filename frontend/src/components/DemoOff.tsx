// A control that changes the workspace, on a demo page (lib/demo): drawn off, and hovering it shows the demo's note,
// as the disabled composer does (bug hunt F5). The server refuses such a change too (backend demo_guard). Elsewhere the
// control is as it was. The note's hover is on a span around the control, since a disabled button gets no pointer.
import { cloneElement, type ReactElement } from 'react'
import { DEMO_NOTE, useDemo } from '../lib/demo'
import { useTooltip } from './Tooltip'

export function DemoOff({ children }: { children: ReactElement<{ disabled?: boolean }> }) {
  const demo = useDemo()
  const { props, tip } = useTooltip(demo ? DEMO_NOTE : null)
  if (!demo) return children
  return (
    <>
      <span className="demo-off" data-demo-off="" {...props}>
        {cloneElement(children, { disabled: true })}
      </span>
      {tip}
    </>
  )
}
