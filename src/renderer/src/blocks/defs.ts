import * as Blockly from 'blockly/core'
import type { TableInfo } from '@shared/types'
import { getLang, t as tr, type MessageKey } from '@shared/i18n'

/** Separator between table and column inside a column block's value. */
export const SEP = '\u001f'

export const COLOR = {
  query: '#4C97FF',
  column: '#5CB1D6',
  filter: '#59C059',
  group: '#FF8C1A',
  sort: '#9966FF',
  join: '#FFAB19',
  value: '#CF63CF',
  text: '#0FBD8C',
  date: '#FF6680',
  rank: '#2E9E9E',
  logic: '#5B80A5'
}

// ── schema the dropdowns read from ──────────────────────────
let tables: TableInfo[] = []
let focus = ''

export const blockSchema = {
  set(next: TableInfo[]): void {
    tables = next
    if (!tables.some((t) => t.name === focus)) focus = tables[0]?.name ?? ''
  },
  setFocus(name: string): void {
    focus = name
  },
  get focus(): string {
    return focus
  },
  table(name: string): TableInfo | undefined {
    return tables.find((t) => t.name === name)
  },
  get tables(): TableInfo[] {
    return tables
  }
}

export const shortName = (t: string): string => t.slice(t.lastIndexOf('.') + 1)

/** The query block a step or value block sits in. */
export function queryOf(block: Blockly.Block | null): Blockly.Block | null {
  let b = block
  while (b && b.type !== 'sql_query') b = b.getSurroundParent() ?? b.getParent()
  return b
}

/** Main table plus joined tables of the query around `block`. */
export function tablesInScope(block: Blockly.Block | null): string[] {
  const q = queryOf(block)
  if (!q) return focus ? [focus] : []
  const names = [q.getFieldValue('TABLE') as string]
  for (let s = q.getInputTargetBlock('STEPS'); s; s = s.getNextBlock()) {
    if (s.type === 'sql_join' && s.isEnabled()) names.push(s.getFieldValue('TABLE') as string)
  }
  return [...new Set(names.filter(Boolean))]
}

/**
 * Dropdown whose options depend on the schema. It accepts any saved value so a workspace
 * can be restored before its blocks are connected (when the menu would not list it yet).
 */
class DynamicDropdown extends Blockly.FieldDropdown {
  protected override doClassValidation_(v?: string): string | null {
    return typeof v === 'string' ? v : null
  }
  protected override doValueUpdate_(v: string): void {
    ;(this as unknown as { generatedOptions: unknown }).generatedOptions = null
    super.doValueUpdate_(v)
  }
}

/** Columns of the main table read bare; columns of joined tables get their table prefix. */
const columnLabel = (value: string, main: string | undefined): string => {
  const [t, c] = value.split(SEP)
  return t === main ? c : `${shortName(t)}.${c}`
}

function columnOptions(this: Blockly.FieldDropdown): Blockly.MenuOption[] {
  const scope = tablesInScope(this.getSourceBlock())
  const opts: Blockly.MenuOption[] = scope.flatMap((t) =>
    (blockSchema.table(t)?.columns ?? []).map((c): Blockly.MenuOption => [columnLabel(t + SEP + c.name, scope[0]), t + SEP + c.name])
  )
  const cur = this.getValue()
  if (cur && !opts.some((o) => o[1] === cur)) opts.push([columnLabel(cur, scope[0]), cur])
  return opts.length ? opts : [[tr('bColumn'), '']]
}

function tableOptions(this: Blockly.FieldDropdown): Blockly.MenuOption[] {
  const opts: Blockly.MenuOption[] = tables.map((t) => [t.name, t.name])
  const cur = this.getValue()
  if (cur && !opts.some((o) => o[1] === cur)) opts.push([cur, cur])
  return opts.length ? opts : [[tr('bNoTable'), '']]
}

const dynamic = (gen: Blockly.MenuGeneratorFunction): Blockly.Field => new DynamicDropdown(gen) as unknown as Blockly.Field
const tableField = (): Blockly.Field => dynamic(tableOptions)
/** A dropdown whose labels are translated when the block is created. */
const menu = (items: [MessageKey, string][]): Blockly.FieldDropdown =>
  new Blockly.FieldDropdown(items.map(([k, v]): Blockly.MenuOption => [tr(k), v]))
const ko = (): boolean => getLang() === 'ko'

type Def = { init(this: Blockly.Block): void }
const defs: Record<string, Def> = {}

const VALUE = 'Value'
const BOOL = 'Boolean'

// Labels are read in init(), so blocks created after a language switch use the new language.

// ── query & steps ───────────────────────────────────────────
defs.sql_query = {
  init() {
    this.appendDummyInput().appendField('📋').appendField(tr('bQueryBefore')).appendField(tableField(), 'TABLE').appendField(tr('bQueryAfter'))
    this.appendStatementInput('STEPS').setCheck('Step')
    this.setColour(COLOR.query)
    this.setTooltip(tr('bQueryTip'))
    ;(this as Blockly.BlockSvg & { hat?: string }).hat = 'cap'
  }
}

const step = (colour: string, build: (b: Blockly.Block) => void, tooltip?: MessageKey): Def => ({
  init() {
    build(this)
    this.setPreviousStatement(true, 'Step')
    this.setNextStatement(true, 'Step')
    this.setColour(colour)
    this.setInputsInline(true)
    if (tooltip) this.setTooltip(tr(tooltip))
  }
})

defs.sql_show = step(COLOR.query, (b) => {
  b.appendValueInput('EXPR').setCheck(VALUE).appendField(tr('bShow'))
  b.appendDummyInput().appendField(tr('bAs')).appendField(new Blockly.FieldTextInput(''), 'ALIAS')
}, 'bShowTip')
defs.sql_show_all = step(COLOR.query, (b) => b.appendDummyInput().appendField(tr('bShowAll')))
defs.sql_distinct = step(COLOR.query, (b) => b.appendDummyInput().appendField(tr('bDistinct')), 'bDistinctTip')
defs.sql_where = step(COLOR.filter, (b) => b.appendValueInput('COND').setCheck(BOOL).appendField(tr('bWhere')), 'bWhereTip')
defs.sql_group = step(COLOR.group, (b) => b.appendValueInput('EXPR').setCheck(VALUE).appendField(tr('bGroup')), 'bGroupTip')
defs.sql_having = step(COLOR.group, (b) => b.appendValueInput('COND').setCheck(BOOL).appendField(tr('bHaving')), 'bHavingTip')
defs.sql_order = step(COLOR.sort, (b) => {
  b.appendValueInput('EXPR').setCheck(VALUE).appendField(tr('bSort'))
  b.appendDummyInput().appendField(menu([['bAsc', 'ASC'], ['bDesc', 'DESC']]), 'DIR')
})
defs.sql_limit = step(COLOR.sort, (b) => {
  b.appendDummyInput().appendField(tr('bFirst')).appendField(new Blockly.FieldNumber(10, 0, undefined, 1), 'N').appendField(tr('bRows'))
})
defs.sql_join = step(COLOR.join, (b) => {
  b.appendDummyInput()
    .appendField('🔗')
    .appendField(tableField(), 'TABLE')
    .appendField(menu([['bJoinInner', 'INNER'], ['bJoinLeft', 'LEFT']]), 'TYPE')
  b.appendValueInput('COND').setCheck(BOOL).appendField(tr('bOn'))
}, 'bJoinTip')

// ── values ──────────────────────────────────────────────────
const value = (colour: string, build: (b: Blockly.Block) => void, output = VALUE, tooltip?: MessageKey): Def => ({
  init() {
    build(this)
    this.setOutput(true, output)
    this.setColour(colour)
    this.setInputsInline(true)
    if (tooltip) this.setTooltip(tr(tooltip))
  }
})

defs.sql_col = value(COLOR.column, (b) => b.appendDummyInput().appendField(dynamic(columnOptions), 'COL'))
defs.sql_text = value(COLOR.text, (b) => b.appendDummyInput().appendField(new Blockly.FieldTextInput(''), 'V'))
defs.sql_num = value(COLOR.value, (b) => b.appendDummyInput().appendField(new Blockly.FieldNumber(0), 'V'))
defs.sql_count_all = value(COLOR.group, (b) => b.appendDummyInput().appendField(tr('bRowCount')))
defs.sql_agg = value(COLOR.group, (b) => {
  b.appendDummyInput().appendField(
    menu([
      ['bSum', 'SUM'], ['bAvg', 'AVG'], ['bMin', 'MIN'], ['bMax', 'MAX'], ['bCount', 'COUNT'], ['bCountDistinct', 'COUNT_DISTINCT'],
      ['bList', 'LIST']
    ]),
    'FN'
  )
  b.appendValueInput('ARG').setCheck(VALUE)
})

/** "[function ▾] (value)" */
const fnBlock = (colour: string, items: [MessageKey, string][]): Def =>
  value(colour, (b) => {
    b.appendDummyInput().appendField(menu(items), 'FN')
    b.appendValueInput('ARG').setCheck(VALUE)
  })

// ── text ────────────────────────────────────────────────────
defs.sql_text_fn = fnBlock(COLOR.text, [
  ['bUpper', 'UPPER'], ['bLower', 'LOWER'], ['bLength', 'LENGTH'], ['bTrim', 'TRIM'], ['bLtrim', 'LTRIM'], ['bRtrim', 'RTRIM']
])
defs.sql_concat = value(COLOR.text, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('B').setCheck(VALUE).appendField(tr('bConcat'))
})
defs.sql_replace = value(COLOR.text, (b) => {
  b.appendValueInput('A').setCheck(VALUE).appendField(tr('bReplaceIn'))
  b.appendValueInput('FIND').setCheck(VALUE).appendField(tr('bReplaceFind'))
  b.appendValueInput('TO').setCheck(VALUE).appendField(tr('bReplaceTo'))
  if (ko()) b.appendDummyInput().appendField(tr('bReplaceTail'))
})
defs.sql_slice = value(COLOR.text, (b) => {
  const side = menu([['bSliceLeft', 'left'], ['bSliceRight', 'right']])
  if (ko()) {
    b.appendValueInput('A').setCheck(VALUE)
    b.appendValueInput('N').setCheck(VALUE).appendField(tr('bOf')).appendField(side, 'SIDE')
    b.appendDummyInput().appendField(tr('bChars'))
  } else {
    b.appendValueInput('N').setCheck(VALUE).appendField(side, 'SIDE')
    b.appendValueInput('A').setCheck(VALUE).appendField(tr('bChars'))
  }
})
defs.sql_substr = value(COLOR.text, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('START').setCheck(VALUE).appendField(tr('bSubFrom'))
  b.appendValueInput('LEN').setCheck(VALUE).appendField(tr('bSubLen'))
  if (ko()) b.appendDummyInput().appendField(tr('bSubTail'))
})
defs.sql_find = value(COLOR.text, (b) => {
  if (ko()) {
    b.appendValueInput('A').setCheck(VALUE)
    b.appendValueInput('B').setCheck(VALUE).appendField(tr('bFindIn'))
    b.appendDummyInput().appendField(tr('bFindTail'))
  } else {
    b.appendValueInput('B').setCheck(VALUE).appendField(tr('bFindOf'))
    b.appendValueInput('A').setCheck(VALUE).appendField(tr('bFindIn'))
  }
})

// ── numbers ─────────────────────────────────────────────────
defs.sql_arith = value(COLOR.value, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('B')
    .setCheck(VALUE)
    .appendField(new Blockly.FieldDropdown([['+', '+'], ['−', '-'], ['×', '*'], ['÷', '/'], ['%', '%'], ['^', '^']]), 'OP')
})
defs.sql_num_fn = fnBlock(COLOR.value, [['bAbs', 'ABS'], ['bCeil', 'CEIL'], ['bFloor', 'FLOOR'], ['bSqrt', 'SQRT']])
defs.sql_round = value(COLOR.value, (b) => {
  b.appendValueInput('ARG').setCheck(VALUE).appendField(tr('bRound'))
  b.appendDummyInput().appendField(tr('bRoundTo')).appendField(new Blockly.FieldNumber(0, 0, 10, 1), 'D').appendField(tr('bDecimals'))
})

// ── dates ───────────────────────────────────────────────────
defs.sql_today = value(COLOR.date, (b) => b.appendDummyInput().appendField(tr('bToday')))
defs.sql_now = value(COLOR.date, (b) => b.appendDummyInput().appendField(tr('bNow')))
defs.sql_date_part = fnBlock(COLOR.date, [
  ['bYear', 'YEAR'], ['bMonth', 'MONTH'], ['bDay', 'DAY'], ['bYearMonth', 'YEARMONTH'], ['bQuarter', 'QUARTER'],
  ['bWeekday', 'WEEKDAY'], ['bHour', 'HOUR'], ['bDateOnly', 'DATE']
])
defs.sql_date_add = value(COLOR.date, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('N').setCheck(VALUE).appendField('+')
  b.appendDummyInput().appendField(menu([['bDays', 'day'], ['bMonths', 'month'], ['bYears', 'year']]), 'UNIT')
})
defs.sql_date_diff = value(COLOR.date, (b) => {
  b.appendValueInput('A').setCheck(VALUE).appendField(tr('bDiffFrom'))
  b.appendValueInput('B').setCheck(VALUE).appendField(tr('bDiffTo'))
  if (ko()) b.appendDummyInput().appendField(tr('bDiffTail'))
})

// ── rank & window ───────────────────────────────────────────
const windowTail = (b: Blockly.Block, required: boolean): void => {
  b.appendValueInput('ORDER').setCheck(VALUE).appendField(tr('bRankBy'))
  b.appendDummyInput().appendField(menu(required ? [['bDesc', 'DESC'], ['bAsc', 'ASC']] : [['bAsc', 'ASC'], ['bDesc', 'DESC']]), 'DIR')
  b.appendValueInput('PART').setCheck(VALUE).appendField(tr('bPer'))
}
defs.sql_rank = value(COLOR.rank, (b) => {
  b.appendDummyInput().appendField(menu([['bRank', 'RANK'], ['bRowNumber', 'ROW_NUMBER'], ['bDenseRank', 'DENSE_RANK']]), 'FN')
  windowTail(b, true)
}, VALUE, 'bRankTip')
defs.sql_window = value(COLOR.rank, (b) => {
  const fn = menu([['bRunSum', 'RUNSUM'], ['bPrev', 'PREV'], ['bNext', 'NEXT'], ['bPct', 'PCT']])
  if (ko()) {
    b.appendValueInput('ARG').setCheck(VALUE)
    b.appendDummyInput().appendField(tr('bOf')).appendField(fn, 'FN')
  } else {
    b.appendDummyInput().appendField(fn, 'FN')
    b.appendValueInput('ARG').setCheck(VALUE).appendField(tr('bOf'))
  }
  windowTail(b, false)
}, VALUE, 'bWindowTip')

// ── logic ───────────────────────────────────────────────────
defs.sql_coalesce = value(COLOR.logic, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('B').setCheck(VALUE).appendField(tr('bIfEmpty'))
})
defs.sql_case = value(COLOR.logic, (b) => {
  b.appendValueInput('COND').setCheck(BOOL).appendField(tr('bIf'))
  b.appendValueInput('THEN').setCheck(VALUE).appendField(tr('bThen'))
  b.appendValueInput('ELSE').setCheck(VALUE).appendField(tr('bElse'))
})
defs.sql_cast = fnBlock(COLOR.logic, [['bToNumber', 'TO_NUMBER'], ['bToText', 'TO_TEXT']])
defs.sql_raw = value(COLOR.logic, (b) => b.appendDummyInput().appendField('SQL').appendField(new Blockly.FieldTextInput(''), 'SQL'), VALUE, 'bRawTip')

/** Superseded by the text / number / date blocks; kept so saved workspaces still load. */
defs.sql_fn = fnBlock(COLOR.value, [
  ['bYear', 'YEAR'], ['bMonth', 'MONTH'], ['bDay', 'DAY'], ['bLength', 'LENGTH'], ['bUpper', 'UPPER'], ['bLower', 'LOWER'],
  ['bTrim', 'TRIM'], ['bAbs', 'ABS']
])

// ── conditions (word order differs between English and Korean) ──
defs.sql_cmp = value(COLOR.filter, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('B')
    .setCheck(VALUE)
    .appendField(new Blockly.FieldDropdown([['=', '='], ['≠', '!='], ['>', '>'], ['≥', '>='], ['<', '<'], ['≤', '<=']]), 'OP')
}, BOOL)
defs.sql_logic = value(COLOR.filter, (b) => {
  b.appendValueInput('A').setCheck(BOOL)
  b.appendValueInput('B').setCheck(BOOL).appendField(menu([['bAnd', 'AND'], ['bOr', 'OR']]), 'OP')
}, BOOL)
defs.sql_not = value(COLOR.filter, (b) => {
  if (ko()) {
    b.appendValueInput('A').setCheck(BOOL)
    b.appendDummyInput().appendField(tr('bNot'))
  } else {
    b.appendValueInput('A').setCheck(BOOL).appendField(tr('bNot'))
  }
}, BOOL)
defs.sql_like = value(COLOR.filter, (b) => {
  const mode = menu([['bContains', 'contains'], ['bStarts', 'starts'], ['bEnds', 'ends']])
  const text = new Blockly.FieldTextInput('')
  b.appendValueInput('A').setCheck(VALUE)
  if (ko()) b.appendDummyInput().appendField('에').appendField(text, 'TEXT').appendField(mode, 'MODE')
  else b.appendDummyInput().appendField(mode, 'MODE').appendField(text, 'TEXT')
}, BOOL)
defs.sql_isnull = value(COLOR.filter, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendDummyInput().appendField(menu([['bIsEmpty', 'NULL'], ['bNotEmpty', 'NOTNULL']]), 'MODE')
}, BOOL)
defs.sql_between = value(COLOR.filter, (b) => {
  b.appendValueInput('A').setCheck(VALUE)
  b.appendValueInput('LO').setCheck(VALUE).appendField(tr('bBetween'))
  b.appendValueInput('HI').setCheck(VALUE).appendField(tr('bBetweenAnd'))
  if (ko()) b.appendDummyInput().appendField('사이')
}, BOOL)
defs.sql_in = value(COLOR.filter, (b) => {
  const list = new Blockly.FieldTextInput('a, b')
  b.appendValueInput('A').setCheck(VALUE)
  if (ko()) b.appendDummyInput().appendField('가').appendField(list, 'LIST').appendField(tr('bOneOf'))
  else b.appendDummyInput().appendField(tr('bOneOf')).appendField(list, 'LIST')
}, BOOL)

let registered = false
export function registerBlocks(): void {
  if (registered) return
  registered = true
  for (const [name, def] of Object.entries(defs)) Blockly.Blocks[name] = def
}
