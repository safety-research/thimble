// main.tsx: thimble's browser on lean's runtime. The page server serves it at /<token>/app/; what it shows comes from
// the session's records (thimble/messages, thimble/objects, thimble/threads) and the corpus through the kernel.
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Shell } from './Shell'
import { start } from './lib/store'

document.documentElement.dataset.accent = 'iris'
createRoot(document.getElementById('root')!).render(<Shell />)
void start()
