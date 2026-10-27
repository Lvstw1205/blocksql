import type { Settings } from '@shared/types'
import { LANGS, t } from '@shared/i18n'
import { Modal } from './Modal'

interface Props {
  settings: Settings
  onChange(patch: Partial<Settings>): void
  onClose(): void
}

export function SettingsDialog({ settings, onChange, onClose }: Props): React.JSX.Element {
  return (
    <Modal title={t('settings')} onClose={onClose}>
      <div className="form">
        <label>
          {t('language')}
          <div className="segmented small">
            {LANGS.map((l) => (
              <button key={l.id} className={settings.lang === l.id ? 'on' : ''} onClick={() => onChange({ lang: l.id })}>
                {l.label}
              </button>
            ))}
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.autoRun} onChange={(e) => onChange({ autoRun: e.target.checked })} />
          {t('autoRun')}
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.safeMode} onChange={(e) => onChange({ safeMode: e.target.checked })} />
          {t('safeMode')}
        </label>
        <label>
          {t('maxRows')}
          <input
            type="number"
            min={100}
            step={1000}
            value={settings.maxRows}
            onChange={(e) => onChange({ maxRows: Math.max(100, Number(e.target.value) || 100) })}
          />
        </label>
      </div>
    </Modal>
  )
}
