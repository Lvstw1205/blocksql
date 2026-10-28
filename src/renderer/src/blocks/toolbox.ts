import type * as Blockly from 'blockly/core'
import { t } from '@shared/i18n'
import { COLOR, SEP, blockSchema } from './defs'

type Item = Blockly.utils.toolbox.FlyoutItemInfo
const text = (v = ''): object => ({ shadow: { type: 'sql_text', fields: { V: v } } })
const num = (v = 0): object => ({ shadow: { type: 'sql_num', fields: { V: v } } })
const block = (type: string, extra: Record<string, unknown> = {}): Item => ({ kind: 'block', type, ...extra }) as Item

export const COLUMNS_CATEGORY = 'COLUMNS'

/** Built on demand so category names follow the current language. */
export const buildToolbox = (): Blockly.utils.toolbox.ToolboxDefinition => ({
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: t('catView'),
      colour: COLOR.query,
      contents: [
        block('sql_query'),
        block('sql_show'),
        block('sql_show_all'),
        block('sql_distinct'),
        block('sql_limit')
      ]
    },
    { kind: 'category', name: t('catColumns'), colour: COLOR.column, custom: COLUMNS_CATEGORY },
    {
      kind: 'category',
      name: t('catFilter'),
      colour: COLOR.filter,
      contents: [
        block('sql_where', { inputs: { COND: { block: { type: 'sql_cmp', inputs: { B: text() } } } } }),
        block('sql_cmp', { inputs: { B: text() } }),
        block('sql_like'),
        block('sql_isnull'),
        block('sql_between', { inputs: { LO: text('1'), HI: text('10') } }),
        block('sql_in'),
        block('sql_logic'),
        block('sql_not')
      ]
    },
    {
      kind: 'category',
      name: t('catGroup'),
      colour: COLOR.group,
      contents: [
        block('sql_group'),
        block('sql_show', { inputs: { EXPR: { block: { type: 'sql_count_all' } } }, fields: { ALIAS: t('countAlias') } }),
        block('sql_count_all'),
        block('sql_agg'),
        block('sql_agg', { fields: { FN: 'LIST' } }),
        block('sql_having', { inputs: { COND: { block: { type: 'sql_cmp', fields: { OP: '>' }, inputs: { A: { block: { type: 'sql_count_all' } }, B: text('1') } } } } })
      ]
    },
    {
      kind: 'category',
      name: t('catSort'),
      colour: COLOR.sort,
      contents: [block('sql_order'), block('sql_order', { fields: { DIR: 'DESC' } }), block('sql_limit')]
    },
    { kind: 'category', name: t('catJoin'), colour: COLOR.join, contents: [block('sql_join')] },
    {
      kind: 'category',
      name: t('catText'),
      colour: COLOR.text,
      contents: [
        block('sql_text'),
        block('sql_text_fn'),
        block('sql_concat', { inputs: { B: text(' ') } }),
        block('sql_replace', { inputs: { FIND: text('-'), TO: text('') } }),
        block('sql_slice', { inputs: { N: num(3) } }),
        block('sql_substr', { inputs: { START: num(1), LEN: num(3) } }),
        block('sql_find', { inputs: { B: text('@') } })
      ]
    },
    {
      kind: 'category',
      name: t('catNumber'),
      colour: COLOR.value,
      contents: [
        block('sql_num'),
        block('sql_arith', { inputs: { A: num(), B: num(1) } }),
        block('sql_round'),
        block('sql_num_fn')
      ]
    },
    {
      kind: 'category',
      name: t('catDate'),
      colour: COLOR.date,
      contents: [
        block('sql_today'),
        block('sql_now'),
        block('sql_date_part'),
        block('sql_date_part', { fields: { FN: 'YEARMONTH' } }),
        block('sql_date_add', { inputs: { N: num(7) } }),
        block('sql_date_diff', { inputs: { B: { shadow: { type: 'sql_today' } } } })
      ]
    },
    {
      kind: 'category',
      name: t('catRank'),
      colour: COLOR.rank,
      contents: [
        block('sql_rank'),
        block('sql_window'),
        block('sql_window', { fields: { FN: 'PCT' } })
      ]
    },
    {
      kind: 'category',
      name: t('catLogic'),
      colour: COLOR.logic,
      contents: [
        block('sql_case', { inputs: { THEN: text(t('yes')), ELSE: text(t('no')) } }),
        block('sql_coalesce', { inputs: { B: text('0') } }),
        block('sql_cast'),
        block('sql_raw')
      ]
    }
  ]
})

/** One ready-made column block per column of the tables in play (like Scratch variables). */
export function columnsFlyout(scope: string[]): Item[] {
  const items: Item[] = []
  for (const t of scope) {
    const info = blockSchema.table(t)
    if (!info) continue
    if (scope.length > 1) items.push({ kind: 'label', text: t } as Item)
    for (const c of info.columns) items.push(block('sql_col', { fields: { COL: t + SEP + c.name } }))
  }
  if (!items.length) items.push({ kind: 'label', text: t('pickTableFirst') } as Item)
  return items
}
