import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as Blockly from 'blockly/core'
import * as En from 'blockly/msg/en'
import * as Ko from 'blockly/msg/ko'
import type { Lang } from '@shared/i18n'
import type { BlockQuery } from '@shared/blockquery'
import type { TableInfo } from '@shared/types'
import { SEP, blockSchema, queryOf, registerBlocks, shortName, tablesInScope } from '../blocks/defs'
import { COLUMNS_CATEGORY, buildToolbox, columnsFlyout } from '../blocks/toolbox'
import { toQuery } from '../blocks/toQuery'

export type ColumnAction = 'show' | 'where' | 'order' | 'group'

export interface BlockEditorHandle {
  addColumnStep(table: string, column: string, action: ColumnAction): void
  /** Point the active query at another table (only when it has no steps yet). */
  followTable(table: string): void
}

interface Props {
  tables: TableInfo[]
  storageKey: string
  dark: boolean
  lang: Lang
  onQuery(q: BlockQuery | null): void
}

const LOCALES = { en: En, ko: Ko } as unknown as Record<Lang, Record<string, string>>
registerBlocks()

const themes = {
  light: Blockly.Theme.defineTheme('bs-light', {
    name: 'bs-light',
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: '#fafaf9',
      toolboxBackgroundColour: '#ffffff',
      toolboxForegroundColour: '#3f3f46',
      flyoutBackgroundColour: '#f1f1ef',
      flyoutOpacity: 1,
      scrollbarColour: '#d4d4d8',
      insertionMarkerColour: '#000000',
      insertionMarkerOpacity: 0.2
    },
    fontStyle: { family: '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif', size: 12, weight: '600' }
  }),
  dark: Blockly.Theme.defineTheme('bs-dark', {
    name: 'bs-dark',
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: '#1c1c1f',
      toolboxBackgroundColour: '#232327',
      toolboxForegroundColour: '#e4e4e7',
      flyoutBackgroundColour: '#2a2a2f',
      flyoutForegroundColour: '#e4e4e7',
      flyoutOpacity: 1,
      scrollbarColour: '#52525b',
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.25
    },
    fontStyle: { family: '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif', size: 12, weight: '600' }
  })
}

const colJson = (table: string, column: string): Blockly.serialization.blocks.State => ({ type: 'sql_col', fields: { COL: table + SEP + column } })
const stem = (t: string): string => shortName(t).toLowerCase().replace(/(es|s)$/, '')

/** Find the column pair that links two tables: declared FKs first, then "<table>_id" naming. */
function linkBetween(a: string, b: string): [string, string, string, string] | null {
  const ta = blockSchema.table(a)
  const tb = blockSchema.table(b)
  if (!ta || !tb) return null
  const fa = ta.foreignKeys.find((f) => f.refTable === b)
  if (fa) return [a, fa.column, b, fa.refColumn]
  const fb = tb.foreignKeys.find((f) => f.refTable === a)
  if (fb) return [a, fb.refColumn, b, fb.column]
  const has = (t: TableInfo, c: string): boolean => t.columns.some((x) => x.name.toLowerCase() === c)
  if (has(ta, `${stem(b)}_id`) && has(tb, 'id')) return [a, `${stem(b)}_id`, b, 'id']
  if (has(tb, `${stem(a)}_id`) && has(ta, 'id')) return [a, 'id', b, `${stem(a)}_id`]
  return null
}

export const BlockEditor = forwardRef<BlockEditorHandle, Props>(function BlockEditor({ tables, storageKey, dark, lang, onQuery }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const ws = useRef<Blockly.WorkspaceSvg | null>(null)
  const activeId = useRef<string | null>(null)
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  const keyRef = useRef(storageKey)
  keyRef.current = storageKey

  const activeQuery = (): Blockly.Block | null => {
    const w = ws.current
    if (!w) return null
    const a = activeId.current ? w.getBlockById(activeId.current) : null
    if (a && !a.isDisposed()) return a
    const first = w.getTopBlocks(true).find((b) => b.type === 'sql_query') ?? null
    activeId.current = first?.id ?? null
    return first
  }

  const emit = (): void => {
    const q = activeQuery()
    if (q) blockSchema.setFocus(q.getFieldValue('TABLE'))
    onQueryRef.current(q ? toQuery(q) : null)
  }

  const save = (): void => {
    if (!ws.current) return
    try {
      localStorage.setItem(keyRef.current, JSON.stringify(Blockly.serialization.workspaces.save(ws.current)))
    } catch {
      /* storage is a convenience */
    }
  }

  const starter = (table: string): void => {
    const w = ws.current!
    const b = Blockly.serialization.blocks.append({ type: 'sql_query', x: 40, y: 40, fields: { TABLE: table } }, w)
    activeId.current = b.id
  }

  // inject once
  useEffect(() => {
    Blockly.setLocale(LOCALES[lang])
    const w = Blockly.inject(host.current!, {
      toolbox: buildToolbox(),
      renderer: 'zelos',
      theme: dark ? themes.dark : themes.light,
      media: './blockly-media/',
      sounds: false,
      trashcan: true,
      grid: { spacing: 24, length: 2, colour: dark ? '#2e2e33' : '#e7e7e4', snap: true },
      zoom: { controls: true, wheel: false, pinch: true, startScale: 0.85, maxScale: 2, minScale: 0.4, scaleSpeed: 1.15 },
      move: { scrollbars: true, drag: true, wheel: true }
    })
    ws.current = w
    w.registerToolboxCategoryCallback(COLUMNS_CATEGORY, () => columnsFlyout(tablesInScope(activeQuery())))

    const listener = (e: Blockly.Events.Abstract): void => {
      if (e.isUiEvent) return
      const id = (e as Blockly.Events.BlockBase).blockId
      const block = id ? w.getBlockById(id) : null
      const root = block?.getRootBlock()
      if (root?.type === 'sql_query') activeId.current = root.id

      // a join that just landed in a query, or switched table: fill in the link condition
      if (block?.type === 'sql_join' && (e.type === Blockly.Events.BLOCK_MOVE || e.type === Blockly.Events.BLOCK_CHANGE)) {
        autoJoin(w, block)
      }
      emit()
      save()
    }
    w.addChangeListener(listener)

    const ro = new ResizeObserver(() => Blockly.svgResize(w))
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      w.dispose()
      ws.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    ws.current?.setTheme(dark ? themes.dark : themes.light)
  }, [dark])

  // language switch: block labels are set when blocks are created, so rebuild them
  const firstLang = useRef(lang)
  useEffect(() => {
    const w = ws.current
    if (!w || firstLang.current === lang) return
    firstLang.current = lang
    Blockly.setLocale(LOCALES[lang])
    const state = Blockly.serialization.workspaces.save(w)
    Blockly.Events.disable()
    try {
      w.updateToolbox(buildToolbox())
      w.clear()
      Blockly.serialization.workspaces.load(state, w)
    } finally {
      Blockly.Events.enable()
    }
    emit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  // schema → dropdowns and the column flyout
  useEffect(() => {
    blockSchema.set(tables)
    ws.current?.refreshToolboxSelection()
  }, [tables])

  // load the workspace saved for this database
  useEffect(() => {
    const w = ws.current
    if (!w) return
    Blockly.Events.disable()
    try {
      w.clear()
      activeId.current = null
      let saved: object | null = null
      try {
        saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      } catch {
        saved = null
      }
      if (saved) Blockly.serialization.workspaces.load(saved, w)
      if (!w.getTopBlocks(false).some((b) => b.type === 'sql_query') && blockSchema.tables[0]) starter(blockSchema.focus || blockSchema.tables[0].name)
    } finally {
      Blockly.Events.enable()
    }
    emit()
    // tables must be set before the restore; they are applied by the effect above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, tables.length > 0])

  useImperativeHandle(ref, () => ({
    addColumnStep(table, column, action) {
      const w = ws.current
      if (!w) return
      let q = activeQuery()
      if (!q) {
        starter(table)
        q = activeQuery()!
      }
      const col = colJson(table, column)
      const json: Blockly.serialization.blocks.State = {
        show: { type: 'sql_show', inputs: { EXPR: { block: col } } },
        where: { type: 'sql_where', inputs: { COND: { block: { type: 'sql_cmp', inputs: { A: { block: col }, B: { shadow: { type: 'sql_text', fields: { V: '' } } } } } } } },
        order: { type: 'sql_order', inputs: { EXPR: { block: col } } },
        group: { type: 'sql_group', inputs: { EXPR: { block: col } } }
      }[action]
      Blockly.Events.setGroup(true)
      const b = Blockly.serialization.blocks.append(json, w) as Blockly.BlockSvg
      let last = q.getInputTargetBlock('STEPS')
      while (last?.getNextBlock()) last = last.getNextBlock()
      const target = last ? last.nextConnection : q.getInput('STEPS')!.connection
      target?.connect(b.previousConnection!)
      Blockly.Events.setGroup(false)
      b.select()
      w.scrollBoundsIntoView(b.getBoundingRectangle())
    },
    followTable(table) {
      const q = activeQuery()
      if (q && !q.getInputTargetBlock('STEPS') && q.getFieldValue('TABLE') !== table) q.setFieldValue(table, 'TABLE')
    }
  }))

  return <div ref={host} className="blockly-host" />
})

function autoJoin(w: Blockly.WorkspaceSvg, join: Blockly.Block): void {
  const q = queryOf(join)
  if (join.getInputTargetBlock('COND') || !q) return
  const jt = join.getFieldValue('TABLE') as string
  const main = q.getFieldValue('TABLE') as string
  if (jt === main) {
    // joining a table to itself is rarely meant: switch to a related table (this re-enters autoJoin)
    const other = blockSchema.tables.find((t) => t.name !== main && linkBetween(main, t.name))
    if (other) join.setFieldValue(other.name, 'TABLE')
    return
  }
  for (const other of tablesInScope(join).filter((t) => t !== jt)) {
    const link = linkBetween(other, jt)
    if (!link) continue
    const [ta, ca, tb, cb] = link
    const cmp = Blockly.serialization.blocks.append(
      { type: 'sql_cmp', inputs: { A: { block: colJson(ta, ca) }, B: { block: colJson(tb, cb) } } },
      w
    )
    join.getInput('COND')!.connection!.connect(cmp.outputConnection!)
    return
  }
}
