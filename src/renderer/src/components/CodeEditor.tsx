import { useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { format } from 'sql-formatter'
import { AlertCircle, AlertTriangle, BookOpen, History, Lightbulb, Wand2 } from 'lucide-react'
import type { Dialect, HistoryItem, TableInfo } from '@shared/types'
import { applyEdits, lint, type Issue } from '@shared/doctor/lint'
import { explain } from '@shared/doctor/explain'
import { t } from '@shared/i18n'

interface Props {
  value: string
  onChange(v: string): void
  onRun(sql: string): void
  dialect: Dialect
  tables: TableInfo[]
  dark: boolean
}

const DIALECTS = { sqlite: SQLite, postgres: PostgreSQL, mysql: MySQL }
const FORMATTER = { sqlite: 'sqlite', postgres: 'postgresql', mysql: 'mysql' } as const
const ICON = { error: AlertCircle, warning: AlertTriangle, tip: Lightbulb }

/** Render `code` spans from explain() text. */
export function Rich({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </>
  )
}

export function CodeEditor({ value, onChange, onRun, dialect, tables, dark }: Props): React.JSX.Element {
  const view = useRef<EditorView | null>(null)
  const [panel, setPanel] = useState<'doctor' | 'explain' | 'history'>('doctor')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const ctx = useMemo(() => ({ dialect, tables }), [dialect, tables])
  const issues = useMemo(() => lint(value, ctx), [value, ctx])
  const explanation = useMemo(() => (panel === 'explain' ? explain(value) : []), [value, panel])

  const runRef = useRef(onRun)
  runRef.current = onRun
  const runCurrent = (): void => {
    const v = view.current
    if (!v) return
    const { from, to } = v.state.selection.main
    runRef.current(from === to ? v.state.doc.toString() : v.state.sliceDoc(from, to))
  }

  const extensions = useMemo(() => {
    const schema = Object.fromEntries(tables.map((t) => [t.name, t.columns.map((c) => c.name)]))
    return [
      sql({ dialect: DIALECTS[dialect], schema, upperCaseKeywords: true }),
      Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (runCurrent(), true) }])),
      lintGutter(),
      linter(
        (v): Diagnostic[] =>
          lint(v.state.doc.toString(), ctx).map((i) => ({
            from: i.from,
            to: Math.max(i.to, i.from + 1),
            severity: i.severity === 'tip' ? 'info' : i.severity,
            message: i.message,
            actions: i.fix
              ? [{ name: i.fix.label, apply: (ev: EditorView) => ev.dispatch({ changes: i.fix!.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })) }) }]
              : []
          })),
        { delay: 300 }
      ),
      EditorView.lineWrapping
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialect, tables, ctx])

  const fix = (i: Issue): void => onChange(applyEdits(value, i.fix!.edits))
  const tidy = (): void => {
    try {
      onChange(format(value, { language: FORMATTER[dialect], keywordCase: 'upper' }))
    } catch {
      /* leave unparseable text alone; the doctor already shows why */
    }
  }
  const openHistory = async (): Promise<void> => {
    setPanel('history')
    setHistory(await window.api.history.list())
  }

  const errors = issues.filter((i) => i.severity === 'error').length

  return (
    <div className="code">
      <div className="code-editor">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={extensions}
          theme={dark ? 'dark' : 'light'}
          height="100%"
          basicSetup={{ foldGutter: false, highlightActiveLine: true }}
          onCreateEditor={(v) => (view.current = v)}
          placeholder="SELECT * FROM ..."
        />
      </div>
      <div className="doctor">
        <div className="doctor-tabs">
          <button className={panel === 'doctor' ? 'on' : ''} onClick={() => setPanel('doctor')}>
            {t('checks')} {issues.length > 0 && <span className={`badge ${errors ? 'bad' : ''}`}>{issues.length}</span>}
          </button>
          <button className={panel === 'explain' ? 'on' : ''} onClick={() => setPanel('explain')}>
            <BookOpen size={13} /> {t('explain')}
          </button>
          <button className={panel === 'history' ? 'on' : ''} onClick={openHistory}>
            <History size={13} /> {t('history')}
          </button>
          <span className="grow" />
          <button onClick={tidy}>
            <Wand2 size={13} /> {t('tidy')}
          </button>
        </div>
        <div className="doctor-body">
          {panel === 'doctor' &&
            (issues.length ? (
              issues.map((i, k) => {
                const Icon = ICON[i.severity]
                return (
                  <div key={k} className={`issue ${i.severity}`}>
                    <Icon size={14} />
                    <span className="grow">{i.message}</span>
                    {i.fix && (
                      <button className="chip" onClick={() => fix(i)}>
                        {i.fix.label}
                      </button>
                    )}
                  </div>
                )
              })
            ) : (
              <div className="muted">{value.trim() ? t('noProblems') : ''}</div>
            ))}
          {panel === 'explain' &&
            explanation.map((e, k) => (
              <div key={k} className="explain">
                <div className="explain-title">
                  <Rich text={e.summary} />
                </div>
                <ol>
                  {e.steps.map((s, j) => (
                    <li key={j}>
                      <span className="tag">{s.tag}</span>
                      <Rich text={s.text} />
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          {panel === 'history' &&
            (history.length ? (
              <>
                {history.map((h, k) => (
                  <button key={k} className="history-item" onClick={() => onChange(h.sql)}>
                    <code>{h.sql.replace(/\s+/g, ' ').slice(0, 120)}</code>
                    <span className="muted">{new Date(h.at).toLocaleString()}</span>
                  </button>
                ))}
                <button
                  className="link"
                  onClick={async () => {
                    await window.api.history.clear()
                    setHistory([])
                  }}
                >
                  {t('clearHistory')}
                </button>
              </>
            ) : (
              <div className="muted">{t('noHistory')}</div>
            ))}
        </div>
      </div>
    </div>
  )
}
