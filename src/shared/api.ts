import type { Cell, ConnectionConfig, HistoryItem, ImportResult, QueryResult, Res, Settings, TableInfo } from './types'

export type ExportFormat = 'csv' | 'xlsx'

/** Everything the renderer can ask the main process to do (exposed as window.api). */
export interface Api {
  platform: string
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(c: ConnectionConfig): Promise<Res<ConnectionConfig>>
    remove(id: string): Promise<Res<void>>
    test(c: ConnectionConfig): Promise<Res<void>>
    open(id: string): Promise<Res<TableInfo[]>>
  }
  db: {
    query(sql: string): Promise<Res<QueryResult>>
    dryRun(sql: string): Promise<Res<number>>
    schema(): Promise<Res<TableInfo[]>>
  }
  files: {
    pickSqlite(create: boolean): Promise<string | null>
    /** No paths → show an open dialog */
    import(paths?: string[]): Promise<Res<ImportResult[]>>
    pathFor(file: File): string
    export(data: { columns: string[]; rows: Cell[][] }, format: ExportFormat, name: string): Promise<Res<string | null>>
  }
  sample(): Promise<Res<ConnectionConfig>>
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  history: {
    list(): Promise<HistoryItem[]>
    add(sql: string): Promise<void>
    clear(): Promise<void>
  }
}
