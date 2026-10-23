// The markdown parser for a view's page: vite build writes this module as one script, dist/kit/markdown.js
// (vite.config.ts kitScript), which backend views.frame_document puts in every view page for the view kit's
// thimble.text (backend/app/viewer_text.js). It is micromark with GitHub's extensions (tables, task lists,
// strikethrough, autolinks, footnotes), the parser under the app's react-markdown and remark-gfm, with their settings:
// raw HTML is escaped, never parsed, and a single ~ is no strikethrough, since page and file names hold it
// (chat/markdown.tsx). A link keeps its address as written, whatever its scheme, so thimble.text can tell a corpus path
// or a view's ref from a URL: thimble.text takes every address off the links it draws and follows none of them.
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

/** What viewer_text.js finds as window.__thimbleMarkdown. */
export interface KitMarkdown {
  /** the markdown `text` as HTML */
  render: (text: string) => string
}

declare global {
  interface Window {
    __thimbleMarkdown?: KitMarkdown
  }
}

const extensions = [gfm({ singleTilde: false })]
const htmlExtensions = [gfmHtml()]

export function render(text: string): string {
  return micromark(text, { extensions, htmlExtensions, allowDangerousProtocol: true })
}

window.__thimbleMarkdown = { render }
