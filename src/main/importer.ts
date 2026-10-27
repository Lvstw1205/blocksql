import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import ExcelJS from 'exceljs'
import Papa from 'papaparse'
import type { Dialect } from '@shared/types'
import { quoteIdent, sqlValue } from '@shared/sql'
import type { Driver } from './db'

type Raw = string | number | boolean | Date | null
export interface Sheet {
  name: string
  headers: string[]
  rows: Raw[][]
}

export const IMPORT_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'json']

/** Decode bytes as UTF-8, falling back to CP949 (what Korean Excel saves CSV as). */
function decode(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('euc-kr').decode(buf)
  }
}

const baseName = (file: string): string => basename(file, extname(file))

export async function readSheets(file: string): Promise<Sheet[]> {
  const ext = extname(file).slice(1).toLowerCase()
  if (ext === 'xlsx') return readExcel(file)
  if (ext === 'json') return [readJsonFile(file)]
  const text = decode(readFileSync(file))
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimiter: ext === 'tsv' ? '\t' : '' })
  const [headers = [], ...rows] = parsed.data
  return [{ name: baseName(file), headers, rows }]
}

function readJsonFile(file: string): Sheet {
  const data = JSON.parse(decode(readFileSync(file)))
  const list: Record<string, unknown>[] = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) ?? [data]
  const headers = [...new Set(list.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))]
  const cell = (v: unknown): Raw => (v === undefined ? null : v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as Raw))
  return { name: baseName(file), headers, rows: list.map((o) => headers.map((h) => cell(o?.[h]))) }
}

async function readExcel(file: string): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const sheets: Sheet[] = []
  wb.eachSheet((ws) => {
    const grid: Raw[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: Raw[] = []
      for (let c = 1; c <= ws.columnCount; c++) values.push(excelValue(row.getCell(c).value))
      grid.push(values)
    })
    if (!grid.length) return
    const [headers, ...rows] = grid
    sheets.push({
      name: wb.worksheets.length > 1 ? `${baseName(file)}_${ws.name}` : baseName(file),
      headers: headers.map((h) => (h === null ? '' : String(h))),
      rows
    })
  })
  return sheets
}

function excelValue(v: ExcelJS.CellValue): Raw {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v !== 'object') return v
  if ('result' in v) return excelValue(v.result as ExcelJS.CellValue)
  if ('richText' in v) return v.richText.map((r) => r.text).join('')
  if ('text' in v) return String(v.text)
  if ('error' in v) return null
  return String(v)
}

// ── type inference ──────────────────────────────────────────
type ColType = 'INTEGER' | 'REAL' | 'TEXT'
const INT = /^-?(0|[1-9]\d{0,14})$/
const REAL = /^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/
const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/

const pad = (n: number): string => String(n).padStart(2, '0')
const dateText = (d: Date): string => {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const t = d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds()
  return t ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : day
}

const asText = (v: Raw): string | null => {
  if (v === null) return null
  if (v instanceof Date) return dateText(v)
  const s = String(v).trim()
  return s === '' ? null : s
}

function inferType(values: Raw[]): ColType {
  let type: ColType = 'INTEGER'
  let seen = false
  for (const v of values) {
    if (v === null || v === '') continue
    if (v instanceof Date || typeof v === 'boolean') return 'TEXT'
    seen = true
    const t = typeof v === 'number' ? String(v) : v.trim()
    const s = GROUPED.test(t) ? t.replace(/,/g, '') : t
    if (s === '') continue
    if (type === 'INTEGER' && INT.test(s)) continue
    if (REAL.test(s) && !/^-?0\d/.test(s)) type = 'REAL'
    else return 'TEXT'
  }
  return seen ? type : 'TEXT'
}

function convert(v: Raw, type: ColType): string | number | null {
  const s = asText(v)
  if (s === null) return null
  if (type === 'TEXT') return s
  return Number(GROUPED.test(s) ? s.replace(/,/g, '') : s)
}

const SQL_TYPE: Record<Dialect, Record<ColType, string>> = {
  sqlite: { INTEGER: 'INTEGER', REAL: 'REAL', TEXT: 'TEXT' },
  postgres: { INTEGER: 'BIGINT', REAL: 'DOUBLE PRECISION', TEXT: 'TEXT' },
  mysql: { INTEGER: 'BIGINT', REAL: 'DOUBLE', TEXT: 'TEXT' }
}

/** "Order Date (KST)" → "order_date_kst"; Korean letters stay. */
export function cleanName(raw: string, fallback: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  if (!s) return fallback
  return /^\d/.test(s) ? `_${s}` : s
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = seen.get(n) ?? 0
    seen.set(n, k + 1)
    return k ? `${n}_${k + 1}` : n
  })
}

const BATCH = 500

export async function importSheet(driver: Driver, sheet: Sheet, existing: Set<string>): Promise<{ table: string; rows: number }> {
  const d = driver.dialect
  let table = cleanName(sheet.name, 'data')
  for (let i = 2; existing.has(table.toLowerCase()); i++) table = `${cleanName(sheet.name, 'data')}_${i}`
  existing.add(table.toLowerCase())

  const width = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length))
  const cols = uniqueNames(Array.from({ length: width }, (_, i) => cleanName(sheet.headers[i] ?? '', `col_${i + 1}`)))
  const types = cols.map((_, i) => inferType(sheet.rows.map((r) => r[i] ?? null)))
  const colList = cols.map((c) => quoteIdent(c, d)).join(', ')

  await driver.query(`CREATE TABLE ${quoteIdent(table, d)} (${cols.map((c, i) => `${quoteIdent(c, d)} ${SQL_TYPE[d][types[i]]}`).join(', ')})`, 0)
  await driver.query(d === 'mysql' ? 'START TRANSACTION' : 'BEGIN', 0)
  try {
    for (let i = 0; i < sheet.rows.length; i += BATCH) {
      const values = sheet.rows
        .slice(i, i + BATCH)
        .map((r) => `(${types.map((t, c) => sqlValue(convert(r[c] ?? null, t), d)).join(', ')})`)
        .join(',\n')
      await driver.query(`INSERT INTO ${quoteIdent(table, d)} (${colList}) VALUES\n${values}`, 0)
    }
    await driver.query('COMMIT', 0)
  } catch (e) {
    await driver.query('ROLLBACK', 0).catch(() => undefined)
    await driver.query(`DROP TABLE ${quoteIdent(table, d)}`, 0).catch(() => undefined)
    throw e
  }
  return { table, rows: sheet.rows.length }
}
