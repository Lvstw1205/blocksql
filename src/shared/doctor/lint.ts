import type { Dialect, TableInfo } from '../types'
import { quoteIdent } from '../sql'
import { analyze, clause, hasAggregate, splitTopLevel, unquote, type Analysis } from './analyze'
import { closest, distance } from './similar'
import { splitStatements, tokenize, type Token } from './tokenizer'
import { t as msg } from '../i18n'

export type Severity = 'error' | 'warning' | 'tip'

export interface TextEdit {
  from: number
  to: number
  insert: string
}

export interface Issue {
  severity: Severity
  code: string
  message: string
  from: number
  to: number
  fix?: { label: string; edits: TextEdit[] }
}

export interface LintContext {
  dialect: Dialect
  tables?: TableInfo[]
}

const TYPO_TARGETS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'JOIN', 'INSERT', 'INTO',
  'VALUES', 'UPDATE', 'DELETE', 'DISTINCT', 'BETWEEN'
]
const CLAUSE_WORDS = new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'JOIN', 'ON', 'SET', 'VALUES'])
const BUILTIN_WORDS = new Set(
  `CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP ROWID OID _ROWID_ EXCLUDED NEW OLD
  INTERVAL DATE TIME TIMESTAMP INTEGER INT TEXT VARCHAR CHAR REAL FLOAT NUMERIC DECIMAL BOOLEAN BIGINT
  SMALLINT DOUBLE PRECISION BLOB JSON JSONB UUID SERIAL SIGNED UNSIGNED YEAR MONTH DAY HOUR MINUTE SECOND
  WEEK QUARTER EPOCH ZONE LOCAL`
    .split(/\s+/)
)
const COMPARE = new Set(['=', '==', '<>', '!=', '<', '>', '<=', '>=', 'LIKE', 'ILIKE', 'IN'])

export function lint(sql: string, ctx: LintContext): Issue[] {
  const issues: Issue[] = []
  issues.push(...syntaxIssues(sql))
  for (const span of splitStatements(sql)) {
    const a = analyze(span.text)
    const found: Issue[] = []
    const add = (i: Issue): void => {
      found.push(i)
    }
    rules(a, span.text, ctx, add)
    for (const i of found) {
      i.from += span.start
      i.to += span.start
      i.fix?.edits.forEach((e) => {
        e.from += span.start
        e.to += span.start
      })
      issues.push(i)
    }
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, tip: 2 }
  return issues.sort((x, y) => order[x.severity] - order[y.severity] || x.from - y.from)
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text)
}

function syntaxIssues(sql: string): Issue[] {
  const out: Issue[] = []
  const stack: Token[] = []
  for (const t of tokenize(sql)) {
    if (t.unterminated) {
      const message = msg(t.type === 'comment' ? 'lUnterminatedComment' : t.type === 'string' ? 'lUnterminatedString' : 'lUnterminatedQuoted')
      out.push({ severity: 'error', code: 'unterminated', message, from: t.start, to: t.end })
    }
    if (t.value === '(' && t.type === 'punct') stack.push(t)
    if (t.value === ')' && t.type === 'punct') {
      if (!stack.pop()) out.push({ severity: 'error', code: 'paren', message: msg('lExtraParen'), from: t.start, to: t.end })
    }
  }
  for (const t of stack) out.push({ severity: 'error', code: 'paren', message: msg('lOpenParen'), from: t.start, to: t.end })
  return out
}

function rules(a: Analysis, text: string, ctx: LintContext, add: (i: Issue) => void): void {
  const tk = a.tokens
  if (!tk.length) return
  const first = tk[0]
  const last = tk[tk.length - 1]
  const has = (name: string): boolean => a.clauses.some((c) => c.name === name)
  const span = (from: Token, to: Token = from): Pick<Issue, 'from' | 'to'> => ({ from: from.start, to: to.end })

  // Dangerous writes
  if ((a.kind === 'UPDATE' || a.kind === 'DELETE') && !has('WHERE')) {
    add({
      severity: 'error',
      code: 'no-where',
      message: msg(a.kind === 'UPDATE' ? 'lUpdateNoWhere' : 'lDeleteNoWhere'),
      ...span(first)
    })
  }
  if (a.kind === 'DROP' || a.kind === 'TRUNCATE') {
    add({ severity: 'warning', code: 'destructive', message: msg('lDestructive'), ...span(first) })
  }

  // = NULL
  const setClause = clause(a, 'SET')
  tk.forEach((t, k) => {
    const nx = tk[k + 1]
    if (nx?.upper === 'NULL' && ['=', '==', '!=', '<>'].includes(t.value) && !setClause?.body.includes(t)) {
      const isNot = t.value === '!=' || t.value === '<>'
      add({
        severity: 'error',
        code: 'null-compare',
        message: msg('lNullCompare', { op: t.value }),
        ...span(t, nx),
        fix: {
          label: isNot ? 'IS NOT NULL' : 'IS NULL',
          edits: [{ from: t.start, to: nx.end, insert: isNot ? 'IS NOT NULL' : 'IS NULL' }]
        }
      })
    }
  })

  // Trailing / doubled commas
  tk.forEach((t, k) => {
    if (t.value !== ',') return
    const nx = tk[k + 1]
    if (!nx || nx.value === ')' || nx.value === ',' || (nx.type === 'keyword' && CLAUSE_WORDS.has(nx.upper))) {
      add({
        severity: 'error',
        code: 'trailing-comma',
        message: msg('lTrailingComma'),
        ...span(t),
        fix: { label: msg('lRemoveComma'), edits: [{ from: t.start, to: t.end, insert: '' }] }
      })
    }
  })

  // Keyword typos: SELEC, FORM, WHRE ...
  const known = knownNames(ctx, a)
  tk.forEach((t, k) => {
    if (t.type !== 'ident' || t.value.length < 4 || known.has(t.value.toLowerCase())) return
    const prev = tk[k - 1]
    const nx = tk[k + 1]
    const atStart = k === 0
    const betweenNames =
      prev && nx && prev.value !== '.' && nx.value !== '.' && nx.value !== '(' &&
      (prev.type === 'ident' || prev.type === 'quoted' || prev.type === 'number' || prev.type === 'string' || prev.value === ')' || prev.value === '*') &&
      (nx.type === 'ident' || nx.type === 'quoted' || nx.type === 'number' || nx.type === 'string' || nx.value === '*')
    if (!atStart && !betweenNames) return
    const target = TYPO_TARGETS.find((kw) => distance(t.upper, kw) === 1)
    if (target) {
      add({
        severity: 'error',
        code: 'typo',
        message: msg('lTypo', { word: t.value, target }),
        ...span(t),
        fix: { label: target, edits: [{ from: t.start, to: t.end, insert: target }] }
      })
    }
  })

  // JOIN without ON / cartesian product
  for (const j of a.joins) {
    if (!j.hasCondition && j.table) {
      add({ severity: 'error', code: 'join-no-on', message: msg('lJoinNoOn', { table: j.table.name }), ...span(j.table.token) })
    }
  }
  if (a.commaSources > 1 && !has('WHERE')) {
    add({ severity: 'warning', code: 'cartesian', message: msg('lCartesian'), ...span(first) })
  }

  // Aggregates and GROUP BY
  if (a.kind === 'SELECT' || a.kind === 'WITH') groupByRules(a, text, ctx, add)

  // Leading wildcard LIKE
  tk.forEach((t, k) => {
    const nx = tk[k + 1]
    if ((t.upper === 'LIKE' || t.upper === 'ILIKE') && nx?.type === 'string' && nx.value.startsWith("'%") && nx.value.length > 3) {
      add({ severity: 'tip', code: 'like-leading', message: msg('lLikeLeading'), ...span(t, nx) })
    }
  })

  // NOT IN (SELECT ...)
  tk.forEach((t, k) => {
    if (t.upper === 'NOT' && tk[k + 1]?.upper === 'IN' && tk[k + 2]?.value === '(' && tk[k + 3]?.upper === 'SELECT') {
      add({ severity: 'tip', code: 'not-in-null', message: msg('lNotInNull'), ...span(t, tk[k + 1]) })
    }
  })

  // AND / OR precedence
  const where = clause(a, 'WHERE')
  if (where) {
    let depth = 0
    let and = false
    let or = false
    let between = false
    for (const t of where.body) {
      if (t.value === '(') depth++
      if (t.value === ')') depth--
      if (depth !== 0) continue
      if (t.upper === 'BETWEEN') between = true
      else if (t.upper === 'AND') {
        if (between) between = false
        else and = true
      } else if (t.upper === 'OR') or = true
    }
    if (and && or) {
      add({ severity: 'warning', code: 'and-or', message: msg('lAndOr'), ...span(where.body[0], where.body[where.body.length - 1]) })
    }
  }

  // String in double quotes
  tk.forEach((t, k) => {
    const prev = tk[k - 1]
    if (t.type !== 'quoted' || !t.value.startsWith('"') || !prev || !COMPARE.has(prev.upper)) return
    if (known.has(unquote(t).toLowerCase())) return
    const inner = unquote(t).replace(/'/g, "''")
    add({
      severity: ctx.dialect === 'mysql' ? 'tip' : 'error',
      code: 'double-quote-string',
      message: msg('lDoubleQuote'),
      ...span(t),
      fix: { label: `'${unquote(t)}'`, edits: [{ from: t.start, to: t.end, insert: `'${inner}'` }] }
    })
  })

  // Schema-aware checks
  if (ctx.tables?.length) schemaRules(a, ctx, add)

  // SELECT * and missing LIMIT
  if (a.kind === 'SELECT' && has('FROM')) {
    const sel = clause(a, 'SELECT')!
    const star = sel.body.find((t) => t.value === '*')
    const single = a.tables.length === 1 ? findTable(ctx, a.tables[0].name) : undefined
    if (star && sel.body.length <= 2) {
      add({
        severity: 'tip',
        code: 'select-star',
        message: msg('lSelectStar'),
        ...span(star),
        fix: single
          ? { label: msg('lExpandStar'), edits: [{ from: star.start, to: star.end, insert: single.columns.map((c) => quoteIdent(c.name, ctx.dialect)).join(', ') }] }
          : undefined
      })
    }
    const aggregateOnly = !has('GROUP BY') && a.selectItems.length > 0 && a.selectItems.every(hasAggregate)
    if (!has('LIMIT') && !has('FETCH') && !aggregateOnly && !has('UNION')) {
      add({
        severity: 'tip',
        code: 'no-limit',
        message: msg('lNoLimit'),
        ...span(last),
        fix: { label: 'LIMIT 100', edits: [{ from: text.length, to: text.length, insert: '\nLIMIT 100' }] }
      })
    }
  }
}

function groupByRules(a: Analysis, text: string, _ctx: LintContext, add: (i: Issue) => void): void {
  if (a.tokens.some((t) => t.upper === 'OVER')) return
  const items = a.selectItems
  if (!items.some(hasAggregate)) return
  const plain = items.filter((it) => !hasAggregate(it) && it.some((t) => t.type === 'ident' || t.type === 'quoted') && it[0].value !== '*')
  if (!plain.length) return
  const expr = (it: Token[]): Token[] => {
    // drop "AS alias" / implicit alias
    const asIdx = it.findIndex((t) => t.upper === 'AS')
    if (asIdx > 0) return it.slice(0, asIdx)
    if (it.length > 1 && (it[it.length - 1].type === 'ident' || it[it.length - 1].type === 'quoted') && it[it.length - 2].value !== '.') return it.slice(0, -1)
    return it
  }
  const srcText = (ts: Token[]): string => text.slice(ts[0].start, ts[ts.length - 1].end)
  const norm = (s: string): string => s.replace(/\s+/g, '').replace(/["`]/g, '').toLowerCase()
  const group = clause(a, 'GROUP BY')
  if (!group) {
    const exprs = plain.map((it) => srcText(expr(it)))
    const before = a.clauses.find((c) => ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'].includes(c.name))
    const at = before ? before.head[0].start : text.length
    const insert = before ? `GROUP BY ${exprs.join(', ')}\n` : `\nGROUP BY ${exprs.join(', ')}`
    add({
      severity: 'error',
      code: 'missing-group-by',
      message: msg('lMissingGroupBy'),
      from: plain[0][0].start,
      to: plain[0][plain[0].length - 1].end,
      fix: { label: msg('lAddGroupBy'), edits: [{ from: at, to: at, insert }] }
    })
    return
  }
  const grouped = new Set(splitTopLevel(group.body).map((g) => norm(srcText(g))))
  for (const it of plain) {
    const e = norm(srcText(expr(it)))
    const bare = e.includes('.') ? e.slice(e.lastIndexOf('.') + 1) : e
    const ok = grouped.has(e) || [...grouped].some((g) => g === bare || g.endsWith('.' + bare) || /^\d+$/.test(g))
    if (!ok) {
      add({
        severity: 'warning',
        code: 'not-grouped',
        message: msg('lNotGrouped', { expr: srcText(expr(it)) }),
        from: it[0].start,
        to: it[it.length - 1].end
      })
    }
  }
}

function findTable(ctx: LintContext, name: string): TableInfo | undefined {
  const n = name.toLowerCase()
  return ctx.tables?.find((t) => t.name.toLowerCase() === n || t.name.toLowerCase().endsWith('.' + n))
}

function knownNames(ctx: LintContext, a: Analysis): Set<string> {
  const s = new Set<string>([...a.aliases, ...a.ctes])
  for (const t of ctx.tables ?? []) {
    s.add(t.name.toLowerCase())
    for (const c of t.columns) s.add(c.name.toLowerCase())
  }
  for (const t of a.tables) s.add(t.name.toLowerCase())
  return s
}

function schemaRules(a: Analysis, ctx: LintContext, add: (i: Issue) => void): void {
  const tableNames = ctx.tables!.map((t) => t.name)
  const resolved = new Map<string, TableInfo>()
  let allKnown = !a.hasSubquerySource
  for (const ref of a.tables) {
    const lower = ref.name.toLowerCase()
    if (a.ctes.includes(lower)) {
      allKnown = false
      continue
    }
    const info = findTable(ctx, ref.name)
    if (!info) {
      allKnown = false
      const guess = closest(ref.name, tableNames)
      add({
        severity: 'error',
        code: 'unknown-table',
        message: msg('lUnknownTable', { name: ref.name }),
        from: ref.token.start,
        to: ref.token.end,
        fix: guess ? { label: guess, edits: [{ from: ref.token.start, to: ref.token.end, insert: quoteIdent(guess, ctx.dialect) }] } : undefined
      })
      continue
    }
    resolved.set(lower, info)
    resolved.set(info.name.toLowerCase(), info)
    if (ref.alias) resolved.set(ref.alias.toLowerCase(), info)
  }
  if (!allKnown || !resolved.size || !['SELECT', 'UPDATE', 'DELETE', 'INSERT'].includes(a.kind)) return

  const used = [...new Set(resolved.values())]
  const allColumns = new Set(used.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())))
  const skip = new Set<string>([...resolved.keys(), ...a.aliases])
  const tk = a.tokens
  const refTokens = new Set(a.tables.map((t) => t.token))
  const report = (t: Token, candidates: string[], scope?: string): void => {
    const guess = closest(unquote(t), candidates)
    add({
      severity: 'error',
      code: 'unknown-column',
      message: scope ? msg('lUnknownColumnIn', { table: scope, name: unquote(t) }) : msg('lUnknownColumn', { name: unquote(t) }),
      from: t.start,
      to: t.end,
      fix: guess ? { label: guess, edits: [{ from: t.start, to: t.end, insert: quoteIdent(guess, ctx.dialect) }] } : undefined
    })
  }
  tk.forEach((t, k) => {
    if (t.type !== 'ident' && !(t.type === 'quoted' && ctx.dialect !== 'mysql')) return
    if (refTokens.has(t)) return
    const prev = tk[k - 1]
    const nx = tk[k + 1]
    const name = unquote(t).toLowerCase()
    if (nx?.value === '(' || prev?.upper === 'AS') return
    if (nx?.value === '.') return // qualifier, checked below
    if (prev?.value === '.') {
      const owner = tk[k - 2] ? unquote(tk[k - 2]).toLowerCase() : ''
      const info = resolved.get(owner)
      if (info && !info.columns.some((c) => c.name.toLowerCase() === name)) report(t, info.columns.map((c) => c.name), info.name)
      return
    }
    if (allColumns.has(name) || skip.has(name) || BUILTIN_WORDS.has(t.upper)) return
    if (t.type === 'quoted' && prev && COMPARE.has(prev.upper)) return // reported as a string mistake
    // part of a multi-word table ref like "INSERT INTO t" handled via refTokens; schema-qualified names
    if (tableNames.some((n) => n.toLowerCase() === name)) return
    if (t.value.length >= 4 && TYPO_TARGETS.some((kw) => distance(t.upper, kw) === 1)) return // reported as a typo
    report(t, [...used.flatMap((x) => x.columns.map((c) => c.name))])
  })
}
