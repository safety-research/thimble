// react-markdown's `img` at every call site that draws a model's or a corpus's markdown: an image is drawn when it is a
// data: URL or one of the app's own files, and any other is drawn as its alt text, so markdown can never make the browser
// load from another host (lib/sanitize has why; the built UI's policy blocks it too, and this also holds under Vite).
import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { isLocalUrl } from '../lib/sanitize'

export function MdImage({ node: _node, src, alt, ...rest }: ComponentProps<'img'> & ExtraProps) {
  if (typeof src === 'string' && isLocalUrl(src)) return <img src={src} alt={alt ?? ''} {...rest} />
  return <span className="md-img-alt">{alt ?? ''}</span>
}
