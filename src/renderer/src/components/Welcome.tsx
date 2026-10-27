import { Coffee, Database, FileSpreadsheet, Upload } from 'lucide-react'
import type { ConnectionConfig } from '@shared/types'
import { t } from '@shared/i18n'

interface Props {
  connections: ConnectionConfig[]
  onImport(): void
  onSample(): void
  onConnect(): void
  onOpen(id: string): void
  busy: boolean
}

export function Welcome({ connections, onImport, onSample, onConnect, onOpen, busy }: Props): React.JSX.Element {
  return (
    <div className="welcome">
      <button className="dropzone" onClick={onImport} disabled={busy}>
        <Upload size={36} strokeWidth={1.5} />
        <b>{t('dropTitle')}</b>
        <span>{t('dropSub')}</span>
      </button>
      <div className="welcome-actions">
        <button onClick={onSample} disabled={busy}>
          <Coffee size={16} /> {t('startSample')}
        </button>
        <button onClick={onConnect} disabled={busy}>
          <Database size={16} /> {t('connectDb')}
        </button>
      </div>
      {connections.length > 0 && (
        <div className="recent">
          {connections.map((c) => (
            <button key={c.id} onClick={() => onOpen(c.id)} disabled={busy}>
              {c.kind === 'sqlite' ? <FileSpreadsheet size={15} /> : <Database size={15} />}
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
