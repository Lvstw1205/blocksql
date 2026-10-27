import type { TableInfo } from '../types'
import { t } from '../i18n'
import { closest } from './similar'

export interface FriendlyError {
  title: string
  hint?: string
}

type Rule = [RegExp, (m: RegExpExecArray, tables: TableInfo[]) => FriendlyError]

const didYouMean = (word: string, candidates: string[]): string | undefined => {
  const g = closest(word, candidates)
  return g ? t('xDidYouMean', { name: g }) : undefined
}
const columnsOf = (tables: TableInfo[]): string[] => [...new Set(tables.flatMap((x) => x.columns.map((c) => c.name)))]
const lastPart = (s: string): string => s.slice(s.lastIndexOf('.') + 1)

const RULES: Rule[] = [
  [/no such table: (\S+)|relation "([^"]+)" does not exist|Table '([^']+)' doesn't exist/i, (m, tables) => {
    const name = lastPart(m[1] ?? m[2] ?? m[3])
    return { title: t('xNoTable', { name }), hint: didYouMean(name, tables.map((x) => x.name)) }
  }],
  [/no such column: (\S+)|column "?([^"\s]+)"? does not exist|Unknown column '([^']+)'/i, (m, tables) => {
    const name = lastPart(m[1] ?? m[2] ?? m[3])
    return { title: t('xNoColumn', { name }), hint: didYouMean(name, columnsOf(tables)) }
  }],
  [/ambiguous column name: (\S+)|column reference "([^"]+)" is ambiguous|Column '([^']+)' in .* is ambiguous/i, (m) => {
    const name = m[1] ?? m[2] ?? m[3]
    return { title: t('xAmbiguous', { name }), hint: t('xAmbiguousHint', { name }) }
  }],
  [/near "([^"]*)": syntax error|syntax error at or near "([^"]*)"|syntax to use near '([^']*)'/i, (m) => {
    const near = (m[1] ?? m[2] ?? m[3] ?? '').slice(0, 30)
    return { title: near ? t('xSyntaxNear', { near }) : t('xSyntax'), hint: t('xSyntaxHint') }
  }],
  [/incomplete input|syntax error at end of input/i, () => ({ title: t('xIncomplete'), hint: t('xIncompleteHint') })],
  [/UNIQUE constraint failed: (\S+)|duplicate key value violates unique constraint "([^"]+)"|Duplicate entry '([^']*)'/i, (m) => {
    const what = m[1] ?? m[3]
    return { title: t('xUnique'), hint: what ? t('xUniqueHint', { what }) : undefined }
  }],
  [/NOT NULL constraint failed: (\S+)|null value in column "([^"]+)"|Column '([^']+)' cannot be null/i, (m) => ({
    title: t('xNotNull', { name: lastPart(m[1] ?? m[2] ?? m[3]) })
  })],
  [/FOREIGN KEY constraint failed|violates foreign key constraint|foreign key constraint fails/i, () => ({
    title: t('xForeignKey'),
    hint: t('xForeignKeyHint')
  })],
  [/must appear in the GROUP BY clause|isn't in GROUP BY|not in GROUP BY/i, () => ({ title: t('xGroupBy'), hint: t('xGroupByHint') })],
  [/misuse of aggregate|aggregate functions are not allowed in WHERE|Invalid use of group function/i, () => ({
    title: t('xAggWhere'),
    hint: t('xAggWhereHint')
  })],
  [/division by zero/i, () => ({ title: t('xDivZero') })],
  [/invalid input syntax for type (\w+)|datatype mismatch|Incorrect (\w+) value/i, () => ({ title: t('xType'), hint: t('xTypeHint') })],
  [/has (\d+) columns but (\d+) values were supplied|Column count doesn't match/i, () => ({ title: t('xColumnCount') })],
  [/table (\S+) already exists|relation "([^"]+)" already exists|Table '([^']+)' already exists/i, (m) => ({
    title: t('xExists', { name: m[1] ?? m[2] ?? m[3] })
  })],
  [/no such function: (\w+)|function (\w+)\(.*\) does not exist|FUNCTION \S+?\.?(\w+) does not exist/i, (m) => ({
    title: t('xNoFunction', { name: m[1] ?? m[2] ?? m[3] }),
    hint: t('xNoFunctionHint')
  })],
  [/ECONNREFUSED|connect ETIMEDOUT|ENOTFOUND/i, () => ({ title: t('xConnect'), hint: t('xConnectHint') })],
  [/password authentication failed|Access denied for user/i, () => ({ title: t('xAuth') })],
  [/database "([^"]+)" does not exist|Unknown database '([^']+)'/i, (m) => ({ title: t('xNoDatabase', { name: m[1] ?? m[2] }) })],
  [/database is locked/i, () => ({ title: t('xLocked') })],
  [/readonly database|read-only/i, () => ({ title: t('xReadOnly') })]
]

export function friendlyError(message: string, tables: TableInfo[] = []): FriendlyError {
  for (const [re, fn] of RULES) {
    const m = re.exec(message)
    if (m) return fn(m, tables)
  }
  return { title: t('xGeneric') }
}
