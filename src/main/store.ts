import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig, HistoryItem, Settings } from '@shared/types'

const dir = (): string => {
  const d = app.getPath('userData')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

const writeJson = (name: string, value: unknown): void => writeFileSync(join(dir(), name), JSON.stringify(value, null, 2))

export const dataPath = (name: string): string => join(dir(), name)

// ── connections ─────────────────────────────────────────────
interface StoredConnection extends Omit<ConnectionConfig, 'password' | 'hasPassword'> {
  secret?: string
  encrypted?: boolean
}

const encrypt = (s: string): Pick<StoredConnection, 'secret' | 'encrypted'> =>
  safeStorage.isEncryptionAvailable()
    ? { secret: safeStorage.encryptString(s).toString('base64'), encrypted: true }
    : { secret: s, encrypted: false }

const decrypt = (c: StoredConnection): string | undefined => {
  if (!c.secret) return undefined
  return c.encrypted ? safeStorage.decryptString(Buffer.from(c.secret, 'base64')) : c.secret
}

const stored = (): StoredConnection[] => readJson<StoredConnection[]>('connections.json', [])

/** Connections for the renderer: passwords never leave the main process. */
export function listConnections(): ConnectionConfig[] {
  return stored().map(({ secret, encrypted: _e, ...c }) => ({ ...c, hasPassword: !!secret }))
}

export function getConnection(id: string): ConnectionConfig | undefined {
  const c = stored().find((x) => x.id === id)
  if (!c) return undefined
  const { secret: _s, encrypted: _e, ...rest } = c
  return { ...rest, password: decrypt(c) }
}

export function saveConnection(c: ConnectionConfig): ConnectionConfig {
  const all = stored()
  const prev = all.find((x) => x.id === c.id)
  const { password, hasPassword: _h, ...rest } = c
  const secret = password ? encrypt(password) : prev ? { secret: prev.secret, encrypted: prev.encrypted } : {}
  const next: StoredConnection = { ...rest, ...secret }
  writeJson('connections.json', prev ? all.map((x) => (x.id === c.id ? next : x)) : [...all, next])
  return listConnections().find((x) => x.id === c.id)!
}

export function deleteConnection(id: string): void {
  writeJson('connections.json', stored().filter((x) => x.id !== id))
}

// ── settings ────────────────────────────────────────────────
const DEFAULT_SETTINGS: Settings = { lang: 'en', maxRows: 5000, safeMode: true, autoRun: true }

export const getSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) })

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeJson('settings.json', next)
  return next
}

// ── history ─────────────────────────────────────────────────
const HISTORY_MAX = 200

export const getHistory = (): HistoryItem[] => readJson<HistoryItem[]>('history.json', [])

export function addHistory(item: HistoryItem): void {
  const list = getHistory().filter((h) => h.sql !== item.sql)
  writeJson('history.json', [item, ...list].slice(0, HISTORY_MAX))
}

export const clearHistory = (): void => writeJson('history.json', [])
