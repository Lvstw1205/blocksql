import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Blocks, ChevronDown, Code2, Copy, Database, Download, FileSpreadsheet, Play, Plus, RefreshCw, Save, Settings as Gear,
  Table2, Trash2, Upload, X
} from 'lucide-react'
import type { ConnectionConfig, DbError, QueryResult, Settings, TableInfo } from '@shared/types'
import { compile, type BlockQuery } from '@shared/blockquery'
import { analyze } from '@shared/doctor/analyze'
import { friendlyError } from '@shared/doctor/errors'
import { splitStatements } from '@shared/doctor/tokenizer'
import { DIALECT_LABEL, quoteIdent, quoteTable } from '@shared/sql'
import { setLang, t } from '@shared/i18n'
import { blockSchema } from './blocks/defs'
import { BlockEditor, type BlockEditorHandle, type ColumnAction } from './components/BlockEditor'
import { CodeEditor } from './components/CodeEditor'
import { ConnectDialog } from './components/ConnectDialog'
import { HealthDialog } from './components/HealthDialog'
import { Confirm, Prompt } from './components/Modal'
import { SettingsDialog } from './components/SettingsDialog'
import { Sheet } from './components/Sheet'
import { Welcome } from './components/Welcome'

const api = window.api
const RESULT = '\u0000result'
const WRITES = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE']
const DANGER = ['DROP', 'TRUNCATE', 'ALTER']
const CHANGES_SCHEMA = ['CREATE', 'DROP', 'ALTER', 'TRUNCATE', ...WRITES]

type Dialog =
  | { k: 'connect'; initial?: ConnectionConfig }
  | { k: 'health' }
  | { k: 'settings' }
  | { k: 'saveTable' }
  | { k: 'confirm'; title: string; body?: string; onConfirm(): void }

type Loaded = QueryResult | { error: DbError }

function useDark(): boolean {
  const mq = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), [])
  const [dark, setDark] = useState(mq.matches)
  useEffect(() => {
    const on = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [mq])
  return dark
}

const kindsOf = (sql: string): string[] => splitStatements(sql).map((s) => analyze(s.text).kind)

export function App(): React.JSX.Element {
  const dark = useDark()
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [active, setActive] = useState<ConnectionConfig | null>(null)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [settings, setSettings] = useState<Settings>({ lang: 'en', maxRows: 5000, safeMode: true, autoRun: true })
  const [tab, setTab] = useState('')
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [result, setResult] = useState<{ sql: string; data: QueryResult } | null>(null)
  const [error, setError] = useState<{ sql: string; message: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<'blocks' | 'code'>('blocks')
  const [blockQuery, setBlockQuery] = useState<BlockQuery | null>(null)
  const [code, setCode] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [split, setSplit] = useState(0.5)
  const [connMenu, setConnMenu] = useState(false)

  const editor = useRef<BlockEditorHandle>(null)
  const runSeq = useRef(0)
  const activeRef = useRef<ConnectionConfig | null>(null)
  activeRef.current = active
  const copiedSql = useRef('')
  const loading = useRef(new Set<string>())

  // every t() call below renders in the chosen language
  setLang(settings.lang)
  const dialect = active?.kind ?? 'sqlite'
  const tableInfo = useCallback((name: string) => tables.find((t) => t.name === name), [tables])

  const say = (text: string, bad = false): void => setToast({ text, bad })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    api.connections.list().then(setConnections)
    api.settings.get().then(setSettings)
  }, [])

  // ── compile blocks ──────────────────────────────────────
  const compiled = useMemo(() => {
    if (!blockQuery) return null
    const typeOf = (t: string, c: string): string | undefined => tableInfo(t)?.columns.find((x) => x.name === c)?.type
    return compile(blockQuery, dialect, typeOf)
  }, [blockQuery, dialect, tableInfo])

  const blockScope = useMemo(
    () => (blockQuery ? [blockQuery.table, ...blockQuery.steps.flatMap((s) => (s.k === 'join' ? [s.table] : []))] : []),
    [blockQuery]
  )

  // ── connections ─────────────────────────────────────────
  const applySchema = (conn: ConnectionConfig, schema: TableInfo[], focus?: string): void => {
    const first = focus ?? schema[0]?.name ?? ''
    if (first) blockSchema.setFocus(first)
    loading.current.clear()
    setActive(conn)
    setTables(schema)
    setLoaded({})
    setTab(first)
  }

  const openConnection = async (id: string): Promise<void> => {
    setConnMenu(false)
    setBusy(true)
    const r = await api.connections.open(id)
    const list = await api.connections.list()
    setBusy(false)
    setConnections(list)
    if (!r.ok) return say(friendlyError(r.error.message).title, true)
    setResult(null)
    setError(null)
    applySchema(list.find((c) => c.id === id)!, r.value)
  }

  const refreshSchema = async (focus?: string): Promise<void> => {
    const s = await api.db.schema()
    if (s.ok && activeRef.current) applySchema(activeRef.current, s.value, focus ?? (s.value.some((t) => t.name === tab) ? tab : undefined))
  }

  const removeConnection = async (id: string): Promise<void> => {
    await api.connections.remove(id)
    setConnections(await api.connections.list())
    if (active?.id === id) {
      setActive(null)
      setTables([])
    }
  }

  const startSample = async (): Promise<void> => {
    setConnMenu(false)
    setBusy(true)
    const r = await api.sample()
    setBusy(false)
    if (!r.ok) return say(r.error.message, true)
    localStorage.removeItem(`blocksql.blocks.${r.value.id}`)
    await openConnection(r.value.id)
  }

  const importFiles = async (paths?: string[]): Promise<void> => {
    setBusy(true)
    const r = await api.files.import(paths)
    setBusy(false)
    if (!r.ok) return say(t('importFailed', { msg: r.error.message }), true)
    if (!r.value.length) return
    const first = r.value[0]
    setConnections(await api.connections.list())
    const s = await api.db.schema()
    if (s.ok) applySchema(first.connection, s.value, first.table)
    editor.current?.followTable(first.table)
    say(t('imported', { list: r.value.map((x) => t('importedItem', { table: x.table, n: x.rows })).join(' · ') }))
  }

  // ── table tabs ──────────────────────────────────────────
  useEffect(() => {
    const conn = active
    if (!conn || !tab || tab === RESULT || loaded[tab] || loading.current.has(tab)) return
    loading.current.add(tab)
    api.db.query(`SELECT * FROM ${quoteTable(tab, conn.kind)}`).then((r) => {
      loading.current.delete(tab)
      if (activeRef.current?.id !== conn.id) return
      setLoaded((d) => ({ ...d, [tab]: r.ok ? r.value : { error: r.error } }))
    })
  }, [tab, active, loaded])

  const selectTab = (name: string): void => {
    setTab(name)
    if (name !== RESULT) editor.current?.followTable(name)
  }

  // ── running ─────────────────────────────────────────────
  const execute = async (sql: string, source: 'blocks' | 'code'): Promise<void> => {
    const seq = ++runSeq.current
    setRunning(true)
    const r = await api.db.query(sql)
    if (seq !== runSeq.current) return
    setRunning(false)
    if (!r.ok) {
      setError({ sql, message: r.error.message })
      return
    }
    setError(null)
    setResult({ sql, data: r.value })
    setTab(RESULT)
    if (source === 'code') api.history.add(sql)
    if (kindsOf(sql).some((k) => CHANGES_SCHEMA.includes(k))) {
      const s = await api.db.schema()
      if (s.ok) {
        loading.current.clear()
        setTables(s.value)
        setLoaded({})
      }
    }
  }

  const run = async (sql: string, source: 'blocks' | 'code'): Promise<void> => {
    const text = sql.trim()
    if (!text || !active) return
    const kinds = kindsOf(text)
    const writes = kinds.some((k) => WRITES.includes(k))
    const danger = kinds.some((k) => DANGER.includes(k))
    if (source === 'code' && settings.safeMode && (writes || danger)) {
      let body = t('cannotUndo')
      if (writes && !danger) {
        const d = await api.db.dryRun(text)
        if (!d.ok) return setError({ sql: text, message: d.error.message })
        body = t('rowsWillChange', { n: d.value })
      }
      setDialog({ k: 'confirm', title: t('runConfirm'), body, onConfirm: () => void execute(text, source) })
      return
    }
    await execute(text, source)
  }

  const runCurrent = (): void => {
    if (mode === 'code') void run(code, 'code')
    else if (compiled && !compiled.holes) void run(compiled.sql, 'blocks')
  }

  // blocks changed → show the table, or run the query
  useEffect(() => {
    if (mode !== 'blocks' || !blockQuery || !compiled || !active) return
    if (!blockQuery.steps.length) {
      if (blockQuery.table && tables.some((t) => t.name === blockQuery.table)) setTab(blockQuery.table)
      return
    }
    if (compiled.holes || !settings.autoRun || active.kind !== 'sqlite') return
    const t = setTimeout(() => void execute(compiled.sql, 'blocks'), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled?.sql, compiled?.holes, mode, settings.autoRun])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && mode === 'blocks') {
        e.preventDefault()
        runCurrent()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const switchMode = (m: 'blocks' | 'code'): void => {
    if (m === 'code' && compiled && (!code.trim() || code === copiedSql.current)) {
      setCode(compiled.sql)
      copiedSql.current = compiled.sql
    }
    setMode(m)
  }

  // ── files ───────────────────────────────────────────────
  useEffect(() => {
    const over = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      const paths = files.map((f) => api.files.pathFor(f)).filter(Boolean)
      if (paths.length) void importFiles(paths)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  })

  const exportResult = async (format: 'csv' | 'xlsx'): Promise<void> => {
    const data = tab === RESULT ? result?.data : (loaded[tab] as QueryResult | undefined)
    if (!data || !('columns' in data)) return
    const r = await api.files.export(data, format, tab === RESULT ? t('result') : tab)
    if (!r.ok) say(r.error.message, true)
    else if (r.value) say(t('savedFile'))
  }

  const saveAsTable = async (name: string): Promise<void> => {
    if (!result) return
    const last = splitStatements(result.sql).at(-1)?.text ?? result.sql
    const r = await api.db.query(`CREATE TABLE ${quoteIdent(name, dialect)} AS\n${last}`)
    if (!r.ok) return say(friendlyError(r.error.message, tables).title, true)
    await refreshSchema(name)
    say(t('tableCreated', { name }))
  }

  // ── split pane ──────────────────────────────────────────
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const move = (ev: MouseEvent): void => setSplit(Math.min(0.75, Math.max(0.25, ev.clientX / window.innerWidth)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const updateSettings = async (patch: Partial<Settings>): Promise<void> => setSettings(await api.settings.set(patch))

  // ── view ────────────────────────────────────────────────
  const shown: Loaded | undefined = tab === RESULT ? result?.data : loaded[tab]
  const currentTable = tab !== RESULT ? tableInfo(tab) : undefined
  const canBlock = !!currentTable && (blockScope.includes(tab) || !blockQuery?.steps.length)
  const friendly = error ? friendlyError(error.message, tables) : null

  const onBlock = (column: string, action: ColumnAction): void => {
    if (!blockScope.includes(tab)) editor.current?.followTable(tab)
    if (mode !== 'blocks') setMode('blocks')
    editor.current?.addColumnStep(tab, column, action)
  }

  return (
    <div className={`app ${api.platform === 'darwin' ? 'mac' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <Blocks size={18} />
          BlockSQL
        </div>
        {active && (
          <div className="conn">
            <button className="conn-btn" onClick={() => setConnMenu(!connMenu)}>
              {active.kind === 'sqlite' ? <FileSpreadsheet size={15} /> : <Database size={15} />}
              <span>{active.name}</span>
              <span className="muted small">{DIALECT_LABEL[active.kind]}</span>
              <ChevronDown size={14} />
            </button>
            {connMenu && (
              <>
                <div className="backdrop" onMouseDown={() => setConnMenu(false)} />
                <div className="menu conn-menu">
                  {connections.map((c) => (
                    <div key={c.id} className={`menu-row ${c.id === active.id ? 'on' : ''}`}>
                      <button className="grow" onClick={() => openConnection(c.id)}>
                        {c.kind === 'sqlite' ? <FileSpreadsheet size={14} /> : <Database size={14} />}
                        {c.name}
                      </button>
                      <button className="icon" title={t('delete')} onClick={() => removeConnection(c.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="menu-sep" />
                  <button onClick={() => (setConnMenu(false), setDialog({ k: 'connect' }))}>
                    <Plus size={14} /> {t('connectDb')}
                  </button>
                  <button onClick={startSample}>
                    <RefreshCw size={14} /> {t('resetSample')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <span className="grow drag" />
        <button className="tb" onClick={() => importFiles()} disabled={busy}>
          <Upload size={15} /> {t('importFile')}
        </button>
        {active && (
          <button className="tb" onClick={() => setDialog({ k: 'health' })} disabled={!currentTable}>
            <Activity size={15} /> {t('healthCheck')}
          </button>
        )}
        <button className="tb icon" onClick={() => setDialog({ k: 'settings' })} title={t('settings')}>
          <Gear size={16} />
        </button>
      </header>

      {!active ? (
        <Welcome
          connections={connections}
          busy={busy}
          onImport={() => importFiles()}
          onSample={startSample}
          onConnect={() => setDialog({ k: 'connect' })}
          onOpen={openConnection}
        />
      ) : (
        <main className="panes" style={{ gridTemplateColumns: `${split}fr 6px ${1 - split}fr` }}>
          {/* ── left: spreadsheet ── */}
          <section className="pane left">
            <div className="grid-area">
              {shown && 'columns' in shown && (shown.columns.length || tab !== RESULT) ? (
                <Sheet columns={shown.columns} rows={shown.rows} onBlock={canBlock ? onBlock : undefined} />
              ) : shown && 'columns' in shown ? (
                <div className="center muted">{t('rowsChanged', { n: shown.changes ?? 0 })}</div>
              ) : shown && 'error' in shown ? (
                <div className="center issue error">{friendlyError(shown.error.message, tables).title}</div>
              ) : (
                <div className="center muted">{tables.length ? t('loading') : t('noTables')}</div>
              )}
            </div>
            <footer className="tabs">
              <div className="tab-list">
                {tables.map((t) => (
                  <button key={t.name} className={`tab ${tab === t.name ? 'on' : ''}`} onClick={() => selectTab(t.name)}>
                    <Table2 size={13} />
                    {t.name}
                  </button>
                ))}
                {result && (
                  <button className={`tab result ${tab === RESULT ? 'on' : ''}`} onClick={() => setTab(RESULT)}>
                    <Play size={12} /> {t('result')}
                  </button>
                )}
              </div>
              {shown && 'columns' in shown && shown.columns.length > 0 && (
                <div className="tab-info">
                  <span className="muted">
                    {t('rows', { n: shown.rows.length.toLocaleString() + (shown.truncated ? '+' : '') })}
                    {tab === RESULT ? ` · ${shown.durationMs}ms` : ''}
                  </span>
                  <button className="icon" title={t('saveCsv')} onClick={() => exportResult('csv')}>
                    <Download size={14} />
                  </button>
                  <button className="icon" title={t('saveXlsx')} onClick={() => exportResult('xlsx')}>
                    <FileSpreadsheet size={14} />
                  </button>
                  {tab === RESULT && (
                    <button className="icon" title={t('saveAsTable')} onClick={() => setDialog({ k: 'saveTable' })}>
                      <Save size={14} />
                    </button>
                  )}
                </div>
              )}
            </footer>
          </section>

          <div className="splitter" onMouseDown={startDrag} />

          {/* ── right: blocks / code ── */}
          <section className="pane right">
            <div className="right-head">
              <div className="segmented small">
                <button className={mode === 'blocks' ? 'on' : ''} onClick={() => switchMode('blocks')}>
                  <Blocks size={14} /> {t('blocks')}
                </button>
                <button className={mode === 'code' ? 'on' : ''} onClick={() => switchMode('code')}>
                  <Code2 size={14} /> {t('code')}
                </button>
              </div>
              <span className="grow" />
              <button
                className="primary run"
                onClick={runCurrent}
                disabled={running || (mode === 'blocks' ? !compiled || compiled.holes > 0 : !code.trim())}
                title="⌘/Ctrl + Enter"
              >
                <Play size={14} /> {t('run')}
              </button>
            </div>

            <div className="right-body">
              <div className="blocks-wrap" style={{ display: mode === 'blocks' ? 'flex' : 'none' }}>
                <BlockEditor ref={editor} tables={tables} storageKey={`blocksql.blocks.${active.id}`} dark={dark} lang={settings.lang} onQuery={setBlockQuery} />
                {compiled && (
                  <div className="sql-preview">
                    <pre>{compiled.sql}</pre>
                    <div className="sql-actions">
                      {compiled.holes > 0 && <span className="hint">{t('holes', { n: compiled.holes })}</span>}
                      <button className="icon" title={t('copy')} onClick={() => navigator.clipboard.writeText(compiled.sql)}>
                        <Copy size={13} />
                      </button>
                      <button className="icon" title={t('editAsCode')} onClick={() => switchMode('code')}>
                        <Code2 size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {mode === 'code' && (
                <CodeEditor value={code} onChange={setCode} onRun={(s) => void run(s, 'code')} dialect={dialect} tables={tables} dark={dark} />
              )}
              {error && friendly && (
                <div className="error-card">
                  <div className="error-title">
                    <b>{friendly.title}</b>
                    <button className="icon" onClick={() => setError(null)} aria-label={t('close')}>
                      <X size={14} />
                    </button>
                  </div>
                  {friendly.hint && <div>{friendly.hint}</div>}
                  <div className="raw">{error.message}</div>
                </div>
              )}
            </div>
          </section>
        </main>
      )}

      {dragging && (
        <div className="drop-overlay">
          <Upload size={40} strokeWidth={1.5} />
          {t('dropToImport')}
        </div>
      )}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}

      {dialog?.k === 'connect' && (
        <ConnectDialog
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={async (c) => {
            setDialog(null)
            await openConnection(c.id)
          }}
        />
      )}
      {dialog?.k === 'health' && currentTable && <HealthDialog table={currentTable} dialect={dialect} onClose={() => setDialog(null)} />}
      {dialog?.k === 'settings' && <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setDialog(null)} />}
      {dialog?.k === 'saveTable' && (
        <Prompt title={t('saveAsTable')} label={t('tableName')} initial="result" confirm={t('save')} onSubmit={saveAsTable} onClose={() => setDialog(null)} />
      )}
      {dialog?.k === 'confirm' && (
        <Confirm title={dialog.title} body={dialog.body} confirm={t('run')} danger onConfirm={dialog.onConfirm} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}
