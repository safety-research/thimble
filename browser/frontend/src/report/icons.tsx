// The report's own glyphs on the same 24-unit grid as components/Icon, and IconButton, an icon-only button named in
// its tooltip.
import type { ButtonHTMLAttributes, SVGProps } from 'react'
import { TipButton } from '../components/Tooltip'

const PATHS = {
  report: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  slides: 'M3 4h18v12H3zM12 16v4M8 20h8',
  story: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7M8 11h5',
  page: 'M4 4h16v16H4zM4 9h16M9 9v11',
  bars: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  text: 'M4 6h16M4 12h16M4 18h10',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  check: 'M5 12l5 5L20 7',
} as const

export type ReportGlyph = keyof typeof PATHS

export function Glyph({ name, size = 14, filled = false, ...rest }: { name: ReportGlyph; size?: number; filled?: boolean } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  )
}

/** A section's chevron, on a 16-unit grid; it turns a quarter when the section is open. */
export function Chevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg className={`wu-chev${open ? ' wu-chev-open' : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

/** The report's icon-only button (wu-iconbtn): `label` names it in the tooltip and to screen readers. */
export function IconButton({ label, className, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'type'> & { label: string }) {
  return <TipButton tip={label} className={`wu-iconbtn${className ? ` ${className}` : ''}`} {...rest} />
}
