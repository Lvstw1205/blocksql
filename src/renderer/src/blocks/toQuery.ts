import type * as Blockly from 'blockly/core'
import type { BlockQuery, Node, Step } from '@shared/blockquery'
import { SEP } from './defs'

type B = Blockly.Block | null

const field = (b: Blockly.Block, name: string): string => String(b.getFieldValue(name) ?? '')
const input = (b: Blockly.Block, name: string): B => {
  const t = b.getInputTargetBlock(name)
  return t && t.isEnabled() ? t : null
}

export function toNode(b: B): Node | null {
  if (!b) return null
  const n = (name: string): Node | null => toNode(input(b, name))
  switch (b.type) {
    case 'sql_col': {
      const [table, name] = field(b, 'COL').split(SEP)
      return name ? { k: 'col', table, name } : null
    }
    case 'sql_text':
      return { k: 'text', v: field(b, 'V') }
    case 'sql_num':
      return { k: 'num', v: field(b, 'V') }
    case 'sql_today':
      return { k: 'today' }
    case 'sql_now':
      return { k: 'now' }
    case 'sql_count_all':
      return { k: 'agg', fn: 'COUNT', arg: null }
    case 'sql_agg': {
      const fn = field(b, 'FN') as 'SUM'
      const arg = n('ARG')
      // "count" with nothing plugged in means "count rows"
      if (fn === ('COUNT' as string) && !arg) return { k: 'agg', fn: 'COUNT', arg: null }
      return { k: 'agg', fn, arg }
    }
    case 'sql_arith':
      return { k: 'arith', op: field(b, 'OP') as '+', a: n('A'), b: n('B') }
    case 'sql_fn':
    case 'sql_text_fn':
    case 'sql_num_fn':
    case 'sql_date_part':
    case 'sql_cast':
      return { k: 'fn', fn: field(b, 'FN') as 'UPPER', arg: n('ARG') }
    case 'sql_round':
      return { k: 'fn', fn: 'ROUND', arg: n('ARG'), digits: Number(field(b, 'D')) || 0 }
    case 'sql_concat':
      return { k: 'concat', a: n('A'), b: n('B') }
    case 'sql_replace':
      return { k: 'replace', a: n('A'), find: n('FIND'), to: n('TO') }
    case 'sql_slice':
      return { k: 'slice', side: field(b, 'SIDE') as 'left', a: n('A'), n: n('N') }
    case 'sql_substr':
      return { k: 'substr', a: n('A'), start: n('START'), len: n('LEN') }
    case 'sql_find':
      return { k: 'find', a: n('A'), b: n('B') }
    case 'sql_date_add':
      return { k: 'dateAdd', a: n('A'), n: n('N'), unit: field(b, 'UNIT') as 'day' }
    case 'sql_date_diff':
      return { k: 'dateDiff', a: n('A'), b: n('B') }
    case 'sql_rank':
      return { k: 'rank', fn: field(b, 'FN') as 'RANK', order: n('ORDER'), dir: field(b, 'DIR') as 'DESC', part: n('PART') }
    case 'sql_window':
      return { k: 'window', fn: field(b, 'FN') as 'RUNSUM', arg: n('ARG'), order: n('ORDER'), dir: field(b, 'DIR') as 'ASC', part: n('PART') }
    case 'sql_coalesce':
      return { k: 'coalesce', a: n('A'), b: n('B') }
    case 'sql_case':
      return { k: 'case', cond: n('COND'), then: n('THEN'), else: n('ELSE') }
    case 'sql_raw':
      return { k: 'raw', sql: field(b, 'SQL') }
    case 'sql_cmp':
      return { k: 'cmp', op: field(b, 'OP') as '=', a: n('A'), b: n('B') }
    case 'sql_logic':
      return { k: 'logic', op: field(b, 'OP') as 'AND', a: n('A'), b: n('B') }
    case 'sql_not':
      return { k: 'not', a: n('A') }
    case 'sql_like':
      return { k: 'like', mode: field(b, 'MODE') as 'contains', a: n('A'), text: field(b, 'TEXT') }
    case 'sql_isnull':
      return { k: 'isnull', not: field(b, 'MODE') === 'NOTNULL', a: n('A') }
    case 'sql_between':
      return { k: 'between', a: n('A'), lo: n('LO'), hi: n('HI') }
    case 'sql_in':
      return { k: 'in', a: n('A'), list: field(b, 'LIST') }
    default:
      return null
  }
}

function toStep(b: Blockly.Block): Step | null {
  const n = (name: string): Node | null => toNode(input(b, name))
  switch (b.type) {
    case 'sql_show':
      return { k: 'show', expr: n('EXPR'), alias: field(b, 'ALIAS') }
    case 'sql_show_all':
      return { k: 'showAll' }
    case 'sql_distinct':
      return { k: 'distinct' }
    case 'sql_where':
      return { k: 'where', cond: n('COND') }
    case 'sql_join':
      return { k: 'join', type: field(b, 'TYPE') as 'LEFT', table: field(b, 'TABLE'), cond: n('COND') }
    case 'sql_group':
      return { k: 'group', expr: n('EXPR') }
    case 'sql_having':
      return { k: 'having', cond: n('COND') }
    case 'sql_order':
      return { k: 'order', expr: n('EXPR'), dir: field(b, 'DIR') as 'ASC' }
    case 'sql_limit':
      return { k: 'limit', n: Number(field(b, 'N')) || 0 }
    default:
      return null
  }
}

export function toQuery(root: Blockly.Block): BlockQuery {
  const steps: Step[] = []
  for (let s = root.getInputTargetBlock('STEPS'); s; s = s.getNextBlock()) {
    if (!s.isEnabled()) continue
    const step = toStep(s)
    if (step) steps.push(step)
  }
  return { table: field(root, 'TABLE'), steps }
}
