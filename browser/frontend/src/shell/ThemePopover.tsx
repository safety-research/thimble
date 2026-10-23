// The theme popover under the top bar's palette button: the paper (Warm, Neutral, Dark) as a segmented choice in a
// track, then the seven accents as swatches; the chosen swatch is ringed in ink. Both are kept by lib/theme.
import { Segmented } from '../components/Button'
import { Popover } from '../components/Menu'
import { ACCENTS, PAPERS, useTheme } from '../lib/theme'

export function ThemePopover({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const { paper, accent, setPaper, setAccent } = useTheme()
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" label="Theme" className="theme-pop" width={232}>
      <div className="theme" data-panel="theme">
        <span className="theme-label">Paper</span>
        <Segmented label="Paper" track block value={paper} onChange={setPaper} options={PAPERS.map((p) => ({ value: p.id, label: p.label }))} />
        <span className="theme-label">Accent</span>
        <div className="theme-swatches" role="radiogroup" aria-label="Accent">
          {ACCENTS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={a.id === accent} aria-label={a.id} className={`theme-swatch${a.id === accent ? ' on' : ''}`} style={{ background: a.hex }} data-accent={a.id} onClick={() => setAccent(a.id)} />
          ))}
        </div>
      </div>
    </Popover>
  )
}
