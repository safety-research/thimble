// What a surface shows in place of a feature that Settings turned off (features.ts): one line that names the feature and
// says where to turn it on again, with the gear's button.
import { Button } from '../components/Button'
import { bus } from '../lib/bus'

export function FeatureOff({ title }: { title: string }) {
  return (
    <div className="feature-off" role="note">
      <span>{title} is turned off.</span>
      <Button variant="ghost" size="sm" onClick={() => bus.emit('openSettings', {})}>
        Open Settings
      </Button>
    </div>
  )
}
