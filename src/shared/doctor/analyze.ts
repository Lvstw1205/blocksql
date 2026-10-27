import { significant, tokenize, type Token } from './tokenizer'

export interface TableRef {
  name: string
  alias?: string
  token: Token
}

export interface Clause {
  name: string
  /** keyword tokens that opened the clause, e.g. LEFT OUTER JOIN */
  head: Token[]
  body: Token[]
}

export interface JoinInfo {
  type: string
  table?: TableRef
  condition: Token[]
  hasCondition: boolean
}

export interface Analysis {
  kind: string
  tokens: Token[]
  clauses: Clause[]
  tables: TableRef[]
  /** FROM a, b — comma separated sources */
  commaSources: number
  hasSubquerySource: boolean
  joins: JoinInfo[]
  ctes: string[]
  aliases: Set<string>
  selectItems: Token[][]
}

const SIMPLE_CLAUSES = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'SET', 'VALUES', 'RETURNING',
  'UNION', 'INTERSECT', 'EXCEPT', 'INTO', 'UPDATE', 'FETCH'
])
const JOIN_WORDS = new Set(['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER', 'JOIN'])

export const unquote = (t: Token): string =>
  t.type === 'quoted' ? t.value.slice(1, t.unterminated ? undefined : -1).replace(/""|``/g, (m) => m[0]) : t.value

const isName = (t?: Token): boolean => !!t && (t.type === 'ident' || t.type === 'quoted')

/** Split tokens on commas that are not inside parentheses. */
export function splitTopLevel(tokens: Token[], sep = ','): Token[][] {
  const parts: Token[][] = [[]]
  let depth = 0
  for (const t of tokens) {
    if (t.value === '(') depth++
    if (t.value === ')') depth--
    if (depth === 0 && t.value === sep) parts.push([])
    else parts[parts.length - 1].push(t)
  }
  return parts.filter((p) => p.length)
}

/** Read "schema.table [AS] alias" from the start of a token list. */
function readTableRef(tokens: Token[], columnList = false): { ref?: TableRef; subquery: boolean } {
  if (!tokens.length) return { subquery: false }
  if (tokens[0].value === '(') return { subquery: true }
  if (!isName(tokens[0])) return { subquery: false }
  let name = unquote(tokens[0])
  let k = 1
  while (tokens[k]?.value === '.' && isName(tokens[k + 1])) {
    name += '.' + unquote(tokens[k + 1])
    k += 2
  }
  if (tokens[k]?.value === '(') {
    // INSERT INTO t (a, b) vs. a table-valued function in FROM
    return columnList ? { ref: { name, token: tokens[0] }, subquery: false } : { subquery: false }
  }
  let alias: string | undefined
  if (tokens[k]?.upper === 'AS' && isName(tokens[k + 1])) alias = unquote(tokens[k + 1])
  else if (isName(tokens[k])) alias = unquote(tokens[k])
  return { ref: { name, alias, token: tokens[0] }, subquery: false }
}

export function analyze(sql: string): Analysis {
  let tokens = significant(tokenize(sql))
  const ctes: string[] = []
  const aliases = new Set<string>()

  // WITH name AS (...), name2 AS (...) <main statement>
  let i = 0
  if (tokens[0]?.upper === 'WITH') {
    i = 1
    if (tokens[i]?.upper === 'RECURSIVE') i++
    while (i < tokens.length) {
      if (isName(tokens[i])) ctes.push(unquote(tokens[i]).toLowerCase())
      while (i < tokens.length && tokens[i].value !== '(') i++
      let depth = 0
      for (; i < tokens.length; i++) {
        if (tokens[i].value === '(') depth++
        if (tokens[i].value === ')' && --depth === 0) break
      }
      i++
      if (tokens[i]?.value === ',') i++
      else break
    }
  }
  const all = tokens
  tokens = tokens.slice(i)
  const kind = tokens[0]?.upper ?? ''

  const clauses: Clause[] = []
  let depth = 0
  let current: Clause | null = null
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.value === '(') depth++
    if (t.value === ')') depth--
    if (depth === 0 && t.type === 'keyword') {
      let head: Token[] | null = null
      if ((t.upper === 'GROUP' || t.upper === 'ORDER' || t.upper === 'PARTITION') && tokens[k + 1]?.upper === 'BY') {
        head = [t, tokens[k + 1]]
      } else if (JOIN_WORDS.has(t.upper)) {
        let j = k
        while (j < tokens.length && j < k + 4 && JOIN_WORDS.has(tokens[j].upper) && tokens[j].upper !== 'JOIN') j++
        if (tokens[j]?.upper === 'JOIN') head = tokens.slice(k, j + 1)
      } else if (SIMPLE_CLAUSES.has(t.upper)) {
        // "DELETE FROM", "INSERT INTO": keep the statement verb as its own clause
        head = [t]
      } else if (k === 0) {
        head = [t]
      }
      if (head) {
        const name = head[head.length - 1].upper === 'JOIN' ? 'JOIN' : head.map((h) => h.upper).join(' ')
        current = { name, head, body: [] }
        clauses.push(current)
        k += head.length - 1
        continue
      }
    }
    current?.body.push(t)
  }

  const tables: TableRef[] = []
  const joins: JoinInfo[] = []
  let commaSources = 0
  let hasSubquerySource = false
  for (const c of clauses) {
    if (c.name === 'FROM' || c.name === 'UPDATE' || c.name === 'INTO') {
      const parts = c.name === 'FROM' ? splitTopLevel(c.body) : [c.body]
      if (c.name === 'FROM') commaSources = Math.max(commaSources, parts.length)
      for (const p of parts) {
        const { ref, subquery } = readTableRef(p, c.name === 'INTO')
        if (subquery) hasSubquerySource = true
        if (ref) tables.push(ref)
      }
    } else if (c.name === 'JOIN') {
      const onIdx = c.body.findIndex((t) => t.upper === 'ON' || t.upper === 'USING')
      const refTokens = onIdx < 0 ? c.body : c.body.slice(0, onIdx)
      const { ref, subquery } = readTableRef(refTokens)
      if (subquery) hasSubquerySource = true
      if (ref) tables.push(ref)
      const type = c.head.map((h) => h.upper).join(' ')
      joins.push({
        type,
        table: ref,
        condition: onIdx < 0 ? [] : c.body.slice(onIdx + 1),
        hasCondition: onIdx >= 0 || /CROSS|NATURAL/.test(type)
      })
    }
  }

  for (const t of tables) if (t.alias) aliases.add(t.alias.toLowerCase())
  all.forEach((t, k) => {
    if (t.upper === 'AS' && isName(all[k + 1])) aliases.add(unquote(all[k + 1]).toLowerCase())
  })

  const select = clauses.find((c) => c.name === 'SELECT')
  let selectBody = select?.body ?? []
  if (selectBody[0]?.upper === 'DISTINCT' || selectBody[0]?.upper === 'ALL') selectBody = selectBody.slice(1)
  const selectItems = splitTopLevel(selectBody)
  for (const item of selectItems) {
    // implicit alias: "price * 2 total"
    const last = item[item.length - 1]
    const prev = item[item.length - 2]
    if (item.length > 1 && isName(last) && prev && prev.value !== '.' && (isName(prev) || prev.value === ')' || prev.type === 'number' || prev.type === 'string')) {
      aliases.add(unquote(last).toLowerCase())
    }
  }

  return { kind, tokens: all, clauses, tables, commaSources, hasSubquerySource, joins, ctes, aliases, selectItems }
}

export const clause = (a: Analysis, name: string): Clause | undefined => a.clauses.find((c) => c.name === name)

export const AGGREGATES = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG', 'TOTAL', 'JSON_AGG', 'BOOL_AND', 'BOOL_OR'
])

export const hasAggregate = (tokens: Token[]): boolean =>
  tokens.some((t, k) => AGGREGATES.has(t.upper) && tokens[k + 1]?.value === '(')
