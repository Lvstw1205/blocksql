export type TokenType =
  | 'keyword'
  | 'ident'
  | 'quoted'
  | 'string'
  | 'number'
  | 'op'
  | 'punct'
  | 'param'
  | 'comment'
  | 'ws'

export interface Token {
  type: TokenType
  value: string
  upper: string
  start: number
  end: number
  unterminated?: boolean
}

export const KEYWORDS = new Set(
  `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE GLOB BETWEEN EXISTS AS ON JOIN INNER LEFT RIGHT FULL
  OUTER CROSS NATURAL USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH UNION ALL INTERSECT EXCEPT DISTINCT
  INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX DROP ALTER ADD COLUMN TRUNCATE PRIMARY KEY
  FOREIGN REFERENCES UNIQUE DEFAULT CHECK CONSTRAINT CASE WHEN THEN ELSE END ASC DESC WITH RECURSIVE
  RETURNING IF REPLACE BEGIN COMMIT ROLLBACK TRANSACTION PRAGMA EXPLAIN ANALYZE TRUE FALSE CAST OVER
  PARTITION WINDOW DATABASE SCHEMA SHOW DESCRIBE USE GRANT REVOKE TEMP TEMPORARY CONFLICT DO NOTHING
  IGNORE RENAME TO TRIGGER ESCAPE COLLATE NULLS`
    .split(/\s+/)
    .filter(Boolean)
)

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT_PART = /[\w$\u0080-￿]/
const OPS3 = ['->>']
const OPS2 = ['<>', '<=', '>=', '!=', '||', '::', '->', '==']

export function tokenize(sql: string): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  const push = (type: TokenType, start: number, end: number, unterminated = false): void => {
    const value = sql.slice(start, end)
    const tok: Token = { type, value, upper: value.toUpperCase(), start, end }
    if (unterminated) tok.unterminated = true
    out.push(tok)
  }
  const readQuoted = (q: string): [number, boolean] => {
    let j = i + 1
    while (j < n) {
      if (sql[j] === q) {
        if (sql[j + 1] === q) {
          j += 2
          continue
        }
        return [j + 1, true]
      }
      j++
    }
    return [n, false]
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (/\s/.test(c)) {
      let j = i + 1
      while (j < n && /\s/.test(sql[j])) j++
      push('ws', i, j)
      i = j
    } else if (c === '-' && next === '-') {
      let j = sql.indexOf('\n', i)
      if (j < 0) j = n
      push('comment', i, j)
      i = j
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      const j = close < 0 ? n : close + 2
      push('comment', i, j, close < 0)
      i = j
    } else if (c === "'") {
      const [j, closed] = readQuoted("'")
      push('string', i, j, !closed)
      i = j
    } else if (c === '"' || c === '`') {
      const [j, closed] = readQuoted(c)
      push('quoted', i, j, !closed)
      i = j
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const j = close < 0 ? n : close + tag[0].length
        push('string', i, j, close < 0)
        i = j
      } else {
        const m = /^\$\d+/.exec(sql.slice(i))
        const j = i + (m ? m[0].length : 1)
        push(m ? 'param' : 'op', i, j)
        i = j
      }
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i))!
      push('number', i, i + m[0].length)
      i += m[0].length
    } else if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < n && IDENT_PART.test(sql[j])) j++
      const word = sql.slice(i, j).toUpperCase()
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', i, j)
      i = j
    } else if (c === '?') {
      push('param', i, i + 1)
      i++
    } else if ((c === ':' || c === '@') && /[A-Za-z_]/.test(next ?? '') && sql[i - 1] !== ':') {
      let j = i + 1
      while (j < n && IDENT_PART.test(sql[j])) j++
      push('param', i, j)
      i = j
    } else if ('(),;.'.includes(c)) {
      push('punct', i, i + 1)
      i++
    } else {
      const three = sql.slice(i, i + 3)
      const two = sql.slice(i, i + 2)
      const len = OPS3.includes(three) ? 3 : OPS2.includes(two) ? 2 : 1
      push('op', i, i + len)
      i += len
    }
  }
  return out
}

export const significant = (tokens: Token[]): Token[] =>
  tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment')

export interface StatementSpan {
  text: string
  start: number
  end: number
}

/** Split a script on top-level semicolons (keeps trigger bodies and CASE...END intact). */
export function splitStatements(sql: string): StatementSpan[] {
  const tokens = tokenize(sql)
  const spans: StatementSpan[] = []
  let start = 0
  let block = 0
  let isTrigger = false
  let first: string | null = null
  const flush = (end: number): void => {
    const text = sql.slice(start, end)
    if (significant(tokenize(text)).length) {
      const lead = text.length - text.trimStart().length
      spans.push({ text: text.trim(), start: start + lead, end: start + lead + text.trim().length })
    }
  }
  for (const t of tokens) {
    if (t.type === 'ws' || t.type === 'comment') continue
    if (first === null) first = t.upper
    if (first === 'CREATE' && t.upper === 'TRIGGER') isTrigger = true
    if (isTrigger && (t.upper === 'BEGIN' || t.upper === 'CASE')) block++
    if (isTrigger && t.upper === 'END') block = Math.max(0, block - 1)
    if (t.value === ';' && block === 0) {
      flush(t.start)
      start = t.end
      first = null
      isTrigger = false
    }
  }
  flush(sql.length)
  return spans
}
