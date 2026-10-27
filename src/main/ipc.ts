import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import Papa from 'papaparse'
import type { ExportFormat } from '@shared/api'
import type { Cell, ConnectionConfig, DbError, ImportResult, Res } from '@shared/types'
import { openDriver, type Driver } from './db'
import { IMPORT_EXTENSIONS, importSheet, readSheets } from './importer'
import { createSampleDb } from './sample'
import * as store from './store'
import { setLang, t } from '@shared/i18n'

const SAMPLE_ID = 'sample'
const WORKSPACE_ID = 'workspace'

let active: { config: ConnectionConfig; driver: Driver } | null = null

const toError = (e: unknown): DbError => {
  const err = e as { message?: string; code?: string }
  return { message: err?.message ?? String(e), code: err?.code }
}

/** Register a handler whose errors come back as { ok: false } instead of a rejected promise. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_e, ...args): Promise<Res<T>> => {
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (e) {
      return { ok: false, error: toError(e) }
    }
  })
}

/** Same as handle() but the value is returned as-is. */
function handleRaw<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
}

async function activate(id: string): Promise<Driver> {
  const config = store.getConnection(id)
  if (!config) throw new Error(t('connectionNotFound'))
  const driver = await openDriver(config)
  await active?.driver.close().catch(() => undefined)
  active = { config, driver }
  return driver
}

const requireActive = (): Driver => {
  if (!active) throw new Error(t('openFirst'))
  return active.driver
}

const win = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

function cellText(v: Cell): string | number | boolean | Date | null {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v instanceof Date) return v
  if (typeof v === 'bigint') return v.toString()
  return `[binary ${v.byteLength} bytes]`
}

export function registerIpc(): void {
  setLang(store.getSettings().lang)
  handleRaw('connections:list', () => store.listConnections())
  handle('connections:save', (c: ConnectionConfig) => store.saveConnection({ ...c, id: c.id || randomUUID() }))
  handle('connections:remove', async (id: string) => {
    if (active?.config.id === id) {
      await active.driver.close()
      active = null
    }
    store.deleteConnection(id)
  })
  handle('connections:test', async (c: ConnectionConfig) => {
    const saved = c.id ? store.getConnection(c.id) : undefined
    const driver = await openDriver({ ...c, password: c.password || saved?.password })
    await driver.close()
  })
  handle('connections:open', async (id: string) => (await activate(id)).schema())

  handle('db:query', (sql: string) => requireActive().query(sql, store.getSettings().maxRows))
  handle('db:dryRun', (sql: string) => requireActive().dryRun(sql))
  handle('db:schema', () => requireActive().schema())

  handleRaw('files:pickSqlite', async (create: boolean) => {
    const filters = [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3', 'db3'] }]
    if (create) {
      const r = await dialog.showSaveDialog(win()!, { defaultPath: 'data.sqlite', filters })
      return r.canceled ? null : r.filePath
    }
    const r = await dialog.showOpenDialog(win()!, { properties: ['openFile'], filters })
    return r.canceled ? null : r.filePaths[0]
  })

  handle('files:import', async (paths?: string[]): Promise<ImportResult[]> => {
    if (!paths?.length) {
      const r = await dialog.showOpenDialog(win()!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: t('importFilter'), extensions: IMPORT_EXTENSIONS }]
      })
      if (r.canceled) return []
      paths = r.filePaths
    }
    // imports go to the open database, except the sample — that gets a workspace of its own
    if (!active || active.config.id === SAMPLE_ID) {
      if (!store.getConnection(WORKSPACE_ID)) {
        store.saveConnection({ id: WORKSPACE_ID, name: t('myData'), kind: 'sqlite', file: store.dataPath('workspace.sqlite') })
      }
      await activate(WORKSPACE_ID)
    }
    const { config, driver } = active!
    const existing = new Set((await driver.schema()).map((t) => t.name.toLowerCase()))
    const results: ImportResult[] = []
    for (const p of paths) {
      for (const sheet of await readSheets(p)) {
        const r = await importSheet(driver, sheet, existing)
        results.push({ ...r, connection: store.listConnections().find((c) => c.id === config.id)! })
      }
    }
    return results
  })

  handle('files:export', async (data: { columns: string[]; rows: Cell[][] }, format: ExportFormat, name: string) => {
    const r = await dialog.showSaveDialog(win()!, {
      defaultPath: `${name}.${format}`,
      filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Excel', extensions: ['xlsx'] }]
    })
    if (r.canceled || !r.filePath) return null
    const rows = data.rows.map((row) => row.map(cellText))
    if (format === 'csv') {
      // BOM so Excel opens Korean text correctly
      writeFileSync(r.filePath, '﻿' + Papa.unparse({ fields: data.columns, data: rows }))
    } else {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet(name.slice(0, 31) || 'Sheet1')
      ws.addRow(data.columns).font = { bold: true }
      ws.addRows(rows)
      ws.columns.forEach((c) => (c.width = 16))
      await wb.xlsx.writeFile(r.filePath)
    }
    return r.filePath
  })

  handle('sample', async () => {
    const file = store.dataPath('sample.sqlite')
    if (active?.config.id === SAMPLE_ID) {
      await active.driver.close()
      active = null
    }
    createSampleDb(file, store.getSettings().lang)
    return store.saveConnection({ id: SAMPLE_ID, name: t('sampleName'), kind: 'sqlite', file })
  })

  handleRaw('settings:get', () => store.getSettings())
  handleRaw('settings:set', (patch) => {
    const next = store.setSettings(patch as Parameters<typeof store.setSettings>[0])
    setLang(next.lang)
    return next
  })
  handleRaw('history:list', () => store.getHistory())
  handleRaw('history:add', (sql: string) => store.addHistory({ sql, at: Date.now(), connection: active?.config.name }))
  handleRaw('history:clear', () => store.clearHistory())
}

export async function closeActive(): Promise<void> {
  await active?.driver.close().catch(() => undefined)
  active = null
}
