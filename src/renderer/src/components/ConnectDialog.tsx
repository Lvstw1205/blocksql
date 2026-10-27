import { useState } from 'react'
import { Database, FileBox } from 'lucide-react'
import type { ConnectionConfig, Dialect } from '@shared/types'
import { friendlyError } from '@shared/doctor/errors'
import { t } from '@shared/i18n'
import { Modal } from './Modal'

interface Props {
  initial?: ConnectionConfig
  onSaved(c: ConnectionConfig): void
  onClose(): void
}

const PORTS: Record<Dialect, number | undefined> = { sqlite: undefined, postgres: 5432, mysql: 3306 }

export function ConnectDialog({ initial, onSaved, onClose }: Props): React.JSX.Element {
  const [c, setC] = useState<ConnectionConfig>(
    initial ?? { id: '', name: '', kind: 'postgres', host: 'localhost', port: 5432, user: '', database: '' }
  )
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ConnectionConfig>): void => {
    setC((prev) => ({ ...prev, ...patch }))
    setStatus(null)
  }

  const pickFile = async (create: boolean): Promise<void> => {
    const file = await window.api.files.pickSqlite(create)
    if (file) set({ file, name: c.name || file.split(/[\\/]/).pop()!.replace(/\.\w+$/, '') })
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.connections.test(c)
    setBusy(false)
    setStatus(r.ok ? { ok: true, text: t('connected') } : { ok: false, text: friendlyError(r.error.message).title })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const name = c.name.trim() || (c.kind === 'sqlite' ? 'SQLite' : `${c.database || c.host}`)
    const r = await window.api.connections.save({ ...c, name })
    setBusy(false)
    if (r.ok) onSaved(r.value)
    else setStatus({ ok: false, text: r.error.message })
  }

  const valid = c.kind === 'sqlite' ? !!c.file : !!c.host

  return (
    <Modal
      title={initial ? t('editConnection') : t('connectDatabase')}
      onClose={onClose}
      footer={
        <>
          {status && <span className={`status ${status.ok ? 'ok' : 'bad'}`}>{status.text}</span>}
          <span className="grow" />
          {c.kind !== 'sqlite' && (
            <button onClick={test} disabled={!valid || busy}>
              {t('test')}
            </button>
          )}
          <button className="primary" onClick={save} disabled={!valid || busy}>
            {t('saveAndOpen')}
          </button>
        </>
      }
    >
      <div className="segmented">
        {(['sqlite', 'postgres', 'mysql'] as Dialect[]).map((k) => (
          <button key={k} className={c.kind === k ? 'on' : ''} onClick={() => set({ kind: k, port: PORTS[k] })}>
            {k === 'sqlite' ? <FileBox size={14} /> : <Database size={14} />}
            {{ sqlite: t('sqliteFile'), postgres: 'PostgreSQL', mysql: 'MySQL' }[k]}
          </button>
        ))}
      </div>
      <div className="form">
        <label>
          {t('name')}
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('myDatabase')} />
        </label>
        {c.kind === 'sqlite' ? (
          <label>
            {t('file')}
            <div className="row">
              <input value={c.file ?? ''} readOnly placeholder={t('pickAFile')} />
              <button onClick={() => pickFile(false)}>{t('open')}</button>
              <button onClick={() => pickFile(true)}>{t('createNew')}</button>
            </div>
          </label>
        ) : (
          <>
            <div className="row">
              <label className="grow">
                {t('host')}
                <input value={c.host ?? ''} onChange={(e) => set({ host: e.target.value })} />
              </label>
              <label style={{ width: 96 }}>
                {t('port')}
                <input type="number" value={c.port ?? ''} onChange={(e) => set({ port: Number(e.target.value) || undefined })} />
              </label>
            </div>
            <label>
              {t('database')}
              <input value={c.database ?? ''} onChange={(e) => set({ database: e.target.value })} />
            </label>
            <div className="row">
              <label className="grow">
                {t('user')}
                <input value={c.user ?? ''} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
              </label>
              <label className="grow">
                {t('password')}
                <input
                  type="password"
                  value={c.password ?? ''}
                  onChange={(e) => set({ password: e.target.value })}
                  placeholder={c.hasPassword ? t('passwordSaved') : ''}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={!!c.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> SSL
            </label>
          </>
        )}
      </div>
    </Modal>
  )
}
