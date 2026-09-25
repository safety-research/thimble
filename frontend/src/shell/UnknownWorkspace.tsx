// The page for a tab whose URL names a workspace this server does not hold, with links to the folders it does hold.
import { urlForWorkspace } from '../lib/workspace'
export function UnknownWorkspace({ ws, held }: { ws: string; held: readonly string[] }) {
  return (
    <div className="app-error">
      <p>This tab is for the folder “{ws}”, which this thimble server does not have open.</p>
      {held.length > 0 ? (
        <p>
          Open {held.length === 1 ? 'the folder it has open' : 'one of the folders it has open'}:{' '}
          {held.map((name, i) => (
            <span key={name}>
              {i > 0 && ', '}
              <a href={urlForWorkspace(name)}>{name}</a>
            </span>
          ))}
          , or run /thimble in a Claude Code session in the folder you want.
        </p>
      ) : (
        <p>Run /thimble in a Claude Code session in the folder you want; it prints the address to open.</p>
      )}
    </div>
  )
}
