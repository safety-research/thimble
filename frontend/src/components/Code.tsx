// Code drawn one way wherever it shows, with the file reader's syntax colours (files/highlight.ts; highlight.js loads
// lazily). CodeText colours text inside a caller's <pre> or <code>; MarkdownCode is react-markdown's `code`; CodeArea
// is the TextArea for code, coloured as it is typed.
import { Fragment, useMemo, useRef, type JSX, type UIEvent } from 'react'
import type { ExtraProps } from 'react-markdown'
import { highlightLines, renderTokens, useHljs } from '../files/highlight'
import { TextArea, textAreaClass, type TextAreaProps } from './Field'

/** `text` in the colours of `lang` (a highlight.js language or alias: python, py, bash, sh, json, sql, xml); plain until
 * the highlighter has loaded, with no language, and for a language it does not have. */
export function CodeText({ text, lang }: { text: string; lang?: string | null }) {
  const hl = useHljs(!!lang)
  const lines = useMemo(() => (hl && lang ? highlightLines(hl, text, lang) : null), [hl, text, lang])
  if (!lines) return <>{text}</>
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          {renderTokens(l)}
        </Fragment>
      ))}
    </>
  )
}

/** The language a fenced block names (```py), from react-markdown's `language-<name>` class; null when it names none. */
export function fenceLanguage(className?: string): string | null {
  return /(?:^|\s)language-([\w+#-]+)/.exec(className ?? '')?.[1] ?? null
}

/** react-markdown's `code`: a fenced block that names its language in its colours; inline code, a block that names
 * none and anything that is not plain text as it came. */
export function MarkdownCode({ node: _node, className, children, ...rest }: JSX.IntrinsicElements['code'] & ExtraProps) {
  const lang = fenceLanguage(className)
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null
  return (
    <code className={className} {...rest}>
      {lang && text != null ? <CodeText text={text.replace(/\n$/, '')} lang={lang} /> : children}
    </code>
  )
}

/**
 * The TextArea for code, coloured as it is typed. A textarea draws its text in one colour, so the colours are a copy of
 * the text in a <pre> under the field with the same classes, scrolling with it; the field keeps the caret and
 * selection, with its own text transparent (styles/code.css).
 */
export function CodeArea({ lang, onScroll, ...props }: TextAreaProps & { lang?: string | null }) {
  const under = useRef<HTMLPreElement>(null)
  const scroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const u = under.current
    if (u) {
      u.scrollTop = e.currentTarget.scrollTop
      u.scrollLeft = e.currentTarget.scrollLeft
    }
    onScroll?.(e)
  }
  return (
    <div className="code-area">
      {/* the extra line break keeps a last empty line the field shows (after a trailing newline) in the copy too */}
      <pre ref={under} className={`${textAreaClass(props)} code-area-under`} aria-hidden="true">
        <CodeText text={`${props.value}\n`} lang={lang} />
      </pre>
      <TextArea {...props} className={`${props.className ?? ''} code-area-field`.trim()} onScroll={scroll} />
    </div>
  )
}
