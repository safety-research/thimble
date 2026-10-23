// The line under the top bar on a demo page (lib/demo), the first thing the page says: it holds example data, not the
// analyst's files, and how to open a folder of their own. The start page says the same over its demo datasets
// (StartPage). It goes once a session attaches, when the page is the analyst's workspace.
import { Fragment } from 'react'
import { DEMO_LINE, useDemo } from '../lib/demo'

/** A line's words, a span in backticks drawn as code. Pure but for the elements. */
export function DemoWords({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  )
}

export function DemoLine() {
  const demo = useDemo()
  if (!demo) return null
  return (
    <p className="shell-demo-line" data-demo-line="">
      <DemoWords text={DEMO_LINE} />
    </p>
  )
}
