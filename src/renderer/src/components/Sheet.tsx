import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eye, Filter, Group, ListOrdered } from 'lucide-react'
import type { Cell } from '@shared/types'
import { compareCells, formatCell, isNumeric } from '../lib/format'
import { t } from '@shared/i18n'
import type { ColumnAction } from './BlockEditor'

interface Props {
  columns: string[]
  rows: Cell[][]
  /** set when the grid shows a real table, enabling "make a block" actions */
  onBlock?: (column: string, action: ColumnAction) => void
}

const ROW_H = 28
const OVERSCAN = 12
const NUM_W = 52

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(s: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return s.length * 8
  measureCtx.font = getComputedStyle(document.body).font
  return measureCtx.measureText(s).width
}

export function Sheet({ columns, rows, onBlock }: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null)
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null)
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)

  useEffect(() => {
    setSort(null)
    setSel(null)
    scroller.current?.scrollTo({ top: 0 })
  }, [columns, rows])

  useLayoutEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const out = [...rows].sort((a, b) => compareCells(a[sort.col], b[sort.col]))
    return sort.desc ? out.reverse() : out
  }, [rows, sort])

  const widths = useMemo(
    () =>
      columns.map((c, i) => {
        let w = textWidth(c) + 40
        for (let r = 0; r < Math.min(rows.length, 60); r++) w = Math.max(w, textWidth(formatCell(rows[r][i])) + 26)
        return Math.round(Math.min(Math.max(w, 72), 320))
      }),
    [columns, rows]
  )
  const numeric = useMemo(() => columns.map((_, i) => rows.slice(0, 50).some((r) => isNumeric(r[i]))), [columns, rows])
  const template = `${NUM_W}px ${widths.map((w) => `${w}px`).join(' ')}`

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(sorted.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN)

  const copy = (e: React.KeyboardEvent): void => {
    if (!sel || !(e.metaKey || e.ctrlKey) || e.key !== 'c') return
    navigator.clipboard.writeText(formatCell(sorted[sel.r]?.[sel.c] ?? null))
    e.preventDefault()
  }

  const act = (fn: () => void): void => {
    fn()
    setMenu(null)
  }

  return (
    <div className="sheet" tabIndex={0} onKeyDown={copy}>
      <div ref={scroller} className="sheet-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="sheet-head" style={{ gridTemplateColumns: template }}>
          <div className="corner" />
          {columns.map((c, i) => (
            <button
              key={i}
              className={`th ${numeric[i] ? 'num' : ''} ${menu?.col === i ? 'open' : ''}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu(menu?.col === i ? null : { col: i, x: r.left, y: r.bottom })
              }}
              title={c}
            >
              <span>{c}</span>
              {sort?.col === i && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
            </button>
          ))}
        </div>
        <div style={{ height: sorted.length * ROW_H, position: 'relative' }}>
          {sorted.slice(first, last).map((row, k) => {
            const r = first + k
            return (
              <div key={r} className="tr" style={{ top: r * ROW_H, gridTemplateColumns: template }}>
                <div className="rownum">{r + 1}</div>
                {columns.map((_, c) => {
                  const v = row[c]
                  return (
                    <div
                      key={c}
                      className={`td ${numeric[c] ? 'num' : ''} ${v === null ? 'null' : ''} ${sel?.r === r && sel.c === c ? 'sel' : ''}`}
                      onMouseDown={() => setSel({ r, c })}
                    >
                      {formatCell(v)}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        {!rows.length && <div className="sheet-empty">{columns.length ? t('noRows') : ''}</div>}
      </div>

      {menu && (
        <>
          <div className="backdrop" onMouseDown={() => setMenu(null)} />
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y + 4 }}>
            <button onClick={() => act(() => setSort({ col: menu.col, desc: false }))}>
              <ArrowUp size={14} /> {t('sortAsc')}
            </button>
            <button onClick={() => act(() => setSort({ col: menu.col, desc: true }))}>
              <ArrowDown size={14} /> {t('sortDesc')}
            </button>
            {onBlock && (
              <>
                <div className="menu-sep">{t('addBlock')}</div>
                <button onClick={() => act(() => onBlock(columns[menu.col], 'show'))}>
                  <Eye size={14} /> {t('actShow')}
                </button>
                <button onClick={() => act(() => onBlock(columns[menu.col], 'where'))}>
                  <Filter size={14} /> {t('actFilter')}
                </button>
                <button onClick={() => act(() => onBlock(columns[menu.col], 'order'))}>
                  <ListOrdered size={14} /> {t('actSort')}
                </button>
                <button onClick={() => act(() => onBlock(columns[menu.col], 'group'))}>
                  <Group size={14} /> {t('actGroup')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
