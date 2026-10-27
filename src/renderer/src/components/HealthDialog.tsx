import { useEffect, useState } from 'react'
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Cell, Dialect, TableInfo } from '@shared/types'
import { buildReport, duplicateSql, profileSql, type FindingLevel, type HealthReport } from '@shared/health'
import { formatCell } from '../lib/format'
import { Modal } from './Modal'

interface Props {
  table: TableInfo
  dialect: Dialect
  onClose(): void
}

const shown = (v: Cell | undefined): string => (v === '' ? t('blankText') : formatCell(v ?? null))

const ICON: Record<FindingLevel, typeof Info> = { bad: AlertCircle, warn: AlertTriangle, info: Info, good: CheckCircle2 }

export function HealthDialog({ table, dialect, onClose }: Props): React.JSX.Element {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const prof = await window.api.db.query(profileSql(table, dialect))
      if (!prof.ok) return alive && setError(prof.error.message)
      const dupSql = duplicateSql(table, dialect)
      const dup = dupSql ? await window.api.db.query(dupSql) : null
      const dups = dup?.ok ? Number(dup.value.rows[0]?.[0] ?? 0) : 0
      if (alive) setReport(buildReport(table, prof.value.columns, prof.value.rows[0], dups))
    })()
    return () => {
      alive = false
    }
  }, [table, dialect])

  const grade = (s: number): string => (s >= 90 ? 'good' : s >= 70 ? 'warn' : 'bad')

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <>
          <Activity size={18} /> {t('healthTitle', { table: table.name })}
        </>
      }
    >
      {error && <div className="issue error">{error}</div>}
      {!report && !error && <div className="muted pad">{t('checking')}</div>}
      {report && (
        <div className="health">
          <div className="health-top">
            <div className={`score ${grade(report.score)}`}>
              <b>{report.rows ? report.score : '–'}</b>
              <span>{t('points')}</span>
            </div>
            <div className="grow">
              <div className="muted">{t('rowsCols', { rows: report.rows, cols: table.columns.length })}</div>
              {report.findings.map((f, i) => {
                const Icon = ICON[f.level]
                return (
                  <div key={i} className={`finding ${f.level}`}>
                    <Icon size={14} /> {f.text}
                  </div>
                )
              })}
              {!report.findings.length && report.rows > 0 && (
                <div className="finding good">
                  <CheckCircle2 size={14} /> {t('allClean')}
                </div>
              )}
            </div>
          </div>
          <table className="health-table">
            <thead>
              <tr>
                <th>{t('colColumn')}</th>
                <th>{t('colType')}</th>
                <th>{t('colNulls')}</th>
                <th>{t('colDistinct')}</th>
                <th>{t('colRange')}</th>
                <th>{t('colFindings')}</th>
              </tr>
            </thead>
            <tbody>
              {report.columns.map((c) => (
                <tr key={c.name}>
                  <td>
                    <b>{c.name}</b>
                  </td>
                  <td className="muted">{c.type || '–'}</td>
                  <td>
                    <div className="bar">
                      <i style={{ width: `${c.nullPct}%` }} />
                    </div>
                    <span className="muted small">{c.nulls.toLocaleString()}</span>
                  </td>
                  <td>{c.distinct?.toLocaleString() ?? '–'}</td>
                  <td className="range">
                    {c.min !== undefined && c.min !== null ? `${shown(c.min)} ~ ${shown(c.max)}` : '–'}
                  </td>
                  <td>
                    {c.findings.map((f, i) => (
                      <span key={i} className={`pill ${f.level}`}>
                        {f.text}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
