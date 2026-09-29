// react-markdown's `img` at every call site that draws a model's or a corpus's markdown: an image is drawn when it is a
// data: or blob: URL or one of the media routes (lib/sanitize isLocalUrl), and any other is drawn as its alt text, so
// markdown can never make the browser load from another host or call another of the app's routes (lib/sanitize has why;
// the built UI's policy blocks other hosts too, and this also holds under Vite).
import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { isLocalUrl } from '../lib/sanitize'

export function MdImage({ node: _node, src, alt, ...rest }: ComponentProps<'img'> & ExtraProps) {
  if (typeof src === 'string' && isLocalUrl(src)) return <img src={src} alt={alt ?? ''} {...rest} />
  return <span className="md-img-alt">{alt ?? ''}</span>
}
