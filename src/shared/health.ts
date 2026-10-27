import type { Cell, ColumnInfo, Dialect, TableInfo } from './types'
import { quoteIdent, quoteTable } from './sql'
import { t as msg } from './i18n'

export type FindingLevel = 'bad' | 'warn' | 'info' | 'good'

export interface Finding {
  level: FindingLevel
  text: string
}

export interface ColumnHealth {
  name: string
  type: string
  nulls: number
  nullPct: number
  distinct?: number
  empty?: number
  min?: Cell
  max?: Cell
  findings: Finding[]
}

export interface HealthReport {
  table: string
  rows: number
  duplicateRows: number
  score: number
  findings: Finding[]
  columns: ColumnHealth[]
}

const MAX_COLUMNS = 40
const TEXTY = /char|text|clob|string|^$/i
const ORDERABLE = /int|numeric|decimal|real|double|float|date|time|char|text|serial|money|^$/i
const NOT_COMPARABLE = /^json$|xml|point|polygon|line|box|circle|path|blob|bytea|binary/i

const profiled = (t: TableInfo): ColumnInfo[] => t.columns.slice(0, MAX_COLUMNS)

/** One query that profiles every column of a table. */
export function profileSql(t: TableInfo, dialect: Dialect): string {
  const parts = ['COUNT(*) AS n']
  profiled(t).forEach((c, i) => {
    const col = quoteIdent(c.name, dialect)
    parts.push(`COUNT(${col}) AS c${i}_nn`)
    if (!NOT_COMPARABLE.test(c.type)) parts.push(`COUNT(DISTINCT ${col}) AS c${i}_d`)
    if (ORDERABLE.test(c.type) && !NOT_COMPARABLE.test(c.type)) parts.push(`MIN(${col}) AS c${i}_min`, `MAX(${col}) AS c${i}_max`)
    if (TEXTY.test(c.type)) parts.push(`SUM(CASE WHEN TRIM(${col}) = '' THEN 1 ELSE 0 END) AS c${i}_e`)
  })
  return `SELECT ${parts.join(', ')} FROM ${quoteTable(t.name, dialect)}`
}

/** Extra copies of rows that are identical on every non-key column. */
export function duplicateSql(t: TableInfo, dialect: Dialect): string | null {
  const cols = t.columns.filter((c) => !c.pk && !NOT_COMPARABLE.test(c.type))
  if (!cols.length) return null
  const list = cols.map((c) => quoteIdent(c.name, dialect)).join(', ')
  return `SELECT COALESCE(SUM(k - 1), 0) AS extra FROM (SELECT COUNT(*) AS k FROM ${quoteTable(t.name, dialect)} GROUP BY ${list} HAVING COUNT(*) > 1) d`
}

const num = (v: Cell | undefined): number => (v === null || v === undefined ? 0 : Number(v))
const pct = (x: number): string => `${x < 10 ? x.toFixed(1) : Math.round(x)}%`

export function buildReport(t: TableInfo, columns: string[], row: Cell[], duplicateRows: number): HealthReport {
  const get = (key: string): Cell | undefined => {
    const i = columns.indexOf(key)
    return i < 0 ? undefined : row[i]
  }
  const rows = num(get('n'))
  const findings: Finding[] = []
  let score = 100

  const cols: ColumnHealth[] = profiled(t).map((c, i) => {
    const nn = num(get(`c${i}_nn`))
    const nulls = rows - nn
    const nullPct = rows ? (nulls / rows) * 100 : 0
    const d = get(`c${i}_d`)
    const e = get(`c${i}_e`)
    const h: ColumnHealth = {
      name: c.name,
      type: c.type,
      nulls,
      nullPct,
      distinct: d === undefined ? undefined : num(d),
      empty: e === undefined ? undefined : num(e),
      min: get(`c${i}_min`),
      max: get(`c${i}_max`),
      findings: []
    }
    if (!rows) return h
    if (nn === 0) {
      h.findings.push({ level: 'bad', text: msg('hAllEmpty') })
      score -= 8
    } else if (nullPct >= 50) {
      h.findings.push({ level: 'warn', text: msg('hEmptyPct', { pct: pct(nullPct) }) })
      score -= 4
    } else if (nulls > 0) {
      h.findings.push({ level: 'info', text: msg('hEmptyPct', { pct: pct(nullPct) }) })
      score -= 1
    }
    if (h.empty) {
      h.findings.push({ level: 'warn', text: msg('hBlank', { n: h.empty }) })
      score -= 3
    }
    if (h.distinct !== undefined && nn > 1) {
      if (h.distinct === 1) h.findings.push({ level: 'info', text: msg('hSingle') })
      else if (h.distinct === rows && !c.pk) h.findings.push({ level: 'good', text: msg('hUnique') })
    }
    return h
  })

  if (!rows) findings.push({ level: 'info', text: msg('hEmptyTable') })
  if (duplicateRows > 0) {
    findings.push({ level: 'bad', text: msg('hDuplicates', { n: duplicateRows }) })
    score -= 15
  }
  if (t.columns.length > MAX_COLUMNS) findings.push({ level: 'info', text: msg('hFirstCols', { n: MAX_COLUMNS }) })
  if (rows && !t.columns.some((c) => c.pk) && !cols.some((c) => c.findings.some((f) => f.level === 'good'))) {
    findings.push({ level: 'warn', text: msg('hNoKey') })
    score -= 5
  }

  return { table: t.name, rows, duplicateRows, score: Math.max(0, Math.min(100, score)), findings, columns: cols }
}
