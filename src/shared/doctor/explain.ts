import { t, type MessageKey } from '../i18n'
import { analyze, clause, splitTopLevel, type Analysis } from './analyze'
import { splitStatements, type Token } from './tokenizer'

export interface ExplainStep {
  /** short label of the clause, e.g. "FROM" */
  tag: string
  /** plain-language sentence; text inside `backticks` is code */
  text: string
}

export interface Explanation {
  summary: string
  steps: ExplainStep[]
}

const clip = (s: string, max = 70): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

const JOIN_KIND: Record<string, MessageKey> = {
  JOIN: 'eJoinInner',
  'INNER JOIN': 'eJoinInner',
  'LEFT JOIN': 'eJoinLeft',
  'LEFT OUTER JOIN': 'eJoinLeft',
  'RIGHT JOIN': 'eJoinRight',
  'RIGHT OUTER JOIN': 'eJoinRight',
  'FULL JOIN': 'eJoinFull',
  'FULL OUTER JOIN': 'eJoinFull',
  'CROSS JOIN': 'eJoinCross',
  'NATURAL JOIN': 'eJoinNatural'
}

const OBJECT_KIND: Record<string, MessageKey> = { TABLE: 'eTable', VIEW: 'eView', INDEX: 'eIndex', TRIGGER: 'eTrigger' }

export function explain(sql: string): Explanation[] {
  return splitStatements(sql).map((s) => explainOne(s.text))
}

function explainOne(text: string): Explanation {
  const a = analyze(text)
  const src = (ts: Token[]): string => (ts.length ? clip(text.slice(ts[0].start, ts[ts.length - 1].end)) : '')
  const table = a.tables[0]?.name ?? '?'
  const where = clause(a, 'WHERE')
  const whereStep = (): ExplainStep =>
    where ? { tag: 'WHERE', text: t('eOnlyRows', { cond: src(where.body) }) } : { tag: 'WHERE', text: t('eAllRows') }
  const steps: ExplainStep[] = []

  switch (a.kind) {
    case 'SELECT':
      return { summary: t('eSelect'), steps: selectSteps(a, src) }
    case 'INSERT': {
      const values = clause(a, 'VALUES')
      if (values) steps.push({ tag: 'VALUES', text: t('eRowsAdded', { n: splitTopLevel(values.body).length }) })
      if (clause(a, 'SELECT')) steps.push(...selectSteps(a, src))
      return { summary: t('eInsert', { table }), steps }
    }
    case 'UPDATE': {
      for (const item of splitTopLevel(clause(a, 'SET')?.body ?? [])) steps.push({ tag: 'SET', text: `\`${src(item)}\`` })
      steps.push(whereStep())
      return { summary: t('eUpdate', { table }), steps }
    }
    case 'DELETE':
      steps.push(whereStep())
      return { summary: t('eDelete', { table }), steps }
    case 'CREATE': {
      const what = a.tokens.find((x) => x.upper in OBJECT_KIND)?.upper
      if (clause(a, 'SELECT')) steps.push(...selectSteps(a, src))
      return { summary: t('eCreate', { what: t(what ? OBJECT_KIND[what] : 'eObject') }), steps }
    }
    case 'DROP':
      return { summary: t('eDrop'), steps }
    case 'ALTER':
      return { summary: t('eAlter'), steps }
    default:
      return { summary: a.kind || t('eEmpty'), steps }
  }
}

function selectSteps(a: Analysis, src: (ts: Token[]) => string): ExplainStep[] {
  const steps: ExplainStep[] = []
  const from = clause(a, 'FROM')
  if (from) {
    const parts = splitTopLevel(from.body)
    steps.push({
      tag: 'FROM',
      text: parts.length > 1 ? t('eFromCross', { list: parts.map((p) => `\`${src(p)}\``).join(', ') }) : t('eFrom', { src: src(from.body) })
    })
  }
  for (const j of a.joins) {
    const how = t(JOIN_KIND[j.type] ?? 'eJoinAny')
    const cond = j.condition.length ? ` · \`${src(j.condition)}\`` : ''
    steps.push({ tag: 'JOIN', text: t('eJoin', { table: j.table?.name ?? t('eSubquery'), how, cond }) })
  }
  const where = clause(a, 'WHERE')
  if (where) steps.push({ tag: 'WHERE', text: t('eOnlyRows', { cond: src(where.body) }) })
  const group = clause(a, 'GROUP BY')
  if (group) steps.push({ tag: 'GROUP BY', text: t('eGroup', { expr: src(group.body) }) })
  const having = clause(a, 'HAVING')
  if (having) steps.push({ tag: 'HAVING', text: t('eHaving', { cond: src(having.body) }) })
  const select = clause(a, 'SELECT')
  if (select) {
    const distinct = select.body[0]?.upper === 'DISTINCT'
    const body = distinct ? select.body.slice(1) : select.body
    const all = body.length === 1 && body[0].value === '*'
    steps.push({ tag: 'SELECT', text: (all ? t('eShowAll') : t('eShow', { cols: src(body) })) + (distinct ? t('eDistinct') : '') })
  }
  const order = clause(a, 'ORDER BY')
  if (order) {
    const items = splitTopLevel(order.body).map((it) => {
      const last = it[it.length - 1]?.upper
      const core = last === 'DESC' || last === 'ASC' ? it.slice(0, -1) : it
      return t(last === 'DESC' ? 'eDescItem' : 'eAscItem', { expr: src(core) })
    })
    steps.push({ tag: 'ORDER BY', text: t('eSorted', { items: items.join(', ') }) })
  }
  const limit = clause(a, 'LIMIT')
  if (limit) steps.push({ tag: 'LIMIT', text: t('eLimit', { n: src(limit.body) }) })
  const offset = clause(a, 'OFFSET')
  if (offset) steps.push({ tag: 'OFFSET', text: t('eOffset', { n: src(offset.body) }) })
  if (a.clauses.some((c) => ['UNION', 'INTERSECT', 'EXCEPT'].includes(c.name))) steps.push({ tag: 'UNION', text: t('eUnion') })
  return steps
}
